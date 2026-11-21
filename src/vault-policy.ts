import * as crypto from "node:crypto";
import * as nodePath from "node:path";

/**
 * Scan and size policy for vault operations.
 *
 * The Docker deployment runs inside a small memory cgroup. Reading one large
 * media file as UTF-8 text is enough to get the whole process OOM-killed, so
 * every walk and read path in this project goes through the helpers below.
 */

// Directories that are never part of vault content: Synology metadata and
// recycle bins, Obsidian workspace state, VCS internals, editor junk.
const IGNORED_DIR_NAMES = new Set([
  "#recycle",
  "@eadir",
  ".trash",
  ".trashes",
  ".obsidian",
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".DS_Store",
  "Thumbs.db",
]);

// Files that carry no note content but are cheap to skip by name.
const IGNORED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

const IGNORED_FILE_PREFIXES = ["@eaDir", ".synotmb", ".syno", "#snapshot"];

// Text extensions we are willing to open. Anything not listed here is treated
// as binary unless a content sniff proves otherwise.
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "canvas", "json", "json5", "yml", "yaml",
  "toml", "csv", "tsv", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss",
  "html", "htm", "xml", "ini", "cfg", "conf", "env", "log", "sql", "c", "h",
  "cpp", "hpp", "py", "rb", "go", "rs", "java", "sh", "bash", "zsh", "ps1",
  "bat", "cmake", "ninja", "mk", "properties", "svg", "bib", "latex", "tex",
]);

// Known binary extensions. Kept as an explicit deny list so that unknown
// extensions fall back to the content sniff instead of being read as text.
const BINARY_EXTENSIONS = new Set([
  "pdf", "docx", "xlsx", "pptx", "doc", "xls", "ppt", "odt", "ods", "odp",
  "odoc", "odb", "odg", "oslides", "numbers", "pages", "key", "rtf", "epub",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "ico", "heic",
  "heif", "avif", "psd", "xcf", "ai", "sketch", "fig", "blend", "fbx", "obj",
  "mp3", "mp4", "m4a", "m4v", "wav", "ogg", "opus", "flac", "aac", "avi",
  "mkv", "mov", "wmv", "webm", "flv", "mpg", "mpeg", "3gp",
  "zip", "rar", "7z", "gz", "bz2", "xz", "tar", "tgz", "gz4", "zst",
  "iso", "img", "bin", "dmg", "wim", "vhd", "vhdx", "qcow2", "vmdk",
  "exe", "dll", "so", "dylib", "wasm", "msi", "apk", "deb", "rpm", "jar",
  "class", "sqlite", "sqlite3", "db", "dump",
  "ttf", "otf", "woff", "woff2", "eot",
  "pkt", "pcap", "pcapng", "cap", "kra", "_clip",
]);

export interface ScanLimits {
  /** Largest single file the search scan will open. */
  maxScanFileBytes: number;
  /** Largest single file read_file may return as text. */
  maxTextReadBytes: number;
  /** Largest single file read_file may return as base64. */
  maxBinaryReadBytes: number;
  /** Entries a single directory walk may visit. */
  maxWalkEntries: number;
  /** Total bytes one search call may read across all files. */
  maxScanTotalBytes: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxScanFileBytes: 2 * 1024 * 1024,
  maxTextReadBytes: 4 * 1024 * 1024,
  maxBinaryReadBytes: 32 * 1024 * 1024,
  maxWalkEntries: 20_000,
  maxScanTotalBytes: 32 * 1024 * 1024,
};

export function envBytes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function limitsFromEnv(): ScanLimits {
  return {
    maxScanFileBytes: envBytes("VAULT_API_MAX_SCAN_FILE_BYTES", DEFAULT_SCAN_LIMITS.maxScanFileBytes),
    maxTextReadBytes: envBytes("VAULT_API_MAX_TEXT_BYTES", DEFAULT_SCAN_LIMITS.maxTextReadBytes),
    maxBinaryReadBytes: envBytes("VAULT_API_MAX_BINARY_BYTES", DEFAULT_SCAN_LIMITS.maxBinaryReadBytes),
    maxWalkEntries: envBytes("VAULT_API_MAX_WALK_ENTRIES", DEFAULT_SCAN_LIMITS.maxWalkEntries),
    maxScanTotalBytes: envBytes("VAULT_API_MAX_SCAN_TOTAL_BYTES", DEFAULT_SCAN_LIMITS.maxScanTotalBytes),
  };
}

/** True when a path segment is metadata or media-index noise. */
export function isIgnoredPath(vaultRelativePath: string): boolean {
  const segments = vaultRelativePath.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (IGNORED_DIR_NAMES.has(lower) || IGNORED_FILE_NAMES.has(lower)) return true;
    if (lower.startsWith("@eaDir".toLowerCase())) return true;
    for (const prefix of IGNORED_FILE_PREFIXES) {
      if (prefix.length > 3 && lower.startsWith(prefix)) return true;
    }
  }
  return false;
}

// ── base64 payload validation ──────────────────────────────────────────────
//
// Shared rule: identical to validateBase64Payload in the Obsidian plugin
// project, so a client sees the same contract in both products.

export type Base64Check = { ok: true; estimatedBytes: number } | { ok: false; reason: string };

/**
 * Validates a base64 payload **before** it is decoded. `Buffer.from(x, "base64")`
 * silently discards characters outside the alphabet, so an unvalidated payload
 * can decode to far more than the size estimate, or be written as garbage.
 */
export function validateBase64Payload(payload: unknown, maxDecodedBytes: number): Base64Check {
  if (typeof payload !== "string" || payload.length === 0)
    return { ok: false, reason: "'base64Data' must be a non-empty string" };
  if (/\s/.test(payload))
    return { ok: false, reason: "'base64Data' must not contain whitespace or line breaks" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
    return { ok: false, reason: "'base64Data' contains characters outside the base64 alphabet" };
  if (payload.length % 4 !== 0)
    return { ok: false, reason: "'base64Data' length must be a multiple of 4" };

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const estimatedBytes = (payload.length / 4) * 3 - padding;
  if (estimatedBytes > maxDecodedBytes)
    return {
      ok: false,
      reason: `data is too large (${formatMegabytes(estimatedBytes)} decoded, limit ${formatMegabytes(maxDecodedBytes)})`,
    };

  return { ok: true, estimatedBytes };
}

export function extensionOf(filePath: string): string {
  return nodePath.extname(filePath).replace(/^\./, "").toLowerCase();
}

export type FileClass = "text" | "binary" | "image" | "svg" | "unknown";

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif",
]);

export function classifyExtension(filePath: string): FileClass {
  const ext = extensionOf(filePath);
  if (ext === "svg") return "svg";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unknown";
}

/**
 * Decide whether a file may be opened for content search. Size is checked
 * before the extension so an oversized file is never touched at all.
 */
export function shouldScanContent(
  filePath: string,
  sizeBytes: number,
  limits: ScanLimits
): { scan: boolean; reason?: string } {
  if (isIgnoredPath(filePath)) return { scan: false, reason: "ignored" };
  if (sizeBytes > limits.maxScanFileBytes) return { scan: false, reason: "too_large" };
  const cls = classifyExtension(filePath);
  if (cls === "binary" || cls === "image") return { scan: false, reason: "binary" };
  return { scan: true };
}

/** Heuristic sniff used only for extension-less or unknown-extension files. */
export function looksLikeText(sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  let readable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) { readable++; continue; }
    if (byte >= 32 && byte < 127) { readable++; continue; }
    if (byte >= 0xC2) { readable++; continue; } // plausible UTF-8 lead/continuation
  }
  return sample.length === 0 || readable / sample.length > 0.85;
}

export function formatMegabytes(bytes: number): string {
  // Sub-megabyte limits are configured in kilobytes, and "limit 0.1 MB" is a
  // poor way to say 64 KB.
  if (bytes > 0 && bytes < 0.95 * 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Short-lived signed tokens for /raw ──────────────────────────────────────
//
// The old image response put the API key in a URL that ends up inside the
// model context and in client logs. Tokens are scoped to one path and expire.

const RAW_TOKEN_TTL_MS = 15 * 60 * 1000;

export function signRawToken(apiKey: string, vaultRelativePath: string, ttlMs = RAW_TOKEN_TTL_MS): string {
  const expires = Date.now() + ttlMs;
  const payload = `${vaultRelativePath}\n${expires}`;
  const sig = crypto.createHmac("sha256", apiKey).update(payload).digest("hex").slice(0, 32);
  return `${expires}.${sig}`;
}

export function verifyRawToken(apiKey: string, vaultRelativePath: string, token: string | null): boolean {
  if (!token || !apiKey) return false;
  const [expiresRaw, signature] = token.split(".");
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const payload = `${vaultRelativePath}\n${expires}`;
  const expected = crypto.createHmac("sha256", apiKey).update(payload).digest("hex").slice(0, 32);
  const given = Buffer.from(signature ?? "", "utf-8");
  const want = Buffer.from(expected, "utf-8");
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}
