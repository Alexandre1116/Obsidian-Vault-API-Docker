export function getDashboardHtml(port: number, apiKey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vault API - Dashboard</title>
<style>
  :root {
    --bg: #0f0f0f;
    --surface: #1a1a1a;
    --surface2: #242424;
    --border: #333;
    --text: #e0e0e0;
    --text-dim: #888;
    --accent: #7c3aed;
    --accent-hover: #6d28d9;
    --green: #22c55e;
    --red: #ef4444;
    --orange: #f59e0b;
    --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 24px;
  }
  .container { max-width: 720px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 32px; }
  header h1 { font-size: 1.6rem; font-weight: 700; }
  header p { color: var(--text-dim); margin-top: 4px; font-size: 0.9rem; }
  .status-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border-radius: 20px;
    font-size: 0.8rem; font-weight: 600;
    margin-top: 12px;
  }
  .status-badge.running { background: rgba(34,197,94,.15); color: var(--green); }
  .status-badge.stopped { background: rgba(239,68,68,.15); color: var(--red); }
  .status-badge .dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-badge.running .dot { background: var(--green); }
  .status-badge.stopped .dot { background: var(--red); }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); margin-bottom: 16px; }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  .field label { display: block; font-size: 0.8rem; color: var(--text-dim); margin-bottom: 4px; }
  .field input {
    width: 100%; padding: 10px 12px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text);
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem;
  }
  .field input:focus { outline: none; border-color: var(--accent); }
  .field input:read-only { opacity: 0.6; }
  .field .hint { font-size: 0.75rem; color: var(--text-dim); margin-top: 4px; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn {
    padding: 10px 20px; border: none; border-radius: 6px;
    font-size: 0.85rem; font-weight: 600; cursor: pointer;
    transition: background .15s;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-warning { background: var(--orange); color: #000; }
  .btn-warning:hover { opacity: .85; }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-danger:hover { opacity: .85; }
  .btn-ghost { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
  .btn-ghost:hover { background: var(--border); }
  .info-box {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; padding: 14px; margin-top: 16px;
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem;
    word-break: break-all; line-height: 1.6;
  }
  .info-box .label { color: var(--text-dim); }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    padding: 12px 20px; border-radius: 8px;
    font-size: 0.85rem; font-weight: 600;
    transform: translateY(100px); opacity: 0;
    transition: all .25s; z-index: 9999;
  }
  .toast.show { transform: translateY(0); opacity: 1; }
  .toast.success { background: var(--green); color: #000; }
  .toast.error { background: var(--red); color: #fff; }
  .conn-section { margin-top: 8px; }
  .conn-section .client {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 0; border-bottom: 1px solid var(--border);
  }
  .conn-section .client:last-child { border-bottom: none; }
  .conn-section .client .name { font-weight: 600; font-size: 0.85rem; }
  .conn-section .client .desc { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
  .conn-section .client code {
    font-size: 0.75rem; color: var(--accent);
    background: var(--surface2); padding: 4px 8px; border-radius: 4px;
    cursor: pointer;
  }
  footer { text-align: center; margin-top: 24px; color: var(--text-dim); font-size: 0.75rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Vault API - Docker</h1>
    <p>MCP Server for Obsidian Vaults</p>
    <div id="statusBadge" class="status-badge stopped">
      <span class="dot"></span>
      <span id="statusText">Checking...</span>
    </div>
  </header>

  <div class="card">
    <h2>Configuration</h2>
    <div class="field">
      <label>Port</label>
      <input type="number" id="port" min="1" max="65535" value="${port}">
    </div>
    <div class="field">
      <label>Bind Address</label>
      <input type="text" id="bindAddress" value="0.0.0.0">
      <div class="hint">Use 0.0.0.0 for local network access, 127.0.0.1 for localhost only</div>
    </div>
    <div class="field">
      <label>Allowed Commands</label>
      <input type="text" id="allowedCommands" value="*">
      <div class="hint">Glob patterns for run_local_command, comma-separated. Use * for all</div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveConfig()">Save & Restart</button>
      <button class="btn btn-ghost" onclick="loadConfig()">Reload</button>
    </div>
  </div>

  <div class="card">
    <h2>API Key</h2>
    <div class="field">
      <label>Current Key</label>
      <input type="text" id="apiKey" value="${apiKey}" readonly>
    </div>
    <div class="btn-row">
      <button class="btn btn-warning" onclick="regenerateKey()">Regenerate Key</button>
      <button class="btn btn-ghost" onclick="copyKey()">Copy</button>
    </div>
  </div>

  <div class="card">
    <h2>Connection Info</h2>
    <div class="info-box">
      <div><span class="label">SSE URL:</span> <span id="sseUrl"></span></div>
      <div><span class="label">Health:</span> <span id="healthUrl"></span></div>
    </div>
    <div class="conn-section">
      <div class="client">
        <div>
          <div class="name">LM Studio / Open WebUI</div>
          <div class="desc">Add MCP server with this URL</div>
        </div>
        <code onclick="copyText('sseUrlText')">Copy URL</code>
      </div>
      <div class="client">
        <div>
          <div class="name">Claude Desktop</div>
          <div class="desc">Add to claude_desktop_config.json</div>
        </div>
        <code onclick="copyClaudeConfig()">Copy JSON</code>
      </div>
      <div class="client">
        <div>
          <div class="name">HTTP Auth</div>
          <div class="desc">Header: X-Api-Key or query: ?key=...</div>
        </div>
        <code onclick="copyKey()">Copy Key</code>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Server Control</h2>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="restartServer()">Restart Server</button>
      <button class="btn btn-danger" onclick="stopServer()">Stop Server</button>
    </div>
  </div>

  <footer>
    <p>Vault API Docker v1.1.0 &mdash; <a href="https://github.com/Alexandre1116/Obsidian-Vault-API-Docker" target="_blank">GitHub</a></p>
  </footer>
</div>

<div id="toast" class="toast"></div>

<script>
const INITIAL_PORT = ${port};
const INITIAL_KEY = "${apiKey}";

function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (type || 'success') + ' show';
  setTimeout(() => el.classList.remove('show'), 2500);
}

function updateUrls(port, key) {
  const host = location.hostname;
  const base = 'http://' + host + ':' + port;
  document.getElementById('sseUrl').textContent = base + '/sse?key=' + key;
  document.getElementById('healthUrl').textContent = base + '/health';
  document.getElementById('apiKey').value = key;
  document.getElementById('port').value = port;
}
window.sseUrlText = 'http://' + location.hostname + ':' + INITIAL_PORT + '/sse?key=' + INITIAL_KEY;
window.claudeConfig = JSON.stringify({
  mcpServers: {
    obsidian: { url: 'http://localhost:' + INITIAL_PORT + '/sse?key=' + INITIAL_KEY }
  }
}, null, 2);

function copyText(id) {
  const text = window[id] || document.getElementById(id).textContent;
  navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
}

function copyKey() {
  const key = document.getElementById('apiKey').value;
  navigator.clipboard.writeText(key).then(() => showToast('API key copied!'));
}

function copyClaudeConfig() {
  const port = document.getElementById('port').value;
  const key = document.getElementById('apiKey').value;
  const cfg = JSON.stringify({
    mcpServers: {
      obsidian: { url: 'http://localhost:' + port + '/sse?key=' + key }
    }
  }, null, 2);
  navigator.clipboard.writeText(cfg).then(() => showToast('Claude config copied!'));
}

async function loadConfig() {
  try {
    const resp = await fetch('/api/config');
    const cfg = await resp.json();
    document.getElementById('port').value = cfg.port;
    document.getElementById('bindAddress').value = cfg.bindAddress;
    document.getElementById('allowedCommands').value = cfg.allowedCommands;
    document.getElementById('apiKey').value = cfg.apiKey;
    updateUrls(cfg.port, cfg.apiKey);
    window.sseUrlText = 'http://' + location.hostname + ':' + cfg.port + '/sse?key=' + cfg.apiKey;
  } catch (e) {
    showToast('Failed to load config', 'error');
  }
}

async function saveConfig() {
  const cfg = {
    port: parseInt(document.getElementById('port').value),
    bindAddress: document.getElementById('bindAddress').value,
    allowedCommands: document.getElementById('allowedCommands').value,
  };
  try {
    const resp = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    const result = await resp.json();
    if (result.ok) {
      showToast('Saved! Restarting server...');
      setTimeout(() => loadStatus(), 1500);
    } else {
      showToast('Save failed: ' + (result.error || 'unknown'), 'error');
    }
  } catch (e) {
    showToast('Save failed', 'error');
  }
}

async function regenerateKey() {
  if (!confirm('Regenerate API key? All connected clients will need to reconnect.')) return;
  try {
    const resp = await fetch('/api/key/regenerate', { method: 'POST' });
    const result = await resp.json();
    if (result.apiKey) {
      document.getElementById('apiKey').value = result.apiKey;
      updateUrls(parseInt(document.getElementById('port').value), result.apiKey);
      showToast('Key regenerated! Update your clients.');
    }
  } catch (e) {
    showToast('Failed to regenerate key', 'error');
  }
}

async function restartServer() {
  try {
    const resp = await fetch('/api/server/restart', { method: 'POST' });
    const result = await resp.json();
    if (result.ok) {
      showToast('Server restarting...');
      setTimeout(() => loadStatus(), 2000);
    } else {
      showToast('Restart failed', 'error');
    }
  } catch (e) {
    showToast('Restart failed', 'error');
  }
}

async function stopServer() {
  if (!confirm('Stop the MCP server? The web UI will remain active.')) return;
  try {
    const resp = await fetch('/api/server/stop', { method: 'POST' });
    const result = await resp.json();
    if (result.ok) {
      showToast('Server stopped');
      loadStatus();
    }
  } catch (e) {
    showToast('Stop failed', 'error');
  }
}

async function loadStatus() {
  try {
    const resp = await fetch('/api/status');
    const status = await resp.json();
    const badge = document.getElementById('statusBadge');
    const text = document.getElementById('statusText');
    if (status.running) {
      badge.className = 'status-badge running';
      text.textContent = 'Running on port ' + status.port;
    } else {
      badge.className = 'status-badge stopped';
      text.textContent = 'Stopped';
    }
  } catch {
    document.getElementById('statusBadge').className = 'status-badge stopped';
    document.getElementById('statusText').textContent = 'Offline';
  }
}

loadStatus();
loadConfig();
</script>
</body>
</html>`;
}
