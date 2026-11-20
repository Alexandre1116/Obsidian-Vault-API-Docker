import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCAN_LIMITS,
  isIgnoredPath,
  shouldScanContent,
  looksLikeText,
  classifyExtension,
  signRawToken,
  verifyRawToken,
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

    const slides = shouldScanContent("deck.apresentacao.oslides", 34 * 1024 * 1024, DEFAULT_SCAN_LIMITS);
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
    expect(looksLikeText(Buffer.from("# Título\nlinha com acentuação\n", "utf-8"))).toBe(true);
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
