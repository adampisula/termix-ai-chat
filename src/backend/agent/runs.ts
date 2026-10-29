import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type {
  AgentMessage,
  ProviderAdapter,
  ReasoningEffort,
} from "../providers/types.js";
import { buildSystemPrompt } from "./prompt.js";
import type { ApprovalRegistry } from "./approvals.js";
import type { CommandResult, ExecutorLimits, SshExecFn } from "./executor.js";
import { executeCommand } from "./executor.js";
import { isCommandSafe } from "./allowlist.js";

export type RunStatus =
  "running" | "waiting-approval" | "done" | "error" | "cancelled";

export interface RunEvent {
  type:
    | "status"
    | "text"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "approval_request"
    | "approval_resolved"
    | "error"
    | "done";
  [key: string]: unknown;
}

export interface HostInfo {
  id: number;
  name: string | null;
  ip: string;
  username: string;
  tags: string | null;
}

export interface ChatRecordLike {
  id: number;
  userId: string;
  title?: string;
  approvalMode: string;
}

export interface MessageParts {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ id: string; hostId: number; command: string }>;
  toolCallId?: string;
  hostId?: number;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  truncated?: boolean;
  timedOut?: boolean;
  denied?: boolean;
  error?: string;
}

export interface StoredMessage {
  seq: number;
  role: string;
  parts: MessageParts;
}

export interface MessageStore {
  append(
    chatId: number,
    userId: string,
    role: string,
    parts: MessageParts,
  ): Promise<void>;
  list(chatId: number): Promise<StoredMessage[]>;
}

export interface RunDeps {
  provider: ProviderAdapter;
  providerConfig: {
    model: string;
    apiKey: string;
    baseUrl: string;
    effort: ReasoningEffort;
  };
  hosts: HostInfo[];
  limits: ExecutorLimits & { maxTurnsPerRun: number };
  allowlist: { prefixes: string[] };
  approvalTimeoutMs: number;
  approvals: ApprovalRegistry;
  sshExec: SshExecFn;
  store: MessageStore;
  isCancelled: () => boolean;
  /** Aborted with the run; forwarded to the provider call. */
  signal?: AbortSignal;
}

export interface RunHandle {
  id: string;
  chatId: number;
  userId: string;
  status: RunStatus;
  lastError: string | null;
  subscribe: (listener: (event: RunEvent) => void) => () => void;
  promise: Promise<void>;
}

type Listener = (event: RunEvent) => void;

/**
 * Runs one agent turn: send the conversation to the provider, stream its
 * answer, run the commands it asks for (gating them per the chat's approval
 * mode) and feed the results back until it answers without tool calls.
 *
 * The loop never throws. Every failure is an emitted error event and a
 * terminal run status.
 */
export async function runAgentTurn(
  runId: string,
  chat: ChatRecordLike,
  userText: string,
  ctx: PluginContext,
  deps: RunDeps,
): Promise<RunHandle> {
  const listeners = new Set<Listener>();
  const emit = (event: RunEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        listeners.delete(listener);
      }
    }
  };

  let status: RunStatus = "running";
  let lastError: string | null = null;
  const setStatus = (next: RunStatus) => {
    status = next;
    emit({ type: "status", status: next });
  };

  const handle: RunHandle = {
    id: runId,
    chatId: chat.id,
    userId: chat.userId,
    get status() {
      return status;
    },
    get lastError() {
      return lastError;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "status", status });
      return () => listeners.delete(listener);
    },
    promise: undefined as unknown as Promise<void>,
  };

  // The user message is persisted before the run handle is returned, so a
  // 201 response implies it is stored.
  await deps.store.append(chat.id, chat.userId, "user", { text: userText });

  handle.promise = (async () => {
    try {
      let turns = 0;
      while (true) {
        if (deps.isCancelled()) {
          setStatus("cancelled");
          emit({ type: "done" });
          return;
        }
        turns += 1;
        if (turns > deps.limits.maxTurnsPerRun) {
          await deps.store.append(chat.id, chat.userId, "user", {
            text: `The agent stopped: it hit the limit of ${deps.limits.maxTurnsPerRun} steps per message.`,
          });
          emit({
            type: "error",
            message: `Reached the limit of ${deps.limits.maxTurnsPerRun} steps per message.`,
          });
          setStatus("done");
          emit({ type: "done" });
          return;
        }

        const history = await loadConversation(deps.store, chat.id);
        const result = await deps.provider.stream(
          {
            model: deps.providerConfig.model,
            apiKey: deps.providerConfig.apiKey,
            baseUrl: deps.providerConfig.baseUrl,
            system: buildSystemPrompt(deps.hosts),
            messages: history,
            effort: deps.providerConfig.effort,
            signal: deps.signal,
          },
          {
            onText: (delta) => emit({ type: "text", delta }),
            onThinking: (delta) => emit({ type: "thinking", delta }),
          },
        );

        await deps.store.append(chat.id, chat.userId, "assistant", {
          text: result.text,
          thinking: result.thinking,
          toolCalls: result.toolCalls.map((call) => ({
            id: call.id,
            hostId: call.hostId,
            command: call.command,
          })),
        });

        if (result.toolCalls.length === 0) {
          setStatus("done");
          emit({ type: "done" });
          return;
        }

        for (const call of result.toolCalls) {
          if (deps.isCancelled()) {
            setStatus("cancelled");
            emit({ type: "done" });
            return;
          }
          await runToolCall(runId, chat, call, ctx, deps, emit, setStatus);
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message: lastError });
      setStatus("error");
      emit({ type: "done" });
    }
  })();

  return handle;
}

async function loadConversation(
  store: MessageStore,
  chatId: number,
): Promise<AgentMessage[]> {
  const rows = await store.list(chatId);
  const messages: AgentMessage[] = [];
  for (const row of rows) {
    const parts = row.parts;
    if (row.role === "user") {
      if (parts.text) messages.push({ role: "user", text: parts.text });
    } else if (row.role === "assistant") {
      messages.push({
        role: "assistant",
        text: parts.text ?? "",
        toolCalls: (parts.toolCalls ?? []).map((call) => ({
          id: call.id,
          hostId: call.hostId,
          command: call.command,
        })),
        thinking: parts.thinking,
      });
    } else if (row.role === "tool") {
      messages.push({
        role: "tool",
        toolCallId: parts.toolCallId ?? "",
        text: formatToolResultText(parts),
      });
    }
  }
  return messages;
}

function formatToolResultText(parts: MessageParts): string {
  if (parts.denied) return "The user denied this command.";
  if (parts.error) return `ERROR: ${parts.error}`;
  const sections: string[] = [];
  if (parts.timedOut) sections.push("The command timed out and was killed.");
  sections.push(`stdout:\n${parts.stdout || "(no stdout)"}`);
  if (parts.stderr?.trim()) sections.push(`stderr:\n${parts.stderr}`);
  sections.push(`exit code: ${parts.exitCode ?? "killed"}`);
  if (parts.truncated) sections.push("Output was truncated.");
  return sections.join("\n\n");
}

async function runToolCall(
  runId: string,
  chat: ChatRecordLike,
  call: { id: string; hostId: number; command: string },
  ctx: PluginContext,
  deps: RunDeps,
  emit: (event: RunEvent) => void,
  setStatus: (status: RunStatus) => void,
): Promise<void> {
  emit({
    type: "tool_call",
    toolCallId: call.id,
    hostId: call.hostId,
    command: call.command,
  });

  let decision: "approved" | "denied" = "approved";
  let auto = false;
  if (chat.approvalMode === "auto") {
    auto = true;
  } else if (chat.approvalMode === "auto-safe") {
    auto = isCommandSafe(call.command, deps.allowlist);
  }

  if (!auto) {
    setStatus("waiting-approval");
    emit({
      type: "approval_request",
      toolCallId: call.id,
      hostId: call.hostId,
      command: call.command,
    });
    decision = await deps.approvals.wait(
      runId,
      call.id,
      deps.approvalTimeoutMs,
      () => {
        emit({
          type: "approval_resolved",
          toolCallId: call.id,
          decision: "denied",
          timeout: true,
        });
      },
    );
    emit({ type: "approval_resolved", toolCallId: call.id, decision });
    setStatus("running");
  }

  let result: CommandResult;
  if (decision === "denied") {
    result = {
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      timedOut: false,
    };
    await deps.store.append(chat.id, chat.userId, "tool", {
      toolCallId: call.id,
      hostId: call.hostId,
      command: call.command,
      denied: true,
    });
  } else {
    result = await executeCommand(
      ctx,
      call.hostId,
      call.command,
      deps.limits,
      deps.sshExec,
    );
    await deps.store.append(chat.id, chat.userId, "tool", {
      toolCallId: call.id,
      hostId: call.hostId,
      command: call.command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
      timedOut: result.timedOut,
      error: result.error,
    });
  }

  emit({
    type: "tool_result",
    toolCallId: call.id,
    denied: decision === "denied",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
    error: result.error,
  });
}
