/**
 * Command allowlist policy for `run_local_command`.
 *
 * The allowlist historically matched only the first token, while the command
 * was handed to `child_process.exec`, which runs `/bin/sh -c`. With a list like
 * `ls,grep`, the string `ls; rm -rf ~` passed the check and the shell then ran
 * `rm` too. A first-token list is only meaningful once chaining, substitution
 * and redirection are impossible, so both checks live here and are tested.
 */

// Operators that let one allowlisted token run a second, unchecked command, or
// write outside the intended arguments. Quoting does not help: the caller is an
// MCP client, not a human typing a quoted argument, so anything that changes
// the parse is rejected outright.
const FORBIDDEN_SEQUENCES: { token: string; why: string }[] = [
  { token: ";", why: "command chaining" },
  { token: "&&", why: "command chaining" },
  { token: "||", why: "command chaining" },
  { token: "|", why: "piping into another command" },
  { token: "&", why: "background execution or chaining" },
  { token: "`", why: "command substitution" },
  { token: "$(", why: "command substitution" },
  { token: "<(", why: "process substitution" },
  { token: ">(", why: "process substitution" },
  { token: ">", why: "output redirection" },
  { token: "<", why: "input redirection" },
  { token: "\n", why: "a second command line" },
  { token: "\r", why: "a second command line" },
];

/**
 * Returns a reason when the command string contains shell syntax that would let
 * it run more than the single checked command, or null when it is a plain
 * `program argument argument` invocation.
 */
export function findShellOperator(cmd: string): string | null {
  for (const { token, why } of FORBIDDEN_SEQUENCES) {
    if (cmd.includes(token)) return `'${token.replace(/\r|\n/, "\\n")}' (${why})`;
  }
  return null;
}

/**
 * Arguments that let an allowlisted program escape the vault directory. The
 * working directory is already the vault, so a vault-relative path is always
 * available; an absolute or parent-relative argument reaches the rest of the
 * container, including `/data/config.json` with the API key.
 *
 * This is not a complete jail: an allowlisted program keeps its own power
 * (`grep -f`, `pandoc --lua-filter`, `python -c`). List the smallest set of
 * programs you actually need.
 */
export function findUnsafeArgument(cmd: string): string | null {
  for (const token of cmd.trim().split(/\s+/).slice(1)) {
    if (token === "-" || token === "--") continue;
    if (
      token.startsWith("/") ||
      token.startsWith("~") ||
      token.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(token) ||
      token.split(/[/\\]/).includes("..")
    ) {
      return `'${token}' (outside the vault directory)`;
    }
    if (token.startsWith("-") && FORBIDDEN_FLAGS.some(flag => token.startsWith(flag))) {
      return `'${token}' (executes or deletes files by itself)`;
    }
  }
  return null;
}

// Program flags that turn a read-only helper into an executor or a deleter.
const FORBIDDEN_FLAGS = ["-exec", "-execdir", "-delete", "-ok"];

export function globMatch(pattern: string, cmd: string): boolean {
  if (pattern === "*") return true;
  const regexStr = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    + "$";
  return new RegExp(regexStr, "i").test(cmd.trim());
}

/**
 * Returns null when the command is allowed, or the reason it is blocked.
 *
 * A pattern is matched against the whole command first, then against the first
 * token. Prefer whole-command patterns (`pdftotext *`) over bare names (`pdftotext`):
 * a bare name allows any arguments at all.
 *
 * Shell operators are rejected only when a restrictive list is configured. With
 * `VAULT_API_ALLOWED_COMMANDS=*` there is no confinement to protect: the caller
 * may already run `bash -c ...`, so rejecting operators there would only break
 * legitimate pipelines without adding safety.
 */
export function isCommandAllowed(cmd: string, patterns: string): string | null {
  const unrestricted = !patterns || patterns.trim() === "*";
  if (unrestricted) return null;

  const operator = findShellOperator(cmd);
  if (operator) {
    return `the command contains ${operator}. With an allowlist configured, run_local_command accepts one program with arguments; chaining, substitution and redirection are blocked.`;
  }

  const argument = findUnsafeArgument(cmd);
  if (argument) {
    return `the command uses ${argument}. With an allowlist configured, arguments must stay inside the vault directory (the working directory is already the vault).`;
  }

  const firstToken = cmd.trim().split(/\s+/)[0] || "";
  for (const pattern of patterns.split(",")) {
    const p = pattern.trim();
    if (!p) continue;
    if (globMatch(p, cmd.trim()) || globMatch(p, firstToken)) return null;
  }
  return `'${firstToken}' is not in the allowed list. Allowed patterns: ${patterns}`;
}
