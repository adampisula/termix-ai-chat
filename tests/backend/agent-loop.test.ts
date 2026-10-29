import { describe, expect, it } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { ApprovalRegistry } from "../../src/backend/agent/approvals.js";
import { executeCommand } from "../../src/backend/agent/executor.js";
import {
  runAgentTurn,
  type MessageStore,
  type MessageParts,
} from "../../src/backend/agent/runs.js";
import type {
  ProviderAdapter,
  ProviderTurnResult,
  StreamHandlers,
  ToolCallSpec,
} from "../../src/backend/providers/types.js";

const ctx = {
  hosts: {
    checkAccess: async (hostId: number) =>
      hostId === 1
        ? { hasAccess: true, isOwner: true, isShared: false }
        : { hasAccess: false, isOwner: false, isShared: false },
  },
  audit: { record: async () => {} },
} as unknown as PluginContext;

const LIMITS = { timeoutMs: 5000, maxOutputChars: 500, maxTurnsPerRun: 5 };

function makeStore() {
  const rows: Array<{ chatId: number; role: string; parts: MessageParts }> = [];
  const store: MessageStore = {
    async append(chatId, _userId, role, parts) {
      rows.push({ chatId, role, parts });
    },
    async list(chatId) {
      return rows
        .filter((row) => row.chatId === chatId)
        .map((row, index) => ({
          seq: index,
          role: row.role,
          parts: row.parts,
        }));
    },
  };
  return { rows, store };
}

interface ScriptedTurn {
  text?: string;
  toolCalls?: ToolCallSpec[];
}

function scriptedProvider(
  turns: ScriptedTurn[],
): ProviderAdapter & { requests: unknown[] } {
  let index = 0;
  const requests: unknown[] = [];
  return {
    id: "openrouter",
    defaultBaseUrl: "",
    requests,
    async stream(
      request,
      handlers: StreamHandlers,
    ): Promise<ProviderTurnResult> {
      requests.push(request);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (turn.text) handlers.onText(turn.text);
      return {
        text: turn.text ?? "",
        toolCalls: turn.toolCalls ?? [],
      };
    },
    async listModels() {
      return [];
    },
  };
}

function sshExec(results: Array<Partial<{ stdout: string; code: number }>>) {
  let index = 0;
  const calls: Array<{ hostId: number; command: string; options: unknown }> =
    [];
  const fn = async (hostId: number, command: string, options: unknown) => {
    calls.push({ hostId, command, options });
    const result = results[Math.min(index, results.length - 1)] ?? {};
    index += 1;
    return {
      stdout: "",
      stderr: "",
      code: 0,
      truncated: false,
      timedOut: false,
      ...result,
    };
  };
  return { calls, fn };
}

describe("runAgentTurn", () => {
  it("answers directly when the model uses no tools", async () => {
    const { rows, store } = makeStore();
    const provider = scriptedProvider([{ text: "Hello there." }]);
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([]);

    const handle = await runAgentTurn(
      "r1",
      { id: 1, userId: "u1", approvalMode: "ask" },
      "hi",
      ctx,
      {
        provider,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [],
        limits: LIMITS,
        allowlist: { prefixes: [] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );
    await handle.promise;

    expect(handle.status).toBe("done");
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[1].parts.text).toBe("Hello there.");
  });

  it("runs an approved command and feeds the output back", async () => {
    const { rows, store } = makeStore();
    const provider = scriptedProvider([
      { toolCalls: [{ id: "t1", hostId: 1, command: "ls -la" }] },
      { text: "Found 3 files." },
    ]);
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([{ stdout: "file1\nfile2\nfile3", code: 0 }]);

    const handle = await runAgentTurn(
      "r2",
      { id: 1, userId: "u1", approvalMode: "ask" },
      "list files",
      ctx,
      {
        provider,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [
          { id: 1, name: "web", ip: "10.0.0.1", username: "root", tags: null },
        ],
        limits: LIMITS,
        allowlist: { prefixes: [] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );

    // Wait for the approval request, then approve.
    await new Promise<void>((resolve) => {
      const unsub = handle.subscribe((event) => {
        if (event.type === "approval_request") resolve();
      });
      void unsub;
    });
    expect(approvals.resolve("r2", "t1", "approved")).toBe(true);
    await handle.promise;

    const roles = rows.map((row) => row.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(rows[2].parts).toMatchObject({
      toolCallId: "t1",
      stdout: "file1\nfile2\nfile3",
      exitCode: 0,
    });
    expect(ssh.calls[0]).toMatchObject({ hostId: 1, command: "ls -la" });
    expect(ssh.calls[0].options).toMatchObject({ timeoutMs: 5000 });
    // The second provider call saw the tool result.
    const secondRequest = (
      provider.requests as Array<{
        messages: Array<{ role: string; text?: string }>;
      }>
    )[1];
    expect(secondRequest.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "t1",
    });
  });

  it("marks denied commands and tells the model", async () => {
    const { rows, store } = makeStore();
    const provider = scriptedProvider([
      { toolCalls: [{ id: "t1", hostId: 1, command: "reboot" }] },
      { text: "Understood, not rebooting." },
    ]);
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([]);

    const handle = await runAgentTurn(
      "r3",
      { id: 1, userId: "u1", approvalMode: "ask" },
      "reboot",
      ctx,
      {
        provider,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [],
        limits: LIMITS,
        allowlist: { prefixes: [] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );
    await new Promise<void>((resolve) => {
      const unsub = handle.subscribe((event) => {
        if (event.type === "approval_request") resolve();
      });
      void unsub;
    });
    approvals.resolve("r3", "t1", "denied");
    await handle.promise;

    expect(ssh.calls).toHaveLength(0);
    expect(rows[2].parts.denied).toBe(true);
    const secondRequest = (
      provider.requests as Array<{
        messages: Array<{ role: string; text?: string }>;
      }>
    )[1];
    expect(secondRequest.messages.at(-1)?.text).toBe(
      "The user denied this command.",
    );
  });

  it("auto-approves safe commands without pausing", async () => {
    const { rows, store } = makeStore();
    const provider = scriptedProvider([
      { toolCalls: [{ id: "t1", hostId: 1, command: "ls -la" }] },
      { text: "done" },
    ]);
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([{ stdout: "out", code: 0 }]);

    const handle = await runAgentTurn(
      "r4",
      { id: 1, userId: "u1", approvalMode: "auto-safe" },
      "go",
      ctx,
      {
        provider,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [],
        limits: LIMITS,
        allowlist: { prefixes: ["ls"] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );
    await handle.promise;

    expect(ssh.calls).toHaveLength(1);
    expect(rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("pauses on unsafe commands even in auto-safe mode", async () => {
    const { store } = makeStore();
    const provider = scriptedProvider([
      { toolCalls: [{ id: "t1", hostId: 1, command: "rm -rf /tmp/x" }] },
      { text: "stopped" },
    ]);
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([]);

    const handle = await runAgentTurn(
      "r5",
      { id: 1, userId: "u1", approvalMode: "auto-safe" },
      "go",
      ctx,
      {
        provider,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [],
        limits: LIMITS,
        allowlist: { prefixes: ["ls"] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );
    await new Promise<void>((resolve) => {
      const unsub = handle.subscribe((event) => {
        if (event.type === "approval_request") resolve();
      });
      void unsub;
    });
    expect(ssh.calls).toHaveLength(0);
    approvals.resolve("r5", "t1", "denied");
    await handle.promise;
    expect(handle.status).toBe("done");
  });

  it("reports host access failures as tool results instead of throwing", async () => {
    const { rows, store } = makeStore();
    const provider = scriptedProvider([
      { toolCalls: [{ id: "t1", hostId: 99, command: "ls" }] },
      { text: "Cannot reach that host." },
    ]);
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([]);

    const handle = await runAgentTurn(
      "r6",
      { id: 1, userId: "u1", approvalMode: "auto" },
      "go",
      ctx,
      {
        provider,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [],
        limits: LIMITS,
        allowlist: { prefixes: [] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );
    await handle.promise;

    expect(rows[2].parts.error).toContain("No connect access");
  });

  it("stops at the turn limit", async () => {
    const { rows, store } = makeStore();
    const provider = scriptedProvider([
      { toolCalls: [{ id: "t1", hostId: 1, command: "yes" }] },
    ]);
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([{ stdout: "y", code: 0 }]);

    const handle = await runAgentTurn(
      "r7",
      { id: 1, userId: "u1", approvalMode: "auto" },
      "go",
      ctx,
      {
        provider,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [],
        limits: { ...LIMITS, maxTurnsPerRun: 3 },
        allowlist: { prefixes: [] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );
    await handle.promise;

    expect(handle.status).toBe("done");
    expect(ssh.calls).toHaveLength(3);
    expect(rows.at(-1)?.parts.text).toContain("limit of 3 steps");
  });

  it("marks the run errored when the provider fails", async () => {
    const { store } = makeStore();
    const failing: ProviderAdapter = {
      id: "openrouter",
      defaultBaseUrl: "",
      stream: async () => {
        throw new Error("provider down");
      },
      listModels: async () => [],
    };
    const approvals = new ApprovalRegistry();
    const ssh = sshExec([]);

    const handle = await runAgentTurn(
      "r8",
      { id: 1, userId: "u1", approvalMode: "ask" },
      "hi",
      ctx,
      {
        provider: failing,
        providerConfig: {
          model: "m",
          apiKey: "k",
          baseUrl: "",
          effort: "none",
        },
        hosts: [],
        limits: LIMITS,
        allowlist: { prefixes: [] },
        approvalTimeoutMs: 1000,
        approvals,
        makeSshExec: () => ssh.fn,
        store,
        isCancelled: () => false,
      },
    );
    await handle.promise;

    expect(handle.status).toBe("error");
    expect(handle.lastError).toBe("provider down");
  });
});

describe("ApprovalRegistry", () => {
  it("times out to a denial", async () => {
    const registry = new ApprovalRegistry();
    let timedOut = false;
    const decision = await registry.wait("r", "t", 10, () => {
      timedOut = true;
    });
    expect(decision).toBe("denied");
    expect(timedOut).toBe(true);
  });

  it("resolves before the timeout", async () => {
    const registry = new ApprovalRegistry();
    const wait = registry.wait("r", "t", 5000, () => {});
    registry.resolve("r", "t", "approved");
    await expect(wait).resolves.toBe("approved");
    expect(registry.isPending("r", "t")).toBe(false);
  });
});

describe("executeCommand", () => {
  it("clips oversized output", async () => {
    const long = "x".repeat(300);
    const result = await executeCommand(
      ctx,
      1,
      "cat big",
      { timeoutMs: 1000, maxOutputChars: 100 },
      async () => ({
        stdout: long,
        stderr: "",
        code: 0,
        truncated: true,
        timedOut: false,
      }),
    );
    expect(result.stdout.startsWith("x".repeat(100))).toBe(true);
    expect(result.stdout).toContain("[truncated]");
  });

  it("reports ssh failures as errors", async () => {
    const result = await executeCommand(
      ctx,
      1,
      "ls",
      { timeoutMs: 1000, maxOutputChars: 100 },
      async () => {
        throw new Error("connection refused");
      },
    );
    expect(result.error).toContain("connection refused");
    expect(result.exitCode).toBeNull();
  });
});
