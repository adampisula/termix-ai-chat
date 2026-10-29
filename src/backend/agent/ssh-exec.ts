import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { SshExecFn } from "./executor.js";
import type { SshPromptRegistry } from "./ssh-prompts.js";

export interface RawExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
  timedOut: boolean;
}

export interface SshExecOptions {
  userId: string;
  runId: string;
  prompts: SshPromptRegistry;
  /** Streams a pending prompt question to the run's subscribers. */
  emit: (event: Record<string, unknown>) => void;
}

interface PromptRequest {
  kind: "totp" | "input" | "browser";
  prompt: string;
  echo?: boolean;
  isPush?: boolean;
  retry?: boolean;
}

/**
 * Builds the command runner for the agent.
 *
 * Commands run through ctx.ssh.withConnection over a plugin pool, so one
 * unlocked connection per user and host stays open for the session: an
 * encrypted key's passphrase is typed once, not once per command. Older
 * Termix builds have no withConnection (and some have no exec either), so the
 * builder probes for what exists and falls back down to a bare connect.
 *
 * The prompt channel routes keyboard-interactive prompts (passphrases,
 * passwords, TOTP) to the user through the run's event stream instead of
 * failing with "The SSH key is encrypted".
 */
export function createSshExecFn(
  ctx: PluginContext,
  opts: SshExecOptions,
): SshExecFn {
  // The host id in the answer cache matters, so each path wraps the channel
  // with the host it connects to.
  const withHost = (hostId: number) => ({
    ask: (request: PromptRequest) =>
      opts.prompts.ask({
        userId: opts.userId,
        runId: opts.runId,
        hostId,
        request,
        emit: opts.emit,
      }),
  });

  const ssh = ctx.ssh as unknown as {
    withConnection?: (
      host: number,
      options: Record<string, unknown> & { pool: string },
      fn: (client: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
    exec?: (
      host: number,
      command: string,
      options: Record<string, unknown>,
    ) => Promise<RawExecResult>;
    connect?: (
      host: number,
      options: Record<string, unknown>,
    ) => Promise<{ client: unknown; dispose: () => void }>;
  };

  if (typeof ssh.withConnection === "function") {
    return (hostId, command, options) =>
      ssh.withConnection!(
        hostId,
        {
          pool: "agent-chat-ssh",
          purpose: "agent-chat",
          profile: "background",
          prompt: withHost(hostId),
        },
        (client) => execOverClient(client as ExecClient, command, options),
      ) as Promise<RawExecResult>;
  }
  if (typeof ssh.exec === "function") {
    return (hostId, command, options) =>
      ssh.exec!(hostId, command, {
        purpose: "agent-chat",
        profile: "background",
        prompt: withHost(hostId),
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
  }
  return async (hostId, command, options) => {
    if (typeof ssh.connect !== "function") {
      return {
        stdout: "",
        stderr: "",
        code: null,
        truncated: false,
        timedOut: false,
      };
    }
    const { client, dispose } = await ssh.connect(hostId, {
      purpose: "agent-chat",
      profile: "background",
      prompt: withHost(hostId),
    });
    try {
      return await execOverClient(client as ExecClient, command, options);
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
