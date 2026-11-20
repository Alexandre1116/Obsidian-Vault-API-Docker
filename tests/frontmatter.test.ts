import { describe, it, expect } from "vitest";
import {
  applyFrontmatterUpdates,
  parseFrontmatterValues,
  renderFrontmatter,
  splitFrontmatter,
  formatValue,
} from "../src/vault-frontmatter.js";

const NOTE = [
  "---",
  "title: Nota de aula",
  "# comentário do autor",
  "tags: [aula, matematica]",
  "autor:",
  "  nome: Ana",
  "  curso: ICRDC",
  "links:",
  "  - \"[[Aula 1]]\"",
  "  - \"[[Aula 2]]\"",
  "data: 2026-11-18",
  "---",
  "",
  "# Corpo",
  "texto: com dois pontos",
].join("\n");

function block(content: string) {
  const parsed = splitFrontmatter(content);
  if (!parsed) throw new Error("no frontmatter in fixture");
  return parsed;
}

describe("frontmatter editing", () => {
  it("finds the block and parses values", () => {
    const parsed = parseFrontmatterValues(block(NOTE).lines);
    expect(parsed.title).toBe("Nota de aula");
    expect(parsed.tags).toBe("[aula, matematica]");
    expect(parsed.autor).toEqual(["nome: Ana", "curso: ICRDC"]);
    expect(parsed.data).toBe("2026-11-18");
  });

  it("updates one key and leaves comments and nesting untouched", () => {
    const b = block(NOTE);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { title: "Título novo" }));
    expect(out).toContain("title: Título novo");
    expect(out).toContain("# comentário do autor");
    expect(out).toContain("  nome: Ana");
    expect(out).toContain("  - \"[[Aula 2]]\"");
    expect(out).toContain("texto: com dois pontos");
    expect(out.split("\n").filter(l => l.startsWith("title:"))).toHaveLength(1);
  });

  it("removes a key together with its nested lines", () => {
    const b = block(NOTE);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { autor: null }));
    expect(out).not.toContain("nome: Ana");
    expect(out).not.toContain("curso: ICRDC");
    expect(out).toContain("tags: [aula, matematica]");
    expect(out).toContain("  - \"[[Aula 1]]\"");
  });

  it("quotes values that would break YAML", () => {
    const b = block(NOTE);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { title: "a: b", extra: "sim" }));
    expect(out).toContain('title: "a: b"');
    expect(out).toContain("extra: sim");
    expect(formatValue("2026-11-18")).toBe('"2026-11-18"');
  });

  it("creates a block for files without one", () => {
    const parsed = splitFrontmatter("# só corpo\n");
    expect(parsed).toBeNull();
  });

  it("round-trips CRLF files without changing line endings", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    const b = block(crlf);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { title: "X" }));
    expect(out.split("\r\n").length).toBeGreaterThan(1);
    expect(out).not.toMatch(/(^|[^\r])\n# Corpo/);
  });
});
