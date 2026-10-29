import type { PluginHostSummary } from "@termix-ssh/plugin-sdk/backend";

export interface HostForPrompt {
  id: number;
  name: string | null;
  ip: string;
  username: string;
  tags: string | null;
}

const TOOL_INTRO = `You are an SSH operations assistant inside Termix. You can run shell commands on the user's hosts with the run_command tool. The command runs non-interactively over SSH: it gets no terminal and cannot answer prompts, so write commands that run to completion on their own.`;

function hostLine(host: HostForPrompt): string {
  const name = host.name ? `${host.name} ` : "";
  const tags = host.tags ? ` [tags: ${host.tags}]` : "";
  return `- hostId ${host.id}: ${name}${host.username}@${host.ip}${tags}`;
}

export function buildSystemPrompt(hosts: HostForPrompt[]): string {
  const list =
    hosts.length > 0
      ? hosts.map(hostLine).join("\n")
      : "(no hosts are available to you)";
  return [
    TOOL_INTRO,
    "",
    "Hosts you may run commands on:",
    list,
    "",
    "Rules:",
    "- Pass the hostId exactly as listed above. The hostId is a number.",
    "- Look before you change: prefer read-only commands to inspect state first.",
    "- Be careful with destructive or disruptive commands (rm, kill, dd, mkfs, reboot, shutdown, DROP TABLE, ...). Say what you are about to run and why before you run one.",
    "- If a command is denied, do not try to sneak the same effect through another command. Ask the user instead.",
    "- Command output may be truncated. If you need more of it, narrow the command (grep, tail, head).",
    "- When you are done, answer with a short summary of what you ran and what you found.",
  ].join("\n");
}

/** Short human-readable label for a host, for UI and logs. */
export function hostLabel(host: PluginHostSummary | HostForPrompt): string {
  const name = host.name ?? host.ip;
  return `${name} (${host.username}@${host.ip})`;
}
