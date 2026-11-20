/**
 * Line-preserving frontmatter editing.
 *
 * A YAML round-trip would drop comments, block scalars, quotes and nesting, so
 * frontmatter is edited in place: only the lines of the keys being changed are
 * replaced, everything else in the block is copied through untouched.
 */

export interface FrontmatterBlock {
  /** Text before the opening delimiter (usually empty, may hold a BOM). */
  prefix: string;
  /** Inner lines of the frontmatter block, without the delimiters. */
  lines: string[];
  /** Body after the closing delimiter. */
  body: string;
  eol: string;
}

const KEY_LINE = /^([A-Za-z0-9_@\-.\u00C0-\u024F]+):(.*)$/;

export function splitFrontmatter(content: string): FrontmatterBlock | null {
  const prefix = content.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
  const rest = content.slice(prefix.length);
  const open = rest.match(/^---[ \t]*\r?\n/);
  if (!open) return null;

  const eol = rest.includes("\r\n") ? "\r\n" : "\n";
  const after = rest.slice(open[0].length);

  // The closing delimiter must be a line of its own.
  const closeIndex = after.search(/^---[ \t]*$/m);
  if (closeIndex === -1) return null;

  const rawBlock = after.slice(0, closeIndex);
  const trailing = after.slice(closeIndex);
  const body = trailing.replace(/^---[ \t]*\r?\n?/, "");

  return { prefix, lines: rawBlock.split(/\r?\n/), body, eol };
}

function isContinuation(line: string): boolean {
  if (/^\s/.test(line)) return true;      // indented value or nested mapping
  if (/^\s*[-+*]\s/.test(line)) return true; // list item at any indent
  return false;
}

function isBlockScalarHeader(value: string): boolean {
  return /^[|>][-+0-9]*\s*(#.*)?$/.test(value.trim());
}

interface KeySpan { key: string; start: number; end: number; }

/** Maps every top-level key in the block to the span of lines it owns. */
export function keySpans(lines: string[]): KeySpan[] {
  const spans: KeySpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const match = line.match(KEY_LINE);
    if (!match) continue;

    let end = i + 1;
    const value = match[2];
    const blockScalar = isBlockScalarHeader(value);
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() === "") {
        // Blank lines stay with the key only while a block scalar continues.
        if (blockScalar && end + 1 < lines.length && /^\s/.test(lines[end + 1])) { end++; continue; }
        break;
      }
      if (!isContinuation(next)) break;
      end++;
    }
    spans.push({ key: match[1], start: i, end });
    i = end - 1;
  }
  return spans;
}

const NEEDS_QUOTES = /(^$|^\s|\s$|[:#\[\]{}&*!|>'"%@`,]|^[-?]\s|^\d{4}-\d{2}-\d{2})/;

export function formatValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return '""';
  if (/^["'].*["']$/.test(trimmed)) return trimmed;
  if (NEEDS_QUOTES.test(trimmed) || trimmed.includes(": ")) {
    return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return trimmed;
}

/**
 * Applies key updates to a frontmatter block without rewriting untouched keys.
 * A null value removes the key and everything indented under it.
 */
export function applyFrontmatterUpdates(
  block: FrontmatterBlock,
  updates: Record<string, string | null>
): string[] {
  const lines = [...block.lines];
  const spans = keySpans(lines);
  const handled = new Set<string>();

  // Apply removals and replacements back to front so spans stay valid.
  const ordered = spans.slice().reverse();
  for (const span of ordered) {
    if (!(span.key in updates) || handled.has(span.key)) continue;
    handled.add(span.key);
    const value = updates[span.key];
    if (value === null) lines.splice(span.start, span.end - span.start);
    else lines.splice(span.start, span.end - span.start, `${span.key}: ${formatValue(value)}`);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (handled.has(key) || value === null) continue;
    if (!/^[A-Za-z0-9_@\-.\u00C0-\u024F]+$/.test(key)) continue;
    lines.push(`${key}: ${formatValue(value)}`);
  }

  return lines;
}

export function renderFrontmatter(block: FrontmatterBlock, lines: string[]): string {
  if (lines.length === 0) return block.prefix + block.body;
  return `${block.prefix}---${block.eol}${lines.join(block.eol)}${block.eol}---${block.eol}${block.body}`;
}

export function parseFrontmatterValues(lines: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const span of keySpans(lines)) {
    const raw = lines[span.start].match(KEY_LINE)?.[2] ?? "";
    const value = raw.trim();
    if (value === "" && span.end - span.start > 1) {
      values[span.key] = lines.slice(span.start + 1, span.end).map(l => l.trim());
    } else if (/^["'].*["']$/.test(value)) {
      values[span.key] = value.slice(1, -1);
    } else {
      values[span.key] = value.replace(/\s+#.*$/, "").trim();
    }
  }
  return values;
}
