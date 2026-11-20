import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager, maskKey, publicConfig, resolveInitialConfig } from "../src/config.js";

let dataDir = "";

beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-config-")); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

// Node reports a fixed 0o666 for every file on Windows: the mode option and
// chmod are no-ops there because access is controlled by NTFS ACLs. The
// permission assertion is therefore only meaningful on POSIX systems.
const POSIX = process.platform !== "win32";

describe("config storage", () => {
  it("writes a usable key file on every platform", () => {
    const mgr = new ConfigManager(dataDir);
    const key = mgr.get().apiKey;
    expect(key.length).toBeGreaterThanOrEqual(48);
    expect(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8")).toContain(key);
  });

  it.runIf(POSIX)("saves the key file so only the owner can read it", () => {
    new ConfigManager(dataDir);
    const mode = fs.statSync(path.join(dataDir, "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps management authentication on by default", () => {
    const mgr = new ConfigManager(dataDir);
    expect(mgr.get().managementAuth).toBe(true);
  });

  it("keeps a rotated key across reloads", () => {
    const mgr = new ConfigManager(dataDir);
    const rotated = mgr.regenerateApiKey();
    const reloaded = new ConfigManager(dataDir).get();
    expect(reloaded.apiKey).toBe(rotated);
  });
});

describe("config exposed to the browser", () => {
  it("never carries the key", () => {
    const mgr = new ConfigManager(dataDir);
    const cfg = mgr.get();
    const pub = publicConfig(cfg);
    expect((pub as Record<string, unknown>).apiKey).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain(cfg.apiKey);
    expect(pub.apiKeyHint).toBe(maskKey(cfg.apiKey));
    expect(pub.hasApiKey).toBe(true);
    expect(maskKey(cfg.apiKey)).not.toContain(cfg.apiKey.slice(8, -8));
  });

  it("masks short keys entirely", () => {
    expect(maskKey("abc")).toBe("***");
    expect(maskKey("")).toBe("(none)");
  });
});

describe("first-boot environment overrides", () => {
  it("applies env values only when no config exists yet", () => {
    const mgr = new ConfigManager(dataDir);
    const saved = mgr.get();

    const first = resolveInitialConfig(saved, false, {
      port: 3100, bindAddress: "127.0.0.1", apiKey: "key-from-compose",
      allowedCommands: "ls,cat", autoUpdate: "false", managementAuth: "true", vaultName: "vault",
    });
    expect(first.port).toBe(3100);
    expect(first.apiKey).toBe("key-from-compose");
    expect(first.allowedCommands).toBe("ls,cat");

    // After a rotation, a restart with the same compose file must not undo it.
    const rotated = mgr.regenerateApiKey();
    const second = resolveInitialConfig(mgr.get(), true, {
      port: 3100, apiKey: "key-from-compose", vaultName: "vault",
    });
    expect(second.apiKey).toBe(rotated);
    expect(second.apiKey).not.toBe("key-from-compose");
    // Existing settings win over env: the compose file cannot silently revert
    // allowed commands or the port either.
    expect(second.allowedCommands).toBe(saved.allowedCommands);
    expect(second.port).toBe(saved.port);
  });

  it("keeps saved management authentication", () => {
    const mgr = new ConfigManager(dataDir);
    mgr.update({ managementAuth: false });
    const next = resolveInitialConfig(mgr.get(), true, { vaultName: "vault" });
    expect(next.managementAuth).toBe(false);
  });
});
