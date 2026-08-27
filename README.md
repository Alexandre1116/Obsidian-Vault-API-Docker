# Obsidian Vault API — Docker

Docker-compatible version of [Obsidian Vault API](https://github.com/Alexandre1116/Obsidian-vault-api). Exposes your Obsidian vault as an MCP server — no Obsidian desktop app required.

The original plugin runs **inside Obsidian** and uses the Obsidian API + Electron's Canvas for image processing. This version runs as a **standalone Node.js process in Docker**, using direct `fs` operations and [`sharp`](https://sharp.pixelplumbing.com/) for image resizing. All MCP tools from the original are preserved.

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
    environment:
      - VAULT_API_KEY=your-secret-key-here
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
  -e VAULT_API_KEY=your-secret-key-here \
  ghcr.io/alexandre1116/obsidian-vault-api-docker:latest
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `VAULT_PATH` | `/vault` | Path to the vault directory inside the container |
| `VAULT_API_PORT` | `2768` | Port to listen on |
| `VAULT_API_BIND` | `0.0.0.0` | Bind address (use `0.0.0.0` for Docker) |
| `VAULT_API_KEY` | *(auto-generated)* | API key for authentication. If empty, one is generated on startup |
| `VAULT_API_ALLOWED_COMMANDS` | `*` | Glob patterns for allowed shell commands (comma-separated). `*` = all |
| `VAULT_API_HOST` | `127.0.0.1:2768` | Host reported in image URLs (set to your external address if behind a proxy) |

## Connecting Your AI Client

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

> Note: Claude Desktop's MCP support uses stdio. For SSE-based servers, use the `bridge.js` approach from the original plugin, or use an MCP client that supports SSE natively (LM Studio, Open WebUI, etc.).

### LM Studio / Open WebUI / Any MCP client with SSE support

Add MCP server URL:

```
http://localhost:2768/sse?key=YOUR_API_KEY
```

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

## Building from Source

```bash
git clone https://github.com/Alexandre1116/obsidian-vault-api-docker
cd obsidian-vault-api-docker
docker compose build
docker compose up -d
```

Or without Docker:

```bash
npm install
npm run build
VAULT_PATH=/path/to/vault VAULT_API_KEY=secret npm start
```

## Health Check

```bash
curl http://localhost:2768/health
```

Returns `{ "status": "ok", "version": "1.0.0" }` publicly. Authenticated requests also return `vault`, `port`, and `sessions`.

## Differences from the Original

| | Original (Obsidian plugin) | Docker version |
|---|---|---|
| **Runtime** | Inside Obsidian desktop app | Standalone Node.js in Docker |
| **File access** | Obsidian Vault API (`app.vault`) | Node.js `fs` |
| **Image resize** | Electron Canvas API | `sharp` (native, no GUI dependency) |
| **File deletion** | System trash (recoverable) | Permanent delete |
| **Bridge.js / Claude config** | Auto-written by plugin | Manual config (see above) |
| **Settings UI** | Obsidian settings tab | Environment variables |
| **Bind address** | `127.0.0.1` only | Configurable (`0.0.0.0` by default) |

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — same as the original project.
