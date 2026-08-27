import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VaultMcpServer } from "./server.js";

function generateKey(): string {
  return crypto.randomBytes(24).toString("hex");
}

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

function getEnvBool(name: string, fallback: boolean): boolean {
  const val = process.env[name];
  if (val === undefined) return fallback;
  return val === "true" || val === "1" || val === "yes";
}

async function main() {
  const vaultPath = getEnv("VAULT_PATH", "/vault");
  const port = getEnvNumber("VAULT_API_PORT", 2768);
  const bindAddress = getEnv("VAULT_API_BIND", "0.0.0.0");
  const allowedCommands = getEnv("VAULT_API_ALLOWED_COMMANDS", "*");

  let apiKey = getEnv("VAULT_API_KEY");
  if (!apiKey) {
    apiKey = generateKey();
    console.log(`[vault-api] No VAULT_API_KEY set — generated: ${apiKey}`);
    console.log("[vault-api] Set VAULT_API_KEY env var to use a fixed key.");
  }

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

  const resolvedVault = path.resolve(vaultPath);
  console.log(`[vault-api] Vault:   ${resolvedVault}`);
  console.log(`[vault-api] Port:    ${port}`);
  console.log(`[vault-api] Bind:    ${bindAddress}`);
  console.log(`[vault-api] API Key: ${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`);
  console.log(`[vault-api] Allowed:  ${allowedCommands}`);

  const server = new VaultMcpServer(
    resolvedVault,
    port,
    apiKey,
    allowedCommands,
    bindAddress
  );

  try {
    await server.start();
    console.log(`[vault-api] MCP server started on ${bindAddress}:${port}`);
    console.log(`[vault-api] SSE URL: http://${bindAddress === "0.0.0.0" ? "localhost" : bindAddress}:${port}/sse?key=${apiKey}`);
  } catch (err) {
    console.error(`[vault-api] Failed to start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    console.log(`[vault-api] Received ${signal}, shutting down...`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(err => {
  console.error("[vault-api] Fatal:", err);
  process.exit(1);
});
