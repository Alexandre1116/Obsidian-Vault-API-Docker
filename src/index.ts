import * as fs from "node:fs";
import * as path from "node:path";
import { VaultMcpServer, type ServerCallbacks } from "./server.js";
import { ConfigManager, maskKey, publicConfig, resolveInitialConfig } from "./config.js";
import { APP_VERSION } from "./version.js";
import { UpdateManager } from "./updater.js";

function getEnv(name: string, fallback?: string): string {
  const val = process.env[name];
  if (val !== undefined && val !== "") return val;
  if (fallback !== undefined) return fallback;
  return "";
}

function getEnvNumber(name: string, fallback: number): number {
  const val = process.env[name];
  if (val !== undefined && val !== "") {
    const n = Number(val);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    console.warn(`[vault-api] Invalid ${name}=${val}, falling back to ${fallback}`);
  }
  return fallback;
}

/**
 * The vault is usually an NFS or CIFS mountpoint handed to the container.
 * After a host reboot the container can start before the mount is ready, and
 * exiting here just produces a crash loop. Wait for it instead.
 */
async function waitForVault(vaultPath: string, attempts = 12, delayMs = 5_000): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const stat = fs.statSync(vaultPath);
      if (stat.isDirectory()) {
        // A mountpoint that exists but is not mounted looks like an empty dir.
        if (attempt === 1 || fs.readdirSync(vaultPath).length > 0) return true;
      }
    } catch { /* not there yet */ }
    if (attempt < attempts) {
      console.warn(`[vault-api] Vault '${vaultPath}' not ready (attempt ${attempt}/${attempts}), retrying in ${delayMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function main() {
  const vaultPath = getEnv("VAULT_PATH", "/vault");
  const dataDir = getEnv("DATA_DIR", "/data");
  const envPort = getEnvNumber("VAULT_API_PORT", 0);
  const envBind = getEnv("VAULT_API_BIND", "");
  const envKey = getEnv("VAULT_API_KEY");
  const envAllowed = getEnv("VAULT_API_ALLOWED_COMMANDS", "");
  const envAutoUpdate = getEnv("VAULT_API_AUTO_UPDATE", "");

  if (!await waitForVault(vaultPath)) {
    console.error(`[vault-api] ERROR: Vault path '${vaultPath}' does not exist or is empty.`);
    console.error("[vault-api] Mount your vault as a volume, e.g.: -v /path/to/vault:/vault");
    process.exit(1);
  }

  const resolvedVault = path.resolve(vaultPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Must be read before ConfigManager runs, because the first load() creates
  // and saves config.json when it is missing.
  const hasSavedConfig = fs.existsSync(path.join(dataDir, "config.json"));
  const configMgr = new ConfigManager(dataDir);
  const currentCfg = configMgr.get();

  // Environment variables are initial defaults only; config.json is the source
  // of truth after the first boot.
  const initialConfig = resolveInitialConfig(currentCfg, hasSavedConfig, {
    port: envPort,
    bindAddress: envBind,
    apiKey: envKey,
    allowedCommands: envAllowed,
    autoUpdate: envAutoUpdate,
    managementAuth: getEnv("VAULT_API_MANAGEMENT_AUTH", "true"),
    vaultName: path.basename(resolvedVault),
  });
  configMgr.update(initialConfig);
  if (!hasSavedConfig && envKey) {
    console.log("[vault-api] API key taken from VAULT_API_KEY (first boot). Later boots use /data/config.json.");
  }

  let server: VaultMcpServer | null = null;
  let updater: UpdateManager;

  const callbacks: ServerCallbacks = {
    getConfig: () => configMgr.get(),
    updateConfig: (partial) => configMgr.update(partial),
    regenerateApiKey: () => configMgr.regenerateApiKey(),
    restartMcp: async () => {
      if (!server) return false;
      await server.stopMcp();
      server.setConfig(configMgr.get());
      await server.startMcp();
      return true;
    },
    stopMcp: async () => {
      if (!server) return false;
      await server.stopMcp();
      return true;
    },
    isMcpRunning: () => server?.running ?? false,
    getMcpPort: () => configMgr.get().port,
    getUpdateStatus: () => updater.getStatus(),
    checkForUpdate: () => updater.check(),
    updateNow: () => updater.updateNow(),
  };

  const cfg = configMgr.get();
  server = new VaultMcpServer(resolvedVault, cfg, callbacks);
  updater = new UpdateManager(APP_VERSION, dataDir, () => configMgr.get().autoUpdate, () => {
    console.log("[vault-api] Update installed. Restarting process...");
    process.exit(0);
  });

  console.log(`[vault-api] Vault:    ${resolvedVault}`);
  console.log(`[vault-api] Data dir: ${dataDir}`);
  console.log(`[vault-api] Port:     ${cfg.port}`);
  console.log(`[vault-api] Bind:     ${cfg.bindAddress}`);
  console.log(`[vault-api] API Key:  ${maskKey(cfg.apiKey)} (value is never logged)`);
  console.log(`[vault-api] Allowed:  ${cfg.allowedCommands}`);
  console.log(`[vault-api] UI auth:  ${cfg.managementAuth ? "required" : "DISABLED"}`);
  console.log(`[vault-api] Version:  ${APP_VERSION}`);

  if (cfg.allowedCommands === "*") {
    console.warn("[vault-api] WARNING: VAULT_API_ALLOWED_COMMANDS=* allows arbitrary shell commands. Prefer an explicit allowlist.");
  }
  if (!cfg.managementAuth) {
    console.warn("[vault-api] WARNING: management routes are unauthenticated. Anyone reaching this port can read the config and restart the server.");
  }

  try {
    await server.startHttp();
    console.log(`[vault-api] HTTP server started on ${cfg.bindAddress}:${cfg.port}`);
    console.log(`[vault-api] Web UI:  http://${cfg.bindAddress === "0.0.0.0" ? "localhost" : cfg.bindAddress}:${cfg.port}/`);

    await server.startMcp();
    console.log(`[vault-api] MCP ready. Connect with: http://<host>:${cfg.port}/sse  (X-Api-Key header or ?key=)`);
    console.log(`[vault-api] Client config (copy from the web UI, or use the key from your secret store):`);
    console.log(JSON.stringify(publicConfig(cfg), null, 2));
    updater.start();
  } catch (err) {
    console.error(`[vault-api] Failed to start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    console.log(`[vault-api] Received ${signal}, shutting down...`);
    if (server) {
      await server.stopMcp();
      await server.stopHttp();
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", reason => {
    console.error("[vault-api] Unhandled rejection:", reason instanceof Error ? reason.stack : reason);
  });
}

main().catch(err => {
  console.error("[vault-api] Fatal:", err);
  process.exit(1);
});
