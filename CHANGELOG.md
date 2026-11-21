# Changelog

## v1.2.0

### Stability
- `search` no longer reads every non-binary file into memory. Walks and reads are
  asynchronous, streamed line by line, and bounded by per-file, per-call and
  wall-clock budgets. A vault that contains media (`.iso`, videos, OpenDocument
  files) no longer OOM-kills the container.
- `list_files`, `read_file`, `write_file` and friends are fully async, so the
  25 s tool timeout can actually fire and the SSE keepalive keeps running.
- Directory walks skip metadata (`@eaDir`, `#recycle`, `.obsidian`, `.git`) and
  report how much was skipped.
- `search` and `list_files` return `partial`/`truncated` when a budget stopped
  them, instead of presenting an incomplete answer as complete.
- `/raw` streams the file instead of buffering it.
- The server waits for the vault mount instead of crash-looping when an NFS or
  CIFS mountpoint is not ready at container start.
- In-container auto-update now uses `npm ci`, verifies the downloaded version,
  checks the cgroup memory headroom, keeps a `.prev` copy and rolls back if the
  new build does not load.
- `HEALTHCHECK` added to the image.

### Security
- `/api/*` management routes require the API key. `GET /api/config` no longer
  returns the key, and the dashboard no longer embeds it in the HTML.
- The API key is no longer printed in logs, and `/data/config.json` is saved
  `0600`.
- Environment variables are initial defaults only: a rotated key is no longer
  reverted by the compose file on restart.
- Image responses expose a short-lived signed `/raw` token instead of the API
  key in a URL.
- Path handling rejects NUL bytes and refuses symlinks that resolve outside the
  vault.
- `read_file` enforces its limits while reading instead of trusting an earlier
  `stat`. Text, SVG and binary payloads are opened, sized with `fstat` on that
  handle, and read in 64 KB chunks up to the limit, so a file that grew after it
  was listed (Synology indexing, a desktop Obsidian saving the same note, a
  cloud placeholder finishing its download) is refused by its real size rather
  than allocated in full.
- `write_binary` validates the payload before decoding it: base64 alphabet, no
  whitespace or line breaks, length a multiple of four, at most two padding
  characters, and the decoded length must match the declared size.
  `Buffer.from(text, "base64")` silently drops invalid characters, so an
  unvalidated payload could decode far above the limit or be written as garbage.
- `run_local_command` no longer uses a shell. The command is tokenized and
  started with `execFile`, so `;`, `&&`, `||`, `|`, `&`, backticks, `$`, `<` and
  `>` are literal characters that cannot start a second program, and quoting
  cannot make the allowlist check disagree with what executes. Quoting (`'…'`,
  `"…"`, `\`) is defined by the server so paths containing spaces keep working;
  an unterminated quote is an error. With a list configured, arguments must stay
  inside the vault (no absolute paths, `~`, drive paths or `..`) and
  self-executing flags (`-exec`, `-execdir`, `-ok`, `-delete`, `-fprint`,
  `-fls`) are rejected. The child gets a minimal environment, so `VAULT_API_KEY`
  is never inherited. The README states plainly that the allowlist is not a
  sandbox: an allowlisted program keeps its own capabilities (`grep -f`,
  `python -c`, Pandoc filters, `git -c`), and `*` means no restriction at all.
- A `run_local_command` call whose program exits non-zero, is killed, times out
  or cannot be started is returned with `isError: true`. The output is still
  included; clients no longer have to parse the text to learn it failed.
- CI runs the suite on Linux and Windows; the `0600` config-file assertion is
  skipped on Windows because the mode is a no-op there.

### Behaviour changes
- `delete_file` and `delete_folder` move content to `.trash/` inside the vault
  (set `VAULT_API_TRASH_DIR=` to restore permanent deletion).
- `append_file` appends instead of rewriting the whole file.
- `update_frontmatter` edits only the keys you change; comments, lists and
  nested values in the rest of the block are preserved.
- `read_file` enforces size limits and explains how to read large files.
- **Allowlist entries must now match the whole command.** `VAULT_API_ALLOWED_COMMANDS=ls`
  allows `ls` with no arguments; write `ls *` for arguments, or an exact command
  such as `pdftotext -layout notes/*.pdf`. The shipped example in
  `docker-compose.yml`, `.env.example` and the README uses the pinned form
  (`ls *,stat *,grep *,wc *,head *,tail *,pdftotext *`).
- **Shell syntax in `run_local_command` no longer works.** Chaining, pipes,
  redirection and substitution are literal characters now. A client that used
  `cmd1 && cmd2` must run the two calls itself, or keep
  `VAULT_API_ALLOWED_COMMANDS=*` and invoke `bash -c "…"` explicitly — which is
  unrestricted on purpose, so it is a deployment decision, not a default.
- A failed `run_local_command` (non-zero exit, signal, timeout, program not
  found) now sets `isError: true` on the MCP result.
- `/message` accepts the session opened by an authenticated `GET /sse`, so
  clients that authenticate only in the SSE URL (LM Studio, Open WebUI, Claude
  Desktop) work again.

### Tooling
- Vitest suite added (policy, frontmatter, path containment, config).
- GitHub Actions CI added for Linux and Windows on Node 20 and 22.
