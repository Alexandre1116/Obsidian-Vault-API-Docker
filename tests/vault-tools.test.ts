import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VaultTools } from "../src/vault-tools.js";
import type { ScanLimits } from "../src/vault-policy.js";

const LIMITS: ScanLimits = {
  maxScanFileBytes: 1024 * 1024,
  maxTextReadBytes: 64 * 1024,
  maxBinaryReadBytes: 256 * 1024,
  maxWalkEntries: 500,
  maxScanTotalBytes: 8 * 1024 * 1024,
};

let root = "";
let outside = "";
let tools: VaultTools;

function write(rel: string, content: string | Buffer) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "vault-outside-"));
  tools = new VaultTools(root, LIMITS);

  write("notes/aula.md", "title: Aula\n---\nCorpo com AGULHA dentro.\n");
  write("notes/notas.txt", "nada relevante aqui\n");
  write("@eaDir/aula.md.md", "AGULHA em metadata do Synology\n");
  write("#recycle/apagado.md", "AGULHA na reciclagem\n");
  write("media/big.iso", Buffer.concat([Buffer.from("AGULHA "), Buffer.alloc(3 * 1024 * 1024, 0x41)]));
  write("media/deck.pdf", Buffer.concat([Buffer.from("%PDF-1.4 AGULHA "), Buffer.alloc(4096, 0x20)]));
  write("notes/huge.md", Buffer.concat([Buffer.from("AGULHA\n"), Buffer.alloc(1_200 * 1024, 0x42)]));
  fs.writeFileSync(path.join(outside, "secret.md"), "segredo fora do vault\n");
  fs.symlinkSync(outside, path.join(root, "escape"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("walk and list", () => {
  it("skips Synology metadata and recycle bins", async () => {
    const res = await tools.listFiles();
    const paths = res.files.map(f => f.path);
    expect(paths).toContain("notes/aula.md");
    expect(paths.some(p => p.includes("@eaDir"))).toBe(false);
    expect(paths.some(p => p.startsWith("#recycle"))).toBe(false);
    expect(res.skipped_metadata).toBeGreaterThan(0);
  });

  it("stops the walk at the entry budget and says so", async () => {
    const tiny = new VaultTools(root, { ...LIMITS, maxWalkEntries: 2 });
    const res = await tiny.listFiles();
    expect(res.truncated).toBe(true);
    expect(res.note).toContain("walk stopped");
  });
});

describe("search never opens the files that used to OOM the container", () => {
  it("returns the note match and reports skipped files", async () => {
    const res = await tools.search("agulha");
    const paths = res.results.map(r => r.path);
    expect(paths).toContain("notes/aula.md");
    expect(paths).not.toContain("media/big.iso");
    expect(paths).not.toContain("notes/huge.md");
    expect(paths.some(p => p.includes("@eaDir"))).toBe(false);
    expect(res.skipped.binary).toBeGreaterThanOrEqual(1);
    expect(res.skipped.too_large).toBeGreaterThanOrEqual(1);
    expect(res.partial).toBe(false);
  });

  it("matches by filename", async () => {
    const res = await tools.search("aula");
    const match = res.results.find(r => r.path === "notes/aula.md");
    expect(match?.matches).toContain("(filename match)");
  });

  it("returns partial results instead of hanging when the deadline passes", async () => {
    const res = await tools.search("nada", { deadlineAt: Date.now() - 1 });
    expect(res.partial).toBe(true);
    expect(res.note).toContain("partial");
  });
});

describe("path containment", () => {
  it("rejects traversal, absolute paths and NUL bytes", async () => {
    await expect(tools.resolveSafe("../etc/passwd")).rejects.toThrow(/traverse/);
    await expect(tools.resolveSafe("/etc/passwd")).rejects.toThrow(/vault-relative/);
    await expect(tools.resolveSafe("notes/../../x")).rejects.toThrow(/traverse/);
    await expect(tools.resolveSafe("notes/a\0b")).rejects.toThrow(/NUL/);
    await expect(tools.resolveSafe("")).rejects.toThrow(/non-empty/);
  });

  it("refuses symlinks that point outside the vault", async () => {
    await expect(tools.readFile("escape/secret.md")).rejects.toThrow(/symlink|escapes/);
    await expect(tools.resolveSafe("escape/secret.md")).rejects.toThrow();
  });

  it("rejects a link to a sibling directory whose name shares the vault prefix", async () => {
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "inside.txt"), "fora do vault\n");
    fs.symlinkSync(sibling, path.join(root, "sibling"));
    await expect(tools.readFile("sibling/inside.txt")).rejects.toThrow(/outside the vault|escapes the vault|symlink/);
    await expect(tools.readFile("notes/../sibling/inside.txt")).rejects.toThrow();
    fs.rmSync(sibling, { recursive: true, force: true });
  });
});

describe("writes and deletion", () => {
  it("appends without rewriting the file", async () => {
    await tools.appendFile("notes/notas.txt", "linha nova\n");
    expect(fs.readFileSync(path.join(root, "notes/notas.txt"), "utf-8")).toBe("nada relevante aqui\nlinha nova\n");
  });

  it("moves deletions to the trash instead of erasing them", async () => {
    const res = await tools.deleteFile("notes/aula.md");
    expect(res.action).toBe("moved_to_trash");
    expect(fs.existsSync(path.join(root, "notes/aula.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".trash/notes/aula.md"), "utf-8")).toContain("AGULHA");
  });

  it("collides in trash without overwriting", async () => {
    await tools.deleteFile("notes/aula.md");
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes/aula.md"), "segunda versão\n");
    const res = await tools.deleteFile("notes/aula.md");
    expect(res.trashPath).toContain("aula-1.md");
  });

  it("refuses to move a folder inside itself", async () => {
    await expect(tools.renameFolder("notes", "notes/inside")).rejects.toThrow(/inside itself/);
  });

  it("refuses to read a text file above the size limit", async () => {
    await expect(tools.readFile("notes/huge.md")).rejects.toThrow(/too large to read/);
  });
});

describe("frontmatter through the tool surface", () => {
  it("preserves body and unrelated keys", async () => {
    write("notes/fm.md", "---\ntitle: Antigo\n# nota do autor\ntags: [a, b]\n---\n# Corpo\ntexto: aqui\n");
    const res = await tools.updateFrontmatter("notes/fm.md", { title: "Novo", extra: "1" });
    expect(res.action).toBe("frontmatter_updated");
    const content = fs.readFileSync(path.join(root, "notes/fm.md"), "utf-8");
    expect(content).toContain("title: Novo");
    expect(content).toContain("extra: 1");
    expect(content).toContain("# nota do autor");
    expect(content).toContain("tags: [a, b]");
    expect(content).toContain("texto: aqui");
    expect(content.split("---").length).toBe(3);
  });

  it("reports no frontmatter for plain files", async () => {
    const res = await tools.readFrontmatter("notes/notas.txt");
    expect(res.hasFrontmatter).toBe(false);
  });
});
