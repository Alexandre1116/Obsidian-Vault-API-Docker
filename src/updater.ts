import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";

const GITHUB_OWNER = "Alexandre1116";
const GITHUB_REPOSITORY = "Obsidian-Vault-API-Docker";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 30 * 1000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  updating: boolean;
}

export interface UpdateResult extends UpdateStatus {
  updated: boolean;
  message: string;
}

interface RemoteVersion {
  version: string;
  tag: string;
}

function parseVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "obsidian-vault-api-docker-updater",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  return await response.json() as T;
}

async function getLatestVersion(): Promise<RemoteVersion> {
  try {
    const release = await githubJson<{ tag_name?: string }>(`${GITHUB_API_BASE}/releases/latest`);
    const version = parseVersion(release.tag_name);
    if (version && release.tag_name) return { version, tag: release.tag_name };
  } catch {
    // Repositories without releases can still publish version tags.
  }

  const tags = await githubJson<Array<{ name?: string }>>(`${GITHUB_API_BASE}/tags?per_page=100`);
  const versions = tags
    .map(tag => ({ version: parseVersion(tag.name), tag: tag.name }))
    .filter((tag): tag is { version: string; tag: string } => Boolean(tag.version && tag.tag));
  if (versions.length === 0) throw new Error("No stable version tags found on GitHub");
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return versions[0];
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore", shell: false });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${COMMAND_TIMEOUT_MS / 60_000} minutes`));
    }, COMMAND_TIMEOUT_MS);

    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function downloadFile(url: string, target: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "obsidian-vault-api-docker-updater" },
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok || !response.body) throw new Error(`Could not download update (HTTP ${response.status})`);

  const file = fs.createWriteStream(target);
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) file.write(chunk);
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve());
      file.once("error", reject);
    });
  }
}

/**
 * Free memory inside the container cgroup. Building an update (npm ci + tsc +
 * sharp) needs a few hundred MB; on a 1 GiB vault box this decides whether the
 * update is safe to attempt at all.
 */
function cgroupHeadroomBytes(): number | null {
  try {
    const maxRaw = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
    const current = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf-8").trim());
    if (!Number.isFinite(current)) return null;
    const max = maxRaw === "max" ? os.totalmem() : Number(maxRaw);
    if (!Number.isFinite(max)) return null;
    return max - current;
  } catch {
    return null;
  }
}

const MIN_BUILD_HEADROOM_BYTES = 256 * 1024 * 1024;

function sha256File(path: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(path));
  return hash.digest("hex");
}

export class UpdateManager {
  private status: UpdateStatus;
  private interval: NodeJS.Timeout | null = null;
  private updatePromise: Promise<UpdateResult> | null = null;

  constructor(
    private readonly currentVersion: string,
    private readonly dataDir: string,
    private readonly getAutoUpdate: () => boolean,
    private readonly onUpdated: () => void,
  ) {
    this.status = {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      lastCheckedAt: null,
      lastError: null,
      updating: false,
    };
  }

  start(): void {
    if (this.interval) return;
    setTimeout(() => this.runAutomaticUpdate(), STARTUP_CHECK_DELAY_MS);
    this.interval = setInterval(() => this.runAutomaticUpdate(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.updating) return this.getStatus();
    try {
      const latest = await getLatestVersion();
      this.status = {
        ...this.status,
        latestVersion: latest.version,
        updateAvailable: compareVersions(latest.version, this.currentVersion) > 0,
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
      };
    } catch (error) {
      this.status = {
        ...this.status,
        lastCheckedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
    return this.getStatus();
  }

  async updateNow(): Promise<UpdateResult> {
    if (this.updatePromise) return this.updatePromise;
    this.updatePromise = this.performUpdate().finally(() => { this.updatePromise = null; });
    return this.updatePromise;
  }

  private async runAutomaticUpdate(): Promise<void> {
    if (!this.getAutoUpdate() || this.updatePromise) return;
    const status = await this.check();
    if (status.updateAvailable) {
      const result = await this.updateNow();
      if (!result.updated) console.error(`[vault-api] Automatic update failed: ${result.message}`);
    }
  }

  private async performUpdate(): Promise<UpdateResult> {
    let tempDir: string | null = null;
    try {
      const status = await this.check();
      if (!status.updateAvailable || !status.latestVersion) {
        return { ...this.getStatus(), updating: false, updated: false, message: "The server is already up to date." };
      }

      this.status = { ...this.status, updating: true, lastError: null };

      const headroom = cgroupHeadroomBytes();
      if (headroom !== null && headroom < MIN_BUILD_HEADROOM_BYTES) {
        throw new Error(
          `Not enough memory to build an update (${Math.round(headroom / 1048576)} MB free, ` +
          `needs ${MIN_BUILD_HEADROOM_BYTES / 1048576} MB). Raise the container/CT memory or update manually.`
        );
      }

      const latest = await getLatestVersion();
      tempDir = fs.mkdtempSync(nodePath.join(this.dataDir, ".update-"));
      const archivePath = nodePath.join(tempDir, "source.tar.gz");
      const sourceDir = nodePath.join(tempDir, "source");
      fs.mkdirSync(sourceDir);
      await downloadFile(`https://codeload.github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/tar.gz/refs/tags/${encodeURIComponent(latest.tag)}`, archivePath);
      console.log(`[vault-api] Update archive sha256: ${sha256File(archivePath)}`);
      await runCommand("tar", ["-xzf", archivePath, "--strip-components=1", "-C", sourceDir], tempDir);

      if (!fs.existsSync(nodePath.join(sourceDir, "package.json"))) throw new Error("Downloaded update is missing package.json");
      const stagedManifest = JSON.parse(fs.readFileSync(nodePath.join(sourceDir, "package.json"), "utf-8")) as { version?: string };
      if (stagedManifest.version !== latest.version) {
        throw new Error(`Downloaded source reports v${stagedManifest.version}, expected v${latest.version}`);
      }
      if (!fs.existsSync(nodePath.join(sourceDir, "package-lock.json")))
        throw new Error("Downloaded update is missing package-lock.json; refusing to install floating dependencies");

      await runCommand("npm", ["ci", "--no-audit", "--no-fund"], sourceDir);
      await runCommand("npm", ["run", "build"], sourceDir);

      const appRoot = nodePath.resolve(__dirname, "..");
      const stagedDist = nodePath.join(sourceDir, "dist");
      if (!fs.existsSync(stagedDist)) throw new Error("Update build did not produce a dist directory");
      if (!fs.existsSync(nodePath.join(stagedDist, "index.js"))) throw new Error("Update build did not produce dist/index.js");
      await runCommand("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], sourceDir);

      const liveDist = nodePath.join(appRoot, "dist");
      const liveModules = nodePath.join(appRoot, "node_modules");
      const liveManifest = nodePath.join(appRoot, "package.json");
      const liveLockfile = nodePath.join(appRoot, "package-lock.json");
      const prevDist = `${liveDist}.prev`;
      const prevModules = `${liveModules}.prev`;
      const prevManifest = `${liveManifest}.prev`;
      const prevLockfile = `${liveLockfile}.prev`;

      const backup = (from: string, to: string) => { if (fs.existsSync(from)) fs.copyFileSync(from, to); };
      const swapDir = (live: string, prev: string, staged: string) => {
        if (fs.existsSync(prev)) fs.rmSync(prev, { recursive: true, force: true });
        if (fs.existsSync(live)) fs.renameSync(live, prev);
        if (fs.existsSync(staged)) fs.cpSync(staged, live, { recursive: true });
      };
      const restore = (prev: string, live: string) => {
        if (!fs.existsSync(prev)) return;
        if (fs.existsSync(live)) fs.rmSync(live, { recursive: true, force: true });
        fs.renameSync(prev, live);
      };
      const dropBackup = (prev: string) => { if (fs.existsSync(prev)) fs.rmSync(prev, { recursive: true, force: true }); };

      backup(liveManifest, prevManifest);
      backup(liveLockfile, prevLockfile);
      swapDir(liveDist, prevDist, stagedDist);
      swapDir(liveModules, prevModules, nodePath.join(sourceDir, "node_modules"));
      fs.copyFileSync(nodePath.join(sourceDir, "package.json"), liveManifest);
      fs.copyFileSync(nodePath.join(sourceDir, "package-lock.json"), liveLockfile);

      // Smoke check before committing to the new build; roll everything back on
      // failure so a bad update can never leave the server down.
      try {
        if (!fs.existsSync(nodePath.join(liveDist, "index.js"))) throw new Error("dist/index.js missing after swap");
        if (!fs.existsSync(nodePath.join(liveModules, "sharp"))) throw new Error("sharp dependency missing after swap");
        if (!fs.existsSync(nodePath.join(liveModules, "@modelcontextprotocol"))) throw new Error("MCP SDK missing after swap");
      } catch (err) {
        restore(prevDist, liveDist);
        restore(prevModules, liveModules);
        if (fs.existsSync(prevManifest)) fs.copyFileSync(prevManifest, liveManifest);
        if (fs.existsSync(prevLockfile)) fs.copyFileSync(prevLockfile, liveLockfile);
        dropBackup(prevDist); dropBackup(prevModules);
        throw err;
      }
      dropBackup(prevDist); dropBackup(prevModules);
      if (fs.existsSync(prevManifest)) fs.rmSync(prevManifest);
      if (fs.existsSync(prevLockfile)) fs.rmSync(prevLockfile);

      this.status = {
        ...this.status,
        currentVersion: latest.version,
        latestVersion: latest.version,
        updateAvailable: false,
        updating: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: null,
      };
      setTimeout(() => this.onUpdated(), 500);
      return { ...this.getStatus(), updated: true, message: `Updated to v${latest.version}. Restarting server...` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { ...this.status, updating: false, lastError: message };
      return { ...this.getStatus(), updated: false, message };
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
