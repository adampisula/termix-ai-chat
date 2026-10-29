import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { SshExecFn } from "./executor.js";

export interface RawExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Builds the command runner for the agent.
 *
 * Newer Termix builds expose ctx.ssh.exec, which caps output and enforces the
 * timeout for us. Older ones (26.10 in particular) do not, and calling it
 * throws "ctx.ssh.exec is not a function" — so probe for it and fall back to
 * opening a connection and running the command over the ssh2 client's own
 * exec channel, which every Termix build serves.
 */
export function createSshExecFn(ctx: PluginContext): SshExecFn {
  if (typeof (ctx.ssh as { exec?: unknown }).exec === "function") {
    return (hostId, command, options) => ctx.ssh.exec(hostId, command, options);
  }
  return async (hostId, command, options) => {
    const { client, dispose } = await ctx.ssh.connect<ExecClient>(hostId, {
      purpose: "agent-chat",
      profile: "background",
    });
    try {
      return await execOverClient(client, command, options);
    } finally {
      dispose();
    }
  };
}

export interface ExecClient {
  exec: (
    command: string,
    callback: (err: Error | undefined, stream: ExecStream | undefined) => void,
  ) => void;
}

interface ExecStream {
  close: () => void;
  on: (event: string, listener: (chunk: unknown) => void) => void;
  stderr: {
    on: (event: string, listener: (chunk: unknown) => void) => void;
  };
}

/**
 * Runs one command over an ssh2 client, streaming stdout and stderr, capped
 * per stream, with the whole command killed at the timeout. Never rejects:
 * every failure resolves as a result the caller can report.
 */
export function execOverClient(
  client: ExecClient,
  command: string,
  options: { timeoutMs: number; maxOutputBytes: number },
): Promise<RawExecResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stream: ExecStream | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let exitCode: number | null = null;

    const finish = (result: RawExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        stream?.close();
      } catch {
        // The channel may already be gone.
      }
      finish({ stdout, stderr, code: null, truncated, timedOut });
    }, options.timeoutMs);

    client.exec(command, (err, opened) => {
      if (settled) return;
      if (err || !opened) {
        finish({
          stdout: "",
          stderr: err
            ? String(err.message ?? err)
            : "Could not open a command channel.",
          code: null,
          truncated: false,
          timedOut: false,
        });
        return;
      }
      stream = opened;
      opened.on("data", (chunk: unknown) => {
        const text = String(chunk);
        stdoutBytes += text.length;
        if (stdoutBytes <= options.maxOutputBytes) {
          stdout += text;
        } else {
          truncated = true;
        }
      });
      opened.stderr.on("data", (chunk: unknown) => {
        const text = String(chunk);
        stderrBytes += text.length;
        if (stderrBytes <= options.maxOutputBytes) {
          stderr += text;
        } else {
          truncated = true;
        }
      });
      opened.on("exit", (code: unknown) => {
        exitCode = typeof code === "number" ? code : null;
      });
      opened.on("close", () => {
        finish({ stdout, stderr, code: exitCode, truncated, timedOut });
      });
      opened.on("error", (error: unknown) => {
        stderr += `${stderr ? "\n" : ""}stream error: ${String(
          error instanceof Error ? error.message : error,
        )}`;
      });
    });
  });
}
