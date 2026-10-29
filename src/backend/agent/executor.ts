import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  error?: string;
}

export interface ExecutorLimits {
  timeoutMs: number;
  maxOutputChars: number;
}

export type SshExecFn = (
  hostId: number,
  command: string,
  options: { timeoutMs: number; maxOutputBytes: number },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
}>;

/**
 * Runs one command on one host through Termix's SSH pipeline, enforcing the
 * acting user's connect access. Never throws: every failure becomes a result
 * the model can read.
 */
export async function executeCommand(
  ctx: PluginContext,
  hostId: number,
  command: string,
  limits: ExecutorLimits,
  sshExec: SshExecFn,
): Promise<CommandResult> {
  try {
    const access = await ctx.hosts.checkAccess(hostId, "connect");
    if (!access.hasAccess) {
      await ctx.audit.record({
        action: "plugin.ai-chat.command.denied",
        resourceType: "host",
        resourceId: String(hostId),
        details: truncateForLog(command),
        success: false,
        errorMessage: "user lacks connect access",
      });
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        truncated: false,
        timedOut: false,
        error: `No connect access to host ${hostId}.`,
      };
    }
  } catch {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      timedOut: false,
      error: `Host ${hostId} does not exist or is not reachable for you.`,
    };
  }

  try {
    const result = await sshExec(hostId, command, {
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: Math.max(limits.maxOutputChars * 4, 65536),
    });
    await ctx.audit.record({
      action: "plugin.ai-chat.command.run",
      resourceType: "host",
      resourceId: String(hostId),
      details: truncateForLog(command),
      success: result.code === 0,
      errorMessage:
        result.code === 0 ? undefined : `exit ${result.code ?? "killed"}`,
    });
    return {
      stdout: clip(result.stdout, limits.maxOutputChars),
      stderr: clip(result.stderr, limits.maxOutputChars),
      exitCode: result.code,
      truncated: result.truncated,
      timedOut: result.timedOut,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.audit.record({
      action: "plugin.ai-chat.command.run",
      resourceType: "host",
      resourceId: String(hostId),
      details: truncateForLog(command),
      success: false,
      errorMessage: message.slice(0, 300),
    });
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      timedOut: false,
      error: `Command failed to run: ${message}`,
    };
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated]`;
}

function truncateForLog(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
