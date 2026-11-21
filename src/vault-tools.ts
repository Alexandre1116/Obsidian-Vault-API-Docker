import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as readline from "node:readline";
import sharp from "sharp";
import {
  classifyExtension,
  extensionOf,
  formatMegabytes,
  isIgnoredPath,
  limitsFromEnv,
  looksLikeText,
  shouldScanContent,
  validateBase64Payload,
  type ScanLimits,
} from "./vault-policy.js";
import {
  applyFrontmatterUpdates,
  parseFrontmatterValues,
  renderFrontmatter,
  splitFrontmatter,
} from "./vault-frontmatter.js";

const RESIZE_THRESHOLD = 4 * 1024 * 1024;
const SNIFF_BYTES = 4096;

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

function maxDimForSize(bytes: number): number {
  if (bytes > 100 * 1024 * 1024) return 512;
  if (bytes > 20 * 1024 * 1024) return 800;
  return 1024;
}

export class VaultError extends Error {}

interface WalkEntry { rel: string; abs: string; size: number; mtimeMs: number; }
interface WalkResult { entries: WalkEntry[]; truncated: boolean; ignored: number; }

export class VaultTools {
  private readonly limits: ScanLimits;

  constructor(
    private vaultBase: string,
    limits: ScanLimits = limitsFromEnv()
  ) {
    this.limits = limits;
  }

  get scanLimits(): ScanLimits { return this.limits; }

  // ── Path safety ────────────────────────────────────────────────────────
  //
  // Every access resolves against the real vault root and refuses anything
  // that lands outside it, including through a symlink placed inside the vault.

  private async baseRealPath(): Promise<string> {
    return fs.promises.realpath(this.vaultBase);
  }

  private isInside(base: string, target: string): boolean {
    return target === base || target.startsWith(base + nodePath.sep);
  }

  async resolveSafe(vaultRelativePath: string): Promise<string> {
    if (typeof vaultRelativePath !== "string" || vaultRelativePath === "")
      throw new VaultError("'path' must be a non-empty string");
    if (vaultRelativePath.includes("\0"))
      throw new VaultError("'path' must not contain NUL bytes");
    if (nodePath.isAbsolute(vaultRelativePath))
      throw new VaultError("'path' must be vault-relative (no leading slash or drive letter)");
    if (vaultRelativePath.split(/[/\\]/).some(s => s === ".."))
      throw new VaultError("'path' must not traverse outside the vault (no '..')");

    const base = await this.baseRealPath();
    const abs = nodePath.resolve(base, vaultRelativePath);
    if (!this.isInside(base, abs))
      throw new VaultError(`Path traversal detected: '${vaultRelativePath}' resolves outside the vault`);

    // Walk up to the nearest existing ancestor: a symlink there could redirect
    // the rest of the path outside the vault.
    let probe = abs;
    for (;;) {
      let stat: fs.Stats | null = null;
      try { stat = await fs.promises.lstat(probe); } catch { stat = null; }
      if (stat) break;
      const parent = nodePath.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = await fs.promises.realpath(probe).catch(() => probe);
    if (!this.isInside(base, realProbe))
      throw new VaultError(`Path traversal detected: '${vaultRelativePath}' escapes the vault through a link`);

    const finalStat = await fs.promises.lstat(abs).catch(() => null);
    if (finalStat?.isSymbolicLink())
      throw new VaultError(`Refusing to follow symlink: '${vaultRelativePath}'`);

    return abs;
  }

  private async statOrNull(abs: string): Promise<fs.Stats | null> {
    try { return await fs.promises.stat(abs); } catch { return null; }
  }

  private async readSniff(abs: string): Promise<boolean> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(abs, "r");
      const buffer = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
      return looksLikeText(buffer.subarray(0, bytesRead));
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  // ── Directory walk ─────────────────────────────────────────────────────
  //
  // Async so the per-tool timeout can fire, bounded by an entry budget, and
  // never descends into metadata or recycle-bin directories.

  async walk(vaultRelativeFolder = "", budget = this.limits.maxWalkEntries): Promise<WalkResult> {
    const base = await this.baseRealPath();
    const root = vaultRelativeFolder ? nodePath.resolve(base, vaultRelativeFolder) : base;
    if (!this.isInside(base, root))
      throw new VaultError(`Folder '${vaultRelativeFolder}' is outside the vault`);

    const entries: WalkEntry[] = [];
    let truncated = false;
    let ignored = 0;

    const walkDir = async (absDir: string, relDir: string): Promise<void> => {
      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirents) {
        if (entries.length >= budget) { truncated = true; return; }
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (isIgnoredPath(rel)) { ignored++; continue; }
        const abs = nodePath.join(absDir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(abs, rel);
        } else if (entry.isFile()) {
          const stat = await this.statOrNull(abs);
          if (!stat) continue;
          entries.push({ rel, abs, size: stat.size, mtimeMs: stat.mtimeMs });
        } else {
          ignored++; // symlinks, sockets, devices
        }
      }
    };

    await walkDir(root, vaultRelativeFolder.replace(/\/+$/, ""));
    return { entries, truncated, ignored };
  }

  // ── list_files ─────────────────────────────────────────────────────────

  async listFiles(folder = "", extension = "", limit = 2000) {
    const { entries, truncated, ignored } = await this.walk(folder);
    let filtered = entries;
    if (extension) {
      const ext = extension.replace(/^\./, "").toLowerCase();
      filtered = filtered.filter(f => extensionOf(f.rel).toLowerCase() === ext);
    }
    const total = filtered.length;
    const page = filtered.slice(0, limit);
    return {
      files: page.map(f => ({
        path: f.rel,
        name: nodePath.basename(f.rel),
        extension: extensionOf(f.rel),
        size: f.size,
        modified: new Date(f.mtimeMs).toISOString(),
      })),
      total,
      shown: page.length,
      truncated: truncated || total > limit,
      skipped_metadata: ignored,
      ...(truncated && {
        note: `Directory walk stopped after ${this.limits.maxWalkEntries} entries. Narrow the folder filter.`,
      }),
      ...(total > limit && {
        note: `Showing ${limit} of ${total} files. Use folder or extension filters to narrow results.`,
      }),
    };
  }

  // ── read_file ──────────────────────────────────────────────────────────

  /**
   * Reads at most `capBytes` from an open handle, in chunks. Nothing is thrown
   * for an oversized file: the caller gets `tooLarge` plus the size that was
   * actually seen, so each tool can word its own error.
   *
   * The size comes from `fstat` on that handle, not from an earlier `stat`, and
   * the bytes are read in 64 KB pieces, so the allocation is bounded by the
   * limit rather than by whatever the file reports. That matters in a container
   * mounted from a NAS: Synology indexing, a desktop Obsidian saving the same
   * note, or a cloud placeholder finishing its download all change files behind
   * our back.
   */
  private async readCapped(abs: string, capBytes: number): Promise<{ buffer?: Buffer; size: number; tooLarge: boolean }> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(abs, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new VaultError(`Not a regular file: ${abs}`);
      if (stat.size > capBytes) return { size: stat.size, tooLarge: true };

      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= capBytes) {
        const want = Math.min(64 * 1024, capBytes + 1 - total);
        if (want <= 0) break;
        const slice = Buffer.alloc(want);
        const { bytesRead } = await handle.read(slice, 0, want, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(slice.subarray(0, bytesRead));
      }
      if (total > capBytes) return { size: total, tooLarge: true };
      return { buffer: Buffer.concat(chunks, total), size: total, tooLarge: false };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Text for `read_file`, with the cap enforced by the reader itself. */
  private async readTextCapped(abs: string): Promise<string> {
    const read = await this.readCapped(abs, this.limits.maxTextReadBytes);
    if (!read.buffer)
      throw new VaultError(
        `Text file too large to read (${formatMegabytes(read.size)}, ` +
        `limit ${formatMegabytes(this.limits.maxTextReadBytes)}). ` +
        "Use run_local_command with grep/awk, or raise VAULT_API_MAX_TEXT_BYTES."
      );
    return read.buffer.toString("utf-8");
  }

  async readFile(path: string): Promise<
    | { type: "text"; content: string }
    | { type: "image"; mimeType: string; data: string; note?: string }
    | { type: "binary"; mimeType: string; data: string; size: number }
  > {
    const abs = await this.resolveSafe(path);
    const st = await this.statOrNull(abs);
    if (!st || !st.isFile()) throw new VaultError(`File not found: ${path}`);

    const ext = extensionOf(path);
    const sizeMB = formatMegabytes(st.size);
    const cls = classifyExtension(path);

    if (cls === "svg") return { type: "text", content: await this.readTextCapped(abs) };

    if (cls === "image") {
      if (st.size > RESIZE_THRESHOLD) {
        const maxDim = maxDimForSize(st.size);
        try {
          const resized = await sharp(abs).resize(maxDim, maxDim, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
          return {
            type: "image",
            mimeType: "image/jpeg",
            data: resized.toString("base64"),
            note: `[Auto-resized: original ${sizeMB} -> ${maxDim}px JPEG 85%]`,
          };
        } catch (err) {
          throw new VaultError(`Could not process image (${sizeMB}): ` + (err instanceof Error ? err.message : String(err)));
        }
      }
      const image = await this.readCapped(abs, RESIZE_THRESHOLD);
      if (!image.buffer)
        throw new VaultError(
          `Image grew beyond the inline limit (${formatMegabytes(image.size)}, ` +
          `limit ${formatMegabytes(RESIZE_THRESHOLD)}). Use /raw with a signed URL.`
        );
      return { type: "image", mimeType: mimeType(ext), data: image.buffer.toString("base64") };
    }

    const textLike = cls === "text" || (cls === "unknown" && await this.readSniff(abs));

    if (textLike) return { type: "text", content: await this.readTextCapped(abs) };

    const binary = await this.readCapped(abs, this.limits.maxBinaryReadBytes);
    if (!binary.buffer)
      throw new VaultError(
        `File too large to return as base64 (${formatMegabytes(binary.size)}, ` +
        `limit ${formatMegabytes(this.limits.maxBinaryReadBytes)}). ` +
        "Use /raw with a signed URL or run_local_command."
      );
    return { type: "binary", mimeType: mimeType(ext), data: binary.buffer.toString("base64"), size: binary.size };
  }

  // ── Writers ────────────────────────────────────────────────────────────

  async writeFile(path: string, content: string) {
    const abs = await this.resolveSafe(path);
    const st = await this.statOrNull(abs);
    if (st && !st.isFile()) throw new VaultError(`Not a file: ${path}`);
    await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, "utf-8");
    return { path, action: st ? "updated" : "created" };
  }

  async writeBinary(path: string, base64Data: string) {
    // Validated before anything is decoded. `Buffer.from(x, "base64")` silently
    // drops characters outside the alphabet, so an unvalidated body can decode
    // far above the size estimate, or be garbage that is written to the vault.
    const payload = validateBase64Payload(base64Data, this.limits.maxBinaryReadBytes);
    if (!payload.ok)
      throw new VaultError(
        `Data cannot be written: ${payload.reason}. Raise VAULT_API_MAX_BINARY_BYTES if this is intentional.`
      );

    const abs = await this.resolveSafe(path);
    await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
    const buf = Buffer.from(base64Data, "base64");
    if (buf.length !== payload.estimatedBytes)
      throw new VaultError(
        `Data cannot be written: decoded to ${buf.length} bytes, expected ${payload.estimatedBytes}`
      );
    const existed = await this.statOrNull(abs);
    await fs.promises.writeFile(abs, buf);
    return { path, action: existed ? "updated" : "created", size: buf.length };
  }

  /**
   * Append without rewriting the file. The previous read+write pair could lose
   * the original content if the NFS mount hiccuped mid-write.
   */
  async appendFile(path: string, content: string) {
    const abs = await this.resolveSafe(path);
    const st = await this.statOrNull(abs);
    if (!st || !st.isFile()) throw new VaultError(`File not found: ${path}`);
    if (st.size + Buffer.byteLength(content) > this.limits.maxTextReadBytes)
      throw new VaultError(
        `Append would exceed the text size limit (${formatMegabytes(st.size + Buffer.byteLength(content))} > ` +
        `${formatMegabytes(this.limits.maxTextReadBytes)}).`
      );
    await fs.promises.appendFile(abs, content, "utf-8");
    return { path, action: "appended", totalSize: st.size + Buffer.byteLength(content) };
  }

  // ── Deletion (trash by default) ────────────────────────────────────────
  //
  // Permanent deletion is never the default: an agent mistake should be
  // recoverable, matching the desktop plugin's system-trash behaviour.

  private trashDir(): string {
    const raw = process.env.VAULT_API_TRASH_DIR;
    return raw === undefined ? ".trash" : raw.trim();
  }

  private async uniqueTrashTarget(rel: string): Promise<string> {
    const trash = this.trashDir();
    let candidate = `${trash}/${rel}`;
    for (let i = 1; i < 1000; i++) {
      try {
        await fs.promises.lstat(await this.resolveSafe(candidate));
      } catch {
        return candidate;
      }
      const ext = nodePath.extname(rel);
      candidate = `${trash}/${rel.slice(0, rel.length - ext.length)}-${i}${ext}`;
    }
    throw new VaultError(`Could not find a free trash name for '${rel}'`);
  }

  private async moveToTrash(abs: string, rel: string): Promise<string | null> {
    const trash = this.trashDir();
    if (trash === "") {
      await fs.promises.rm(abs, { recursive: true, force: true });
      return null;
    }
    const targetRel = await this.uniqueTrashTarget(rel);
    const targetAbs = await this.resolveSafe(targetRel);
    await fs.promises.mkdir(nodePath.dirname(targetAbs), { recursive: true });
    await fs.promises.rename(abs, targetAbs);
    return targetRel;
  }

  private async located(path: string): Promise<{ abs: string; rel: string; stat: fs.Stats }> {
    const abs = await this.resolveSafe(path);
    const rel = nodePath.relative(await this.baseRealPath(), abs);
    const stat = await this.statOrNull(abs);
    if (!stat) throw new VaultError(`Not found: ${path}`);
    return { abs, rel, stat };
  }

  async deleteFile(path: string) {
    const { abs, rel, stat } = await this.located(path);
    if (!stat.isFile()) throw new VaultError(`File not found: ${path}`);
    const trashPath = await this.moveToTrash(abs, rel);
    return { path, action: trashPath ? "moved_to_trash" : "deleted", ...(trashPath ? { trashPath } : {}) };
  }

  async deleteFolder(path: string) {
    const { abs, rel, stat } = await this.located(path);
    if (!stat.isDirectory()) throw new VaultError(`Folder not found: ${path}`);
    const trashPath = await this.moveToTrash(abs, rel);
    return { path, action: trashPath ? "moved_to_trash" : "folder_deleted", ...(trashPath ? { trashPath } : {}) };
  }

  async createFolder(path: string) {
    const abs = await this.resolveSafe(path);
    const st = await this.statOrNull(abs);
    if (st) return { path, action: "already_exists" };
    await fs.promises.mkdir(abs, { recursive: true });
    return { path, action: "folder_created" };
  }

  async renameFolder(path: string, newPath: string) {
    const abs = await this.resolveSafe(path);
    const newAbs = await this.resolveSafe(newPath);
    const st = await this.statOrNull(abs);
    if (!st) throw new VaultError(`Folder not found: ${path}`);
    if (this.isInside(await this.baseRealPath(), newAbs) === false)
      throw new VaultError(`Destination '${newPath}' is outside the vault`);
    if (newAbs === abs) throw new VaultError("Source and destination are the same path");
    if (newAbs.startsWith(abs + nodePath.sep))
      throw new VaultError("Cannot move a folder inside itself");
    await fs.promises.mkdir(nodePath.dirname(newAbs), { recursive: true });
    await fs.promises.rename(abs, newAbs);
    return { path, newPath, action: "folder_renamed" };
  }

  // ── Frontmatter ────────────────────────────────────────────────────────

  async readFrontmatter(path: string) {
    const abs = await this.resolveSafe(path);
    const st = await this.statOrNull(abs);
    if (!st || !st.isFile()) throw new VaultError(`File not found: ${path}`);
    if (st.size > this.limits.maxTextReadBytes)
      throw new VaultError(`File too large to read frontmatter (${formatMegabytes(st.size)}).`);
    const content = await fs.promises.readFile(abs, "utf-8");
    const block = splitFrontmatter(content);
    if (!block || block.lines.length === 0)
      return { path, hasFrontmatter: false, frontmatter: {}, raw: null };
    return {
      path,
      hasFrontmatter: true,
      frontmatter: parseFrontmatterValues(block.lines),
      raw: block.lines.join(block.eol),
    };
  }

  async updateFrontmatter(path: string, updates: Record<string, string | null>) {
    const abs = await this.resolveSafe(path);
    const st = await this.statOrNull(abs);
    if (!st || !st.isFile()) throw new VaultError(`File not found: ${path}`);
    if (st.size > this.limits.maxTextReadBytes)
      throw new VaultError(`File too large to edit frontmatter (${formatMegabytes(st.size)}).`);
    const content = await fs.promises.readFile(abs, "utf-8");
    let block = splitFrontmatter(content);
    if (!block) {
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      block = { prefix: "", lines: [], body: content.slice(content.charCodeAt(0) === 0xfeff ? 1 : 0), eol };
    }
    const nextLines = applyFrontmatterUpdates(block, updates);
    const rendered = renderFrontmatter(block, nextLines);
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, rendered, "utf-8");
    await fs.promises.rename(tmp, abs); // atomic on the same filesystem
    return { path, action: "frontmatter_updated" };
  }

  // ── search ─────────────────────────────────────────────────────────────
  //
  // The previous version opened every file that was not on a short binary
  // extension list, with readFileSync and no size check. In a vault that also
  // holds course media that meant a 4.8 GB .iso being decoded as UTF-8, which
  // OOM-kills the container. Everything here is streamed and budgeted.

  private async scanFile(
    file: WalkEntry,
    needle: string,
    deadlineAt: number,
    byteBudget: number
  ): Promise<{ matches: string[]; bytes: number }> {
    const cls = classifyExtension(file.rel);
    if (cls === "unknown" && !await this.readSniff(file.abs)) return { matches: [], bytes: 0 };

    const matches: string[] = [];
    let bytes = 0;
    const stream = fs.createReadStream(file.abs, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        bytes += Buffer.byteLength(line) + 1;
        if (bytes > byteBudget) break;
        if (line.toLowerCase().includes(needle)) {
          matches.push(line.trim().slice(0, 500));
          if (matches.length >= 3) break;
        }
        if (Date.now() >= deadlineAt) break;
      }
    } catch {
      // Unreadable or mid-read mount error: skip the file, keep the results.
    } finally {
      rl.close();
      stream.destroy();
    }
    return { matches, bytes };
  }

  async search(query: string, options: { deadlineAt?: number; maxResults?: number } = {}) {
    const MAX_RESULTS = options.maxResults ?? 50;
    const deadline = options.deadlineAt ?? Date.now() + 20_000;
    const needle = query.toLowerCase();

    const { entries, truncated: walkTruncated, ignored } = await this.walk("");

    const results: { path: string; matches: string[] }[] = [];
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) break;
      if (entry.rel.toLowerCase().includes(needle))
        results.push({ path: entry.rel, matches: ["(filename match)"] });
    }

    const matched = new Set(results.map(r => r.path));
    let skippedTooLarge = 0;
    let skippedBinary = 0;
    const candidates: WalkEntry[] = [];
    for (const entry of entries) {
      if (matched.has(entry.rel)) continue;
      const decision = shouldScanContent(entry.rel, entry.size, this.limits);
      if (decision.scan) candidates.push(entry);
      else if (decision.reason === "too_large") skippedTooLarge++;
      else if (decision.reason === "binary") skippedBinary++;
    }

    let bytesScanned = 0;
    let filesScanned = 0;
    let deadlineHit = false;
    let budgetHit = false;

    for (const file of candidates) {
      if (results.length >= MAX_RESULTS) break;
      if (Date.now() >= deadline) { deadlineHit = true; break; }
      if (bytesScanned >= this.limits.maxScanTotalBytes) { budgetHit = true; break; }
      const { matches, bytes } = await this.scanFile(file, needle, deadline, this.limits.maxScanTotalBytes - bytesScanned);
      filesScanned++;
      bytesScanned += bytes;
      if (matches.length) results.push({ path: file.rel, matches });
    }

    const capped = results.length >= MAX_RESULTS;
    const partial = capped || deadlineHit || budgetHit || walkTruncated;
    const notes: string[] = [];
    if (capped) notes.push(`Results capped at ${MAX_RESULTS}. Refine your query to see more specific matches.`);
    if (deadlineHit) notes.push("Search stopped at the time budget; results are partial, not empty.");
    if (budgetHit) notes.push(`Search stopped after reading ${formatMegabytes(this.limits.maxScanTotalBytes)}; results are partial.`);
    if (walkTruncated) notes.push(`Directory walk stopped after ${this.limits.maxWalkEntries} entries; results are partial.`);
    if (skippedTooLarge) notes.push(`${skippedTooLarge} file(s) over ${formatMegabytes(this.limits.maxScanFileBytes)} were not opened.`);

    return {
      results,
      results_shown: results.length,
      capped,
      partial,
      scanned_files: filesScanned,
      bytes_scanned: bytesScanned,
      skipped: { ignored_metadata: ignored, too_large: skippedTooLarge, binary: skippedBinary },
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }
}
