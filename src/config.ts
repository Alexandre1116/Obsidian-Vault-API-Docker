import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";

export interface Config {
  port: number;
  bindAddress: string;
  apiKey: string;
  allowedCommands: string;
  vaultName: string;
  autoUpdate: boolean;
  /** When true, the dashboard and /api/* management routes require the API key. */
  managementAuth: boolean;
}

const DEFAULTS: Config = {
  port: 2768,
  bindAddress: "0.0.0.0",
  apiKey: "",
  allowedCommands: "*",
  vaultName: "",
  autoUpdate: false,
  managementAuth: true,
};

export class ConfigManager {
  private configPath: string;
  private config: Config = { ...DEFAULTS };

  constructor(dataDir: string) {
    this.configPath = nodePath.join(dataDir, "config.json");
    this.load();
  }

  load(): Config {
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      this.config = { ...DEFAULTS, ...parsed };
    } catch {
      this.config = { ...DEFAULTS };
    }

    if (!this.config.apiKey) {
      this.config.apiKey = crypto.randomBytes(24).toString("hex");
      this.save();
    }

    return { ...this.config };
  }

  save(): void {
    const dir = nodePath.dirname(this.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // The file holds the API key, so it must not be world readable. On Windows
    // the mode is a no-op and the file inherits its NTFS ACL.
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(this.configPath, 0o600); } catch { /* non-POSIX filesystem */ }
  }

  get(): Config {
    return { ...this.config };
  }

  update(partial: Partial<Config>): Config {
    this.config = { ...this.config, ...partial };
    this.save();
    return { ...this.config };
  }

  regenerateApiKey(): string {
    this.config.apiKey = crypto.randomBytes(24).toString("hex");
    this.save();
    return this.config.apiKey;
  }
}

/** Short, non-reversible form for logs and status output. */
export function maskKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Shape safe to send to the browser: never carries the key itself. */
export function publicConfig(cfg: Config): Omit<Config, "apiKey"> & { apiKeyHint: string; hasApiKey: boolean } {
  const { apiKey, ...rest } = cfg;
  return { ...rest, apiKeyHint: maskKey(apiKey), hasApiKey: Boolean(apiKey) };
}

export interface EnvOverrides {
  port?: number;
  bindAddress?: string;
  apiKey?: string;
  allowedCommands?: string;
  autoUpdate?: string;
  managementAuth?: string;
  vaultName: string;
}

/**
 * Environment variables are initial defaults only. Once config.json exists it
 * wins, otherwise a rotated API key would be overwritten by the compose file
 * on every container restart.
 */
export function resolveInitialConfig(saved: Config, hasSavedConfig: boolean, env: EnvOverrides): Config {
  if (hasSavedConfig) {
    return {
      ...saved,
      vaultName: env.vaultName,
      autoUpdate: saved.autoUpdate,
    };
  }
  return {
    port: env.port && env.port > 0 ? env.port : 2768,
    bindAddress: env.bindAddress || "0.0.0.0",
    apiKey: env.apiKey || saved.apiKey,
    allowedCommands: env.allowedCommands || "*",
    vaultName: env.vaultName,
    autoUpdate: (env.autoUpdate ?? "").toLowerCase() === "true",
    managementAuth: (env.managementAuth ?? "true").toLowerCase() !== "false",
  };
}
