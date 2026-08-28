# Obsidian Vault API — Docker


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
      - VAULT_API_KEY=your-secret-key-here

volumes:
  vault-api-data:
```

```bash
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
- **Restart / Stop** the MCP server without stopping the container
- **Copy connection info** — SSE URL, Claude Desktop JSON config, API key

The web UI itself does not require authentication (it's the config page). The MCP endpoints (`/sse`, `/message`, `/raw`) require the API key.

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
| `VAULT_API_HOST` | `127.0.0.1:2768` | Host reported in image URLs (set to your external address if behind a proxy) |

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

Returns `{ "status": "ok", "version": "1.1.0" }` publicly. Authenticated requests also return `vault`, `port`, and `sessions`.

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
| **File deletion** | System trash (recoverable) | Permanent delete |
| **Settings UI** | Obsidian settings tab | Web UI at `http://host:2768/` |
| **Config storage** | Obsidian plugin data | `/data/config.json` (Docker volume) |
| **Bind address** | `127.0.0.1` only | Configurable (`0.0.0.0` by default) |
| **Bridge.js / Claude config** | Auto-written by plugin | Copy from Web UI |

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — same as the original project.
