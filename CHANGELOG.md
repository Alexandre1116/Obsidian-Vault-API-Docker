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
- CI runs the suite on Linux and Windows; the `0600` config-file assertion is
  skipped on Windows because the mode is a no-op there.

### Behaviour changes
- `delete_file` and `delete_folder` move content to `.trash/` inside the vault
  (set `VAULT_API_TRASH_DIR=` to restore permanent deletion).
- `append_file` appends instead of rewriting the whole file.
- `update_frontmatter` edits only the keys you change; comments, lists and
  nested values in the rest of the block are preserved.
- `read_file` enforces size limits and explains how to read large files.
- `/message` accepts the session opened by an authenticated `GET /sse`, so
  clients that authenticate only in the SSE URL (LM Studio, Open WebUI, Claude
  Desktop) work again.

### Tooling
- Vitest suite added (policy, frontmatter, path containment, config).
- GitHub Actions CI added for Linux and Windows on Node 20 and 22.
