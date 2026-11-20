# Obsidian Vault API — Docker

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/alexandre1116)


## Which version should I use?

If you are only using the MCP server on your desktop together with Obsidian, use the [Obsidian Vault API](https://github.com/Alexandre1116/Obsidian-vault-api) plugin instead. It runs inside the Obsidian desktop application and is the simpler option for local desktop use.

Use this Docker version, [Obsidian Vault API Docker](https://github.com/Alexandre1116/Obsidian-Vault-API-Docker), when you want the MCP server to run 24/7 on a server, NAS, or other always-on machine without requiring the Obsidian desktop app.

- **Desktop use with Obsidian open:** use [Obsidian Vault API](https://github.com/Alexandre1116/Obsidian-vault-api).
- **24/7 server or NAS deployment:** use this Docker version.

---

Docker-compatible version of [Obsidian Vault API](https://github.com/Alexandre1116/Obsidian-vault-api). Exposes your Obsidian vault as an MCP server — no Obsidian desktop app required. Runs 24/7 on any server or NAS.

The original plugin runs **inside Obsidian** and uses the Obsidian API + Electron's Canvas for image processing. This version runs as a **standalone Node.js process in Docker**, using direct `fs` operations and [`sharp`](https://sharp.pixelplumbing.com/) for image resizing. All 13 MCP tools from the original are preserved.

## Quick Start

### docker-compose (recommended)

```yaml
services:
  vault-api:
    build: .
    container_name: obsidian-vault-api
    restart: unless-stopped
    ports:
      - "2768:2768"
    volumes:
      - /path/to/your/vault:/vault
      - vault-api-data:/data
    environment:
      - VAULT_API_ALLOWED_COMMANDS=pdftotext,pandoc,git,ls,find,grep,stat
    env_file:
      - .env
    mem_limit: 512m

volumes:
  vault-api-data:
```

```bash
cp .env.example .env   # set VAULT_API_KEY, then: chmod 600 .env
docker compose up -d
```

### docker run

```bash
docker run -d \
  --name obsidian-vault-api \
  -p 2768:2768 \
  -v /path/to/your/vault:/vault \
  -v vault-api-data:/data \
  -e VAULT_API_KEY=your-secret-key-here \
  ghcr.io/alexandre1116/obsidian-vault-api-docker:latest
```

## Web UI

After starting the container, open your browser and go to:

```
http://localhost:2768/
```

The dashboard lets you:
- **View server status** (running/stopped, port, vault name)
- **Edit configuration** (port, bind address, allowed commands) — changes are saved to `/data/config.json` and persist across restarts
- **Regenerate API key** — generates a new secret, requires reconnecting clients
- **Automatic updates** — optionally checks GitHub once a day and installs newer stable versions
- **Manual updates** — checks for and installs the latest stable GitHub version from the Updates card
- **Restart / Stop** the MCP server without stopping the container
- **Copy connection info** — SSE URL, Claude Desktop JSON config, API key

The dashboard page itself contains no secret: the server never sends the API key to the browser. Paste the key once per browser session (it is kept in `sessionStorage`) and the dashboard will use it as `X-Api-Key` for the management API. MCP endpoints (`/sse`, `/message`, `/raw`) and all `/api/*` management routes require the API key. Set `VAULT_API_MANAGEMENT_AUTH=false` only if something in front of the container already handles access control.

## Security notes

- The API key grants file access and shell access. Treat it like a password: keep it in `.env` (`chmod 600 .env`), never in the compose file, and rotate it from the dashboard if it leaks.
- The key is not printed in logs, not returned by `GET /api/config`, and `/data/config.json` is saved with mode `0600`.
- Image results give a short-lived signed `/raw` URL (`token=`, 15 minutes) instead of embedding the key, so the credential never enters the model context.
- `VAULT_API_ALLOWED_COMMANDS` defaults to `*` for compatibility. Prefer an explicit allowlist; `run_local_command` runs inside the container with the vault mounted.
- Bind to a trusted interface (`VAULT_API_BIND`), or restrict the port with your firewall. The container drops all capabilities, is read-only and cannot escalate privileges in the shipped compose file.
- `delete_file` and `delete_folder` move content to `.trash/` inside the vault. Set `VAULT_API_TRASH_DIR=` (empty) for permanent deletion.

## Configuration

Configuration is stored in `/data/config.json` and persists across container restarts. Environment variables act as **initial overrides** on first boot — after that, the config file is the source of truth.

| Variable | Default | Description |
|---|---|---|
| `VAULT_PATH` | `/vault` | Path to the vault directory inside the container |
| `DATA_DIR` | `/data` | Path for persistent config file |
| `VAULT_API_PORT` | `2768` | Port to listen on |
| `VAULT_API_BIND` | `0.0.0.0` | Bind address (`0.0.0.0` for Docker / network access) |
| `VAULT_API_KEY` | *(auto-generated)* | API key for MCP authentication. If empty, one is generated and saved |
| `VAULT_API_ALLOWED_COMMANDS` | `*` | Glob patterns for allowed shell commands (comma-separated). `*` = all |
| `VAULT_API_AUTO_UPDATE` | `false` | Enable daily GitHub update checks on first boot. The Web UI setting is saved in `/data/config.json` |
| `VAULT_API_MANAGEMENT_AUTH` | `true` | Require the API key for the dashboard's management API (`/api/*`) |
| `VAULT_API_HOST` | `127.0.0.1:2768` | Host reported in image URLs (set to your external address if behind a proxy) |
| `VAULT_API_TRASH_DIR` | `.trash` | Vault-relative trash for deletions. Empty = permanent delete |
| `VAULT_API_MAX_SCAN_FILE_BYTES` | `2097152` | Largest file `search` will open |
| `VAULT_API_MAX_TEXT_BYTES` | `4194304` | Largest file `read_file` returns as text |
| `VAULT_API_MAX_BINARY_BYTES` | `33554432` | Largest file returned as base64, and largest `write_binary` payload |
| `VAULT_API_MAX_WALK_ENTRIES` | `20000` | Entries one `list_files`/`search` call may visit |
| `VAULT_API_MAX_SCAN_TOTAL_BYTES` | `33554432` | Total bytes one `search` call may read |

These limits exist because vaults are often shared with course media and backups. A single 5 GB `.iso` read as UTF-8 text is enough to have the kernel OOM-kill the process on a small host; the defaults keep one tool call inside a few tens of MB. When a budget stops a scan, the result says `partial: true` and explains why.

Environment variables are **initial defaults only**: once `/data/config.json` exists it wins, so a rotated API key is not overwritten by the compose file on the next restart.

Automatic updates use the latest stable GitHub release, or the newest semantic-version tag when no release is available. The server downloads the source, builds it inside the container, replaces the compiled application, and exits so Docker can restart it. Keep `restart: unless-stopped` enabled for automatic restarts. The updater verifies the downloaded version matches the tag, refuses to build when the container has too little free memory, and rolls `dist/`, `node_modules/` and the manifest back if the new build does not load. In-container updates need `read_only: false`.

## Connecting Your AI Client

### LM Studio / Open WebUI / Any MCP client with SSE support

Add MCP server URL:

```
http://localhost:2768/sse?key=YOUR_API_KEY
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "url": "http://localhost:2768/sse?key=YOUR_API_KEY"
    }
  }
}
```

Or copy the JSON directly from the Web UI dashboard.

### Authentication

Either:
- Query parameter: `?key=YOUR_API_KEY`
- HTTP header: `X-Api-Key: YOUR_API_KEY`

## Available Tools

| Tool | Description |
|---|---|
| `list_files` | List vault files — filter by folder or extension |
| `read_file` | Read text files, view images, get binary data as base64 |
| `write_file` | Create or update a text file |
| `write_binary` | Create or overwrite a binary file from base64 data |
| `append_file` | Append text to an existing file |
| `delete_file` | Delete a file |
| `read_frontmatter` | Read YAML frontmatter as parsed key-value pairs |
| `update_frontmatter` | Set, update, or delete frontmatter fields |
| `create_folder` | Create a new folder |
| `delete_folder` | Delete a folder |
| `rename_folder` | Rename or move a folder |
| `search` | Keyword search across filenames and content |
| `run_local_command` | Run a shell command inside the container, in the vault directory |

## Image Support

Large images are auto-resized using `sharp` (pure Node.js, no Electron):

| File size | Max dimension | Format |
|---|---|---|
| <= 4 MB | Original | As-is |
| 4–20 MB | 1024 px | JPEG 85% |
| 20–100 MB | 800 px | JPEG 85% |
| > 100 MB | 512 px | JPEG 85% |

## NFS / Network Mounts

The server reads files fresh from the filesystem on every tool call — no caching. NFS mounts work in real-time:

```yaml
volumes:
  - nfs-vault:/vault

volumes:
  nfs-vault:
    driver: local
    driver_opts:
      type: nfs
      device: ":/path/on/nfs"
      o: addr=10.0.0.1,nfsvers=4
```

## Health Check

```bash
curl http://localhost:2768/health
```

Returns `{ "status": "ok", "version": "1.1.2" }` publicly. Authenticated requests also return `vault`, `port`, and `sessions`.

## Building from Source

```bash
git clone https://github.com/Alexandre1116/Obsidian-Vault-API-Docker
cd Obsidian-Vault-API-Docker
docker compose build
docker compose up -d
```

Or without Docker:

```bash
npm install
npm run build
VAULT_PATH=/path/to/vault VAULT_API_KEY=secret npm start
```

## Differences from the Original Plugin

| | Original (Obsidian plugin) | Docker version |
|---|---|---|
| **Runtime** | Inside Obsidian desktop app | Standalone Node.js in Docker |
| **File access** | Obsidian Vault API (`app.vault`) | Node.js `fs` |
| **Image resize** | Electron Canvas API | `sharp` (native, no GUI dependency) |
| **File deletion** | System trash (recoverable) | `.trash/` inside the vault (recoverable; configurable) |
| **Settings UI** | Obsidian settings tab | Web UI at `http://host:2768/` |
| **Config storage** | Obsidian plugin data | `/data/config.json` (Docker volume) |
| **Bind address** | `127.0.0.1` only | Configurable (`0.0.0.0` by default) |
| **Bridge.js / Claude config** | Auto-written by plugin | Copy from Web UI |

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — same as the original project.
