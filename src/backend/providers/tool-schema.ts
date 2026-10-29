import type { ToolCallSpec } from "./types.js";

export const TOOL_NAME = "run_command";

export const TOOL_DESCRIPTION =
  "Run a shell command on one of the user's hosts and return its stdout, " +
  "stderr and exit code. The command runs non-interactively: it cannot ask " +
  "for input, so avoid commands that prompt.";

export const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    hostId: {
      type: "integer",
      description: "Id of the host to run the command on, from the host list.",
    },
    command: {
      type: "string",
      description: "The exact shell command to run.",
    },
  },
  required: ["hostId", "command"],
};

/** Parses a tool arguments JSON blob, tolerating malformed input. */
export function parseToolArguments(
  raw: string,
  fallbackId: string,
): ToolCallSpec | null {
  let parsed: { hostId?: unknown; command?: unknown };
  try {
    parsed = JSON.parse(raw) as { hostId?: unknown; command?: unknown };
  } catch {
    return null;
  }
  const hostId =
    typeof parsed.hostId === "number" ? parsed.hostId : Number(parsed.hostId);
  const command = typeof parsed.command === "string" ? parsed.command : "";
  if (!Number.isFinite(hostId) || hostId <= 0 || !command.trim()) return null;
  return { id: fallbackId, hostId: Math.trunc(hostId), command };
}
