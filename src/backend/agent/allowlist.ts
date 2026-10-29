/**
 * Prefix allowlist for the "auto-safe" approval mode.
 *
 * A command is safe only when it starts with one of the allowed prefixes,
 * passes no shell metacharacters that could smuggle a second command, and
 * runs nothing interactive. This is a UX convenience, not a security
 * boundary; "ask first" is the default mode.
 */

// Characters that let one command hide another or redirect output. Any
// command containing one of these is never auto-approved.
const FORBIDDEN = /[;&|<>`$]/;

const DEFAULT_PREFIXES = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "pwd",
  "whoami",
  "id",
  "hostname",
  "uname",
  "date",
  "uptime",
  "df",
  "du",
  "free",
  "ps",
  "top -b",
  "lscpu",
  "lsblk",
  "stat",
  "file",
  "wc",
  "which",
  "whereis",
  "env",
  "printenv",
  "netstat",
  "ss",
  "ip a",
  "ip addr",
  "ip route",
  "ifconfig",
  "mount",
  "systemctl status",
  "systemctl list",
  "systemctl is-active",
  "systemctl is-enabled",
  "journalctl",
  "dmesg",
  "docker ps",
  "docker images",
  "docker inspect",
  "docker stats",
  "docker logs",
  "docker version",
  "kubectl get",
  "kubectl describe",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "curl --head",
  "ping -c",
  "dig",
  "nslookup",
  "echo",
];

export interface Allowlist {
  prefixes: string[];
}

export function parseAllowlist(raw: string | undefined | null): Allowlist {
  const source = raw && raw.trim() ? raw : DEFAULT_PREFIXES.join("\n");
  const prefixes = source
    .split(/\r?\n|,/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return { prefixes };
}

/**
 * True when the command starts with an allowed prefix and carries no shell
 * metacharacter that could turn the tail of the command into something else.
 */
export function isCommandSafe(command: string, allowlist: Allowlist): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) return false;
  if (FORBIDDEN.test(trimmed)) return false;
  return allowlist.prefixes.some((prefix) => {
    if (trimmed === prefix) return true;
    if (!trimmed.startsWith(prefix)) return false;
    // "ps" must not match "psql_drop_db"; the next character has to be a
    // separator (or nothing) for the prefix to count.
    const next = trimmed.charAt(prefix.length);
    return next === " " || next === "\t" || next === "-" || next === "=";
  });
}

export function defaultAllowlistText(): string {
  return DEFAULT_PREFIXES.join("\n");
}
