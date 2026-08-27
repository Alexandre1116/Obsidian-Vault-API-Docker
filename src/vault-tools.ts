import * as fs from "node:fs";
import * as nodePath from "node:path";
import sharp from "sharp";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"]);
const SVG_EXTS = new Set(["svg"]);

const BINARY_EXTS = new Set([
  "pdf", "docx", "xlsx", "pptx", "zip", "rar", "7z", "gz", "tar",
  "mp3", "mp4", "wav", "ogg", "flac", "avi", "mkv", "mov", "wmv",
  "exe", "dll", "so", "dylib", "wasm",
  "sqlite", "db",
  "ttf", "otf", "woff", "woff2", "eot",
]);

const RESIZE_THRESHOLD = 4 * 1024 * 1024;
const MAX_BINARY_BYTES = 500 * 1024 * 1024;

function maxDimForSize(bytes: number): number {
  if (bytes > 100 * 1024 * 1024) return 512;
  if (bytes > 20 * 1024 * 1024) return 800;
  return 1024;
}

function mimeType(ext: string): string {
  const t: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    mp3: "audio/mpeg", mp4: "video/mp4", wav: "audio/wav",
  };
  return t[ext.toLowerCase()] ?? "application/octet-stream";
}

export class VaultTools {
  constructor(private vaultBase: string) {}

  private resolve(path: string): string {
    const resolved = nodePath.resolve(this.vaultBase, path);
    if (!resolved.startsWith(this.vaultBase)) {
      throw new Error(`Path traversal detected: '${path}' resolves outside the vault`);
    }
    return resolved;
  }

  private stat(path: string): { exists: boolean; isFile: boolean; isDir: boolean; size: number; mtime: number } {
    const abs = this.resolve(path);
    try {
      const s = fs.statSync(abs);
      return { exists: true, isFile: s.isFile(), isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch {
      return { exists: false, isFile: false, isDir: false, size: 0, mtime: 0 };
    }
  }

  async listFiles(folder = "", extension = "", limit = 2000): Promise<{
    files: { path: string; name: string; extension: string; size: number; modified: string }[];
    total: number; shown: number; truncated: boolean; note?: string;
  }> {
    const allFiles: { path: string; name: string; extension: string; size: number; modified: string }[] = [];
    const walkDir = (dirRel: string) => {
      const abs = this.resolve(dirRel);
      if (!fs.existsSync(abs)) return;
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      for (const entry of entries) {
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkDir(rel);
        } else if (entry.isFile()) {
          const s = fs.statSync(nodePath.join(abs, entry.name));
          allFiles.push({
            path: rel,
            name: entry.name,
            extension: nodePath.extname(entry.name).slice(1),
            size: s.size,
            modified: new Date(s.mtimeMs).toISOString(),
          });
        }
      }
    };
    walkDir(folder.replace(/\/$/, ""));

    let filtered = allFiles;
    if (extension) {
      const ext = extension.replace(/^\./, "").toLowerCase();
      filtered = filtered.filter(f => f.extension.toLowerCase() === ext);
    }

    const total = filtered.length;
    const page = filtered.slice(0, limit);
    return {
      files: page,
      total,
      shown: page.length,
      truncated: total > limit,
      ...(total > limit && { note: `Showing ${limit} of ${total} files. Use folder or extension filters to narrow results.` }),
    };
  }

  async readFile(path: string): Promise<
    | { type: "text"; content: string }
    | { type: "image"; mimeType: string; data: string; note?: string }
    | { type: "binary"; mimeType: string; data: string; size: number }
  > {
    const abs = this.resolve(path);
    const st = this.stat(path);
    if (!st.exists || !st.isFile) throw new Error(`File not found: ${path}`);

    const ext = nodePath.extname(path).slice(1).toLowerCase();
    const bytes = st.size;
    const sizeMB = (bytes / 1024 / 1024).toFixed(1);

    if (SVG_EXTS.has(ext)) {
      return { type: "text", content: fs.readFileSync(abs, "utf-8") };
    }

    if (IMAGE_EXTS.has(ext)) {
      const mime = mimeType(ext);
      if (bytes > RESIZE_THRESHOLD) {
        const maxDim = maxDimForSize(bytes);
        try {
          const resized = await sharp(abs)
            .resize(maxDim, maxDim, { fit: "inside" })
            .jpeg({ quality: 85 })
            .toBuffer();
          const note = `[Auto-resized: original ${sizeMB} MB -> ${maxDim}px JPEG 85%]`;
          return { type: "image", mimeType: "image/jpeg", data: resized.toString("base64"), note };
        } catch (err) {
          throw new Error(
            `Could not process image (${sizeMB} MB): ` +
            (err instanceof Error ? err.message : String(err))
          );
        }
      }
      const buf = fs.readFileSync(abs);
      return { type: "image", mimeType: mime, data: buf.toString("base64") };
    }

    if (BINARY_EXTS.has(ext)) {
      if (bytes > MAX_BINARY_BYTES)
        throw new Error(`File too large to read (${sizeMB} MB, max ${MAX_BINARY_BYTES / 1024 / 1024} MB)`);
      const buf = fs.readFileSync(abs);
      return { type: "binary", mimeType: mimeType(ext), data: buf.toString("base64"), size: bytes };
    }

    try {
      const content = fs.readFileSync(abs, "utf-8");
      return { type: "text", content };
    } catch {
      const buf = fs.readFileSync(abs);
      return { type: "binary", mimeType: mimeType(ext), data: buf.toString("base64"), size: bytes };
    }
  }

  async writeFile(path: string, content: string): Promise<{ path: string; action: string }> {
    const abs = this.resolve(path);
    const dir = nodePath.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, content, "utf-8");
    return { path, action: existed ? "updated" : "created" };
  }

  async writeBinary(path: string, base64Data: string): Promise<{ path: string; action: string; size: number }> {
    const approxBytes = Math.ceil(base64Data.length * 3 / 4);
    if (approxBytes > MAX_BINARY_BYTES)
      throw new Error(`Data too large to write (~${(approxBytes / 1024 / 1024).toFixed(1)} MB, max ${MAX_BINARY_BYTES / 1024 / 1024} MB)`);
    const abs = this.resolve(path);
    const dir = nodePath.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(base64Data, "base64");
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, buf);
    return { path, action: existed ? "updated" : "created", size: buf.length };
  }

  async deleteFile(path: string): Promise<{ path: string; action: string }> {
    const abs = this.resolve(path);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${path}`);
    fs.unlinkSync(abs);
    return { path, action: "deleted" };
  }

  async readFrontmatter(path: string): Promise<{ path: string; hasFrontmatter: boolean; frontmatter: Record<string, unknown>; raw: string | null }> {
    const abs = this.resolve(path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`File not found: ${path}`);
    const content = fs.readFileSync(abs, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { path, hasFrontmatter: false, frontmatter: {}, raw: null };
    const raw = fmMatch[1];
    const frontmatter: Record<string, unknown> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^(\w[\w\s]*?):\s*(.+)/);
      if (m) frontmatter[m[1].trim()] = m[2].trim();
    }
    return { path, hasFrontmatter: true, frontmatter, raw };
  }

  async updateFrontmatter(path: string, updates: Record<string, string | null>): Promise<{ path: string; action: string }> {
    const abs = this.resolve(path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`File not found: ${path}`);
    let content = fs.readFileSync(abs, "utf-8");
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n*/);
    if (fmMatch) {
      const fmRaw = fmMatch[0];
      const bodyStart = fmRaw.length;
      const existing: Record<string, string> = {};
      for (const line of fmRaw.split("\n")) {
        const m = line.match(/^(\w[\w\s]*?):\s*(.+)/);
        if (m) existing[m[1].trim()] = m[2].trim();
      }
      for (const [key, val] of Object.entries(updates)) {
        if (val === null) delete existing[key];
        else existing[key] = val;
      }
      const newFm = "---\n" + Object.entries(existing).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n";
      content = newFm + content.slice(bodyStart).replace(/^---\n[\s\S]*?\n---\n*/, "");
    } else {
      const fmLines = Object.entries(updates)
        .filter(([, val]) => val !== null)
        .map(([k, v]) => `${k}: ${v}`);
      if (fmLines.length > 0) {
        content = "---\n" + fmLines.join("\n") + "\n---\n" + content;
      }
    }
    fs.writeFileSync(abs, content, "utf-8");
    return { path, action: "frontmatter_updated" };
  }

  async createFolder(path: string): Promise<{ path: string; action: string }> {
    const abs = this.resolve(path);
    if (fs.existsSync(abs)) return { path, action: "already_exists" };
    fs.mkdirSync(abs, { recursive: true });
    return { path, action: "folder_created" };
  }

  async deleteFolder(path: string): Promise<{ path: string; action: string }> {
    const abs = this.resolve(path);
    if (!fs.existsSync(abs)) throw new Error(`Folder not found: ${path}`);
    fs.rmSync(abs, { recursive: true });
    return { path, action: "folder_deleted" };
  }

  async renameFolder(path: string, newPath: string): Promise<{ path: string; newPath: string; action: string }> {
    const abs = this.resolve(path);
    const newAbs = this.resolve(newPath);
    if (!fs.existsSync(abs)) throw new Error(`Folder not found: ${path}`);
    const dir = nodePath.dirname(newAbs);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(abs, newAbs);
    return { path, newPath, action: "folder_renamed" };
  }

  async appendFile(path: string, content: string): Promise<{ path: string; action: string; totalSize: number }> {
    const abs = this.resolve(path);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${path}`);
    const existing = fs.readFileSync(abs, "utf-8");
    fs.writeFileSync(abs, existing + content, "utf-8");
    return { path, action: "appended", totalSize: existing.length + content.length };
  }

  async search(query: string): Promise<{
    results: { path: string; matches: string[] }[];
    results_shown: number;
    capped: boolean;
    note?: string;
  }> {
    const q = query.toLowerCase();
    const results: { path: string; matches: string[] }[] = [];
    const MAX_RESULTS = 50;
    const allFiles: { rel: string; abs: string; ext: string }[] = [];

    const walkDir = (dirAbs: string, dirRel: string) => {
      const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      for (const entry of entries) {
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkDir(nodePath.join(dirAbs, entry.name), rel);
        } else if (entry.isFile()) {
          const ext = nodePath.extname(entry.name).slice(1).toLowerCase();
          allFiles.push({ rel, abs: nodePath.join(dirAbs, entry.name), ext });
        }
      }
    };
    walkDir(this.vaultBase, "");

    for (const file of allFiles) {
      if (results.length >= MAX_RESULTS) break;
      if (file.rel.toLowerCase().includes(q))
        results.push({ path: file.rel, matches: ["(filename match)"] });
    }

    const matched = new Set(results.map(r => r.path));
    const textFiles = allFiles.filter(f => {
      return !BINARY_EXTS.has(f.ext) && !IMAGE_EXTS.has(f.ext) && !matched.has(f.rel);
    });

    const BATCH = 20;
    for (let i = 0; i < textFiles.length && results.length < MAX_RESULTS; i += BATCH) {
      const batch = textFiles.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (file): Promise<{ path: string; matches: string[] } | null> => {
        try {
          const text = fs.readFileSync(file.abs, "utf-8");
          const lines = text.split("\n").filter(l => l.toLowerCase().includes(q));
          if (lines.length)
            return { path: file.rel, matches: lines.slice(0, 3).map(l => l.trim()) };
        } catch { /* skip unreadable */ }
        return null;
      }));
      for (const r of batchResults) {
        if (r && results.length < MAX_RESULTS) results.push(r);
      }
    }

    return {
      results,
      results_shown: results.length,
      capped: results.length >= MAX_RESULTS,
      note: results.length >= MAX_RESULTS
        ? `Results capped at ${MAX_RESULTS}. Refine your query to see more specific matches.`
        : undefined,
    };
  }
}
