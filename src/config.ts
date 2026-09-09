import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";

export interface Config {
  port: number;
  bindAddress: string;
  apiKey: string;
  allowedCommands: string;
  vaultName: string;
}

const DEFAULTS: Config = {
  port: 2768,
  bindAddress: "0.0.0.0",
  apiKey: "",
  allowedCommands: "*",
  vaultName: "",
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
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
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
