import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCAN_LIMITS,
  isIgnoredPath,
  shouldScanContent,
  looksLikeText,
  classifyExtension,
  signRawToken,
  verifyRawToken,
  validateBase64Payload,
  formatMegabytes,
} from "../src/vault-policy.js";

describe("metadata and media filtering", () => {
  it("ignores Synology and Obsidian metadata paths", () => {
    expect(isIgnoredPath("My Drive/@eaDir/note.md.md")).toBe(true);
    expect(isIgnoredPath("#recycle/old.md")).toBe(true);
    expect(isIgnoredPath("vault/.obsidian/workspace.json")).toBe(true);
    expect(isIgnoredPath("notes/sub/.git/config")).toBe(true);
    expect(isIgnoredPath("notes/real-note.md")).toBe(false);
  });

  it("never opens known binary or oversize files", () => {
    const iso = shouldScanContent("course/SERVER_EVAL_x64FRE_en-us.iso", 4.8 * 1024 * 1024 * 1024, DEFAULT_SCAN_LIMITS);
    expect(iso.scan).toBe(false);
    expect(["binary", "too_large"]).toContain(iso.reason);

    const bigMd = shouldScanContent("notes/huge.md", 40 * 1024 * 1024, DEFAULT_SCAN_LIMITS);
    expect(bigMd.scan).toBe(false);
    expect(bigMd.reason).toBe("too_large");

    const slides = shouldScanContent("deck.presentation.oslides", 34 * 1024 * 1024, DEFAULT_SCAN_LIMITS);
    expect(slides.scan).toBe(false);

    expect(shouldScanContent("notes/ok.md", 1024, DEFAULT_SCAN_LIMITS).scan).toBe(true);
  });

  it("classifies Office and OpenDocument containers as binary", () => {
    expect(classifyExtension("a.pdf")).toBe("binary");
    expect(classifyExtension("a.odp")).toBe("binary");
    expect(classifyExtension("a.oslides")).toBe("binary");
    expect(classifyExtension("a.blend")).toBe("binary");
    expect(classifyExtension("a.pcapng")).toBe("binary");
    expect(classifyExtension("a.md")).toBe("text");
    expect(classifyExtension("a.png")).toBe("image");
    expect(classifyExtension("notes-without-extension")).toBe("unknown");
  });

  it("sniffs text versus binary", () => {
    // Non-ASCII on purpose: high UTF-8 bytes must still count as text.
    expect(looksLikeText(Buffer.from("# Title\nline with accents: café naïve\n", "utf-8"))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x01, 0x02, 0x4d, 0x5a]))).toBe(false);
  });
});

describe("signed /raw tokens", () => {
  const key = "a".repeat(48);

  it("accepts a token for the same path and rejects another path", () => {
    const token = signRawToken(key, "notes/img.png");
    expect(verifyRawToken(key, "notes/img.png", token)).toBe(true);
    expect(verifyRawToken(key, "notes/private.png", token)).toBe(false);
  });

  it("rejects expired and tampered tokens", () => {
    const expired = signRawToken(key, "notes/img.png", -1000);
    expect(verifyRawToken(key, "notes/img.png", expired)).toBe(false);

    const token = signRawToken(key, "notes/img.png");
    const [, sig] = token.split(".");
    expect(verifyRawToken(key, "notes/img.png", `9999999999.${sig}`)).toBe(false);
    expect(verifyRawToken(key, "notes/img.png", null)).toBe(false);
    expect(verifyRawToken("", "notes/img.png", token)).toBe(false);
  });
});

describe("validateBase64Payload", () => {
  const LIMIT = 64;

  it("accepts a well-formed payload and reports the decoded size", () => {
    const payload = Buffer.from("hello vault").toString("base64");
    expect(validateBase64Payload(payload, LIMIT)).toEqual({ ok: true, estimatedBytes: 11 });
    expect(Buffer.from(payload, "base64").length).toBe(11);
  });

  it("rejects whitespace, which Buffer.from would quietly ignore", () => {
    const payload = Buffer.from("hello vault").toString("base64");
    expect(validateBase64Payload(payload.slice(0, 4) + "\n" + payload.slice(4), LIMIT).ok).toBe(false);
  });

  it("rejects a non-alphabet string, bad padding and a bad length", () => {
    for (const bad of ["!!!!", "a===", "abc", "a".repeat(10) + "_" + "a".repeat(13)]) {
      expect(validateBase64Payload(bad, LIMIT).ok, bad).toBe(false);
    }
  });

  it("rejects an oversized payload before it is decoded", () => {
    const check = validateBase64Payload(Buffer.alloc(LIMIT + 2, 0x41).toString("base64"), LIMIT);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/too large .*limit 64 B|too large/);
  });
});

describe("formatMegabytes", () => {
  it("uses KB for sub-megabyte limits and MB above them", () => {
    expect(formatMegabytes(64 * 1024)).toBe("64 KB");
    expect(formatMegabytes(256 * 1024)).toBe("256 KB");
    expect(formatMegabytes(4 * 1024 * 1024)).toBe("4.0 MB");
  });
});
