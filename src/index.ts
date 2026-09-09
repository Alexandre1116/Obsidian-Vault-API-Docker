import * as fs from "node:fs";
import * as path from "node:path";
import { VaultMcpServer, type ServerCallbacks } from "./server.js";
import { ConfigManager } from "./config.js";
import type { Config } from "./config.js";

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

async function main() {
  const vaultPath = getEnv("VAULT_PATH", "/vault");
  const dataDir = getEnv("DATA_DIR", "/data");
  const envPort = getEnvNumber("VAULT_API_PORT", 0);
  const envBind = getEnv("VAULT_API_BIND", "");
  const envKey = getEnv("VAULT_API_KEY");
  const envAllowed = getEnv("VAULT_API_ALLOWED_COMMANDS", "");

  if (!fs.existsSync(vaultPath)) {
    console.error(`[vault-api] ERROR: Vault path '${vaultPath}' does not exist.`);
    console.error("[vault-api] Mount your vault as a volume, e.g.: -v /path/to/vault:/vault");
    process.exit(1);
  }

  const stat = fs.statSync(vaultPath);
  if (!stat.isDirectory()) {
    console.error(`[vault-api] ERROR: Vault path '${vaultPath}' is not a directory.`);
    process.exit(1);
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const resolvedVault = path.resolve(vaultPath);
  const configMgr = new ConfigManager(dataDir);

  // Apply env var overrides (env takes priority over saved config on first boot,
  // but config.json is the source of truth after that)
  const currentCfg = configMgr.get();
  const initialConfig: Config = {
    port: envPort || currentCfg.port || 2768,
    bindAddress: envBind || currentCfg.bindAddress || "0.0.0.0",
    apiKey: envKey || currentCfg.apiKey,
    allowedCommands: envAllowed || currentCfg.allowedCommands || "*",
    vaultName: path.basename(resolvedVault),
  };
  configMgr.update(initialConfig);

  let server: VaultMcpServer | null = null;

  const callbacks: ServerCallbacks = {
    getConfig: () => configMgr.get(),
    updateConfig: (partial) => {
      const updated = configMgr.update(partial);
      return updated;
    },
    regenerateApiKey: () => {
      const newKey = configMgr.regenerateApiKey();
      return newKey;
    },
    restartMcp: async () => {
      if (!server) return false;
      await server.stopMcp();
      const cfg = configMgr.get();
      server["config"] = cfg;
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
  };

  const cfg = configMgr.get();
  server = new VaultMcpServer(resolvedVault, cfg, callbacks);

  console.log(`[vault-api] Vault:    ${resolvedVault}`);
  console.log(`[vault-api] Data dir: ${dataDir}`);
  console.log(`[vault-api] Port:     ${cfg.port}`);
  console.log(`[vault-api] Bind:     ${cfg.bindAddress}`);
  console.log(`[vault-api] API Key:  ${cfg.apiKey.substring(0, 8)}...${cfg.apiKey.substring(cfg.apiKey.length - 4)}`);
  console.log(`[vault-api] Allowed:  ${cfg.allowedCommands}`);

  try {
    await server.startHttp();
    console.log(`[vault-api] HTTP server started on ${cfg.bindAddress}:${cfg.port}`);
    console.log(`[vault-api] Web UI:  http://${cfg.bindAddress === "0.0.0.0" ? "localhost" : cfg.bindAddress}:${cfg.port}/`);

    await server.startMcp();
    console.log(`[vault-api] SSE URL: http://${cfg.bindAddress === "0.0.0.0" ? "localhost" : cfg.bindAddress}:${cfg.port}/sse?key=${cfg.apiKey}`);
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
}

main().catch(err => {
  console.error("[vault-api] Fatal:", err);
  process.exit(1);
});
