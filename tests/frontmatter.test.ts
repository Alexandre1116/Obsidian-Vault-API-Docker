import { describe, it, expect } from "vitest";
import {
  applyFrontmatterUpdates,
  parseFrontmatterValues,
  renderFrontmatter,
  splitFrontmatter,
  formatValue,
} from "../src/vault-frontmatter.js";

// Fixture deliberately mixes a comment, a nested mapping, a list, an inline
// array, a quoted wikilink and a body line that contains a colon.
const NOTE = [
  "---",
  "title: Lecture note",
  "# author comment",
  "tags: [lecture, maths]",
  "author:",
  "  name: Ana",
  "  course: ICRDC",
  "links:",
  "  - \"[[Lecture 1]]\"",
  "  - \"[[Lecture 2]]\"",
  "date: 2026-11-18",
  "---",
  "",
  "# Body",
  "some text: with a colon",
].join("\n");

function block(content: string) {
  const parsed = splitFrontmatter(content);
  if (!parsed) throw new Error("no frontmatter in fixture");
  return parsed;
}

describe("frontmatter editing", () => {
  it("finds the block and parses values", () => {
    const parsed = parseFrontmatterValues(block(NOTE).lines);
    expect(parsed.title).toBe("Lecture note");
    expect(parsed.tags).toBe("[lecture, maths]");
    expect(parsed.author).toEqual(["name: Ana", "course: ICRDC"]);
    expect(parsed.date).toBe("2026-11-18");
  });

  it("updates one key and leaves comments and nesting untouched", () => {
    const b = block(NOTE);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { title: "New title" }));
    expect(out).toContain("title: New title");
    expect(out).toContain("# author comment");
    expect(out).toContain("  name: Ana");
    expect(out).toContain("  - \"[[Lecture 2]]\"");
    expect(out).toContain("some text: with a colon");
    expect(out.split("\n").filter(l => l.startsWith("title:"))).toHaveLength(1);
  });

  it("removes a key together with its nested lines", () => {
    const b = block(NOTE);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { author: null }));
    expect(out).not.toContain("name: Ana");
    expect(out).not.toContain("course: ICRDC");
    expect(out).toContain("tags: [lecture, maths]");
    expect(out).toContain("  - \"[[Lecture 1]]\"");
  });

  it("quotes values that would break YAML", () => {
    const b = block(NOTE);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { title: "a: b", extra: "yes" }));
    expect(out).toContain('title: "a: b"');
    expect(out).toContain("extra: yes");
    expect(formatValue("2026-11-18")).toBe('"2026-11-18"');
  });

  it("keeps non-ASCII values byte for byte", () => {
    const b = block(NOTE);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { title: "Café résumé naïve" }));
    expect(out).toContain("title: Café résumé naïve");
  });

  it("creates a block for files without one", () => {
    const parsed = splitFrontmatter("# body only\n");
    expect(parsed).toBeNull();
  });

  it("round-trips CRLF files without changing line endings", () => {
    const crlf = NOTE.replace(/\n/g, "\r\n");
    const b = block(crlf);
    const out = renderFrontmatter(b, applyFrontmatterUpdates(b, { title: "X" }));
    expect(out.split("\r\n").length).toBeGreaterThan(1);
    expect(out).not.toMatch(/(^|[^\r])\n# Body/);
  });
});
