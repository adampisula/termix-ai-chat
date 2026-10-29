import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  createSshExecFn,
  execOverClient,
  type ExecClient,
} from "../../src/backend/agent/ssh-exec.js";
import { SshPromptRegistry } from "../../src/backend/agent/ssh-prompts.js";

const LIMITS = { timeoutMs: 5000, maxOutputBytes: 1024 };

interface FakeStream extends EventEmitter {
  stderr: EventEmitter;
  closed: boolean;
  close: () => void;
}

function makeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.stderr = new EventEmitter();
  stream.closed = false;
  stream.close = () => {
    stream.closed = true;
  };
  return stream;
}

function makeClient(
  stream: FakeStream | null,
  openError?: Error,
): ExecClient & {
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    exec: (
      command: string,
      callback: (
        err: Error | undefined,
        stream: FakeStream | undefined,
      ) => void,
    ) => {
      commands.push(command);
      callback(openError, stream ?? undefined);
    },
  };
}

describe("execOverClient", () => {
  it("collects stdout, stderr and the exit code", async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const pending = execOverClient(client, "df -h", LIMITS);
    stream.emit("data", "disk usage\n");
    stream.stderr.emit("data", "warning\n");
    stream.emit("exit", 1);
    stream.emit("close");
    const result = await pending;
    expect(result).toEqual({
      stdout: "disk usage\n",
      stderr: "warning\n",
      code: 1,
      truncated: false,
      timedOut: false,
    });
  });

  it("runs the exact command", async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const pending = execOverClient(client, "ls -la /tmp", LIMITS);
    stream.emit("close");
    await pending;
    expect(client.commands).toEqual(["ls -la /tmp"]);
  });

  it("resolves with an error result when the channel cannot open", async () => {
    const client = makeClient(null, new Error("channel open failed"));
    const result = await execOverClient(client, "ls", LIMITS);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("channel open failed");
    expect(result.stdout).toBe("");
  });

  it("times out and closes the channel", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const client = makeClient(stream);
    const pending = execOverClient(client, "sleep 999", {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    stream.emit("data", "partial output");
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe("partial output");
    expect(stream.closed).toBe(true);
    vi.useRealTimers();
  });

  it("caps oversized output and flags truncation", async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const pending = execOverClient(client, "cat big", {
      timeoutMs: 5000,
      maxOutputBytes: 10,
    });
    stream.emit("data", "0123456789");
    stream.emit("data", "ABCDEFGHIJ");
    stream.emit("exit", 0);
    stream.emit("close");
    const result = await pending;
    expect(result.stdout).toBe("0123456789");
    expect(result.truncated).toBe(true);
  });
});

describe("createSshExecFn", () => {
  const registry = new SshPromptRegistry(60000);

  function makeCtx(overrides: Record<string, unknown>) {
    return { ssh: overrides } as unknown as PluginContext;
  }

  it("uses ctx.ssh.withConnection with the plugin pool when present", async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    let fn: ((c: unknown) => Promise<unknown>) | null = null;
    let poolOptions: Record<string, unknown> | null = null;
    const withConnection = vi.fn(
      (
        host: number,
        options: Record<string, unknown> & { pool: string },
        run: (c: unknown) => Promise<unknown>,
      ) => {
        poolOptions = options;
        fn = run;
        return run(client);
      },
    );
    const ctx = makeCtx({ withConnection });
    const run = createSshExecFn(ctx, {
      userId: "u1",
      runId: "r1",
      prompts: registry,
      emit: () => {},
    });
    const pending = run(3, "uname -a", LIMITS);
    await vi.waitFor(() => expect(client.commands).toHaveLength(1));
    stream.emit("data", "Linux");
    stream.emit("exit", 0);
    stream.emit("close");
    const result = (await pending) as { stdout: string; code: number | null };
    expect(withConnection).toHaveBeenCalledWith(
      3,
      expect.anything(),
      expect.any(Function),
    );
    expect((poolOptions as { pool: string }).pool).toBe("agent-chat-ssh");
    expect((poolOptions as { prompt: unknown }).prompt).toBeTruthy();
    expect(result.stdout).toBe("Linux");
    expect(result.code).toBe(0);
  });

  it("passes a prompt channel to ctx.ssh.exec when only exec exists", async () => {
    const exec = vi.fn(async () => ({
      stdout: "ok",
      stderr: "",
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const ctx = makeCtx({ exec });
    const fn = createSshExecFn(ctx, {
      userId: "u1",
      runId: "r1",
      prompts: registry,
      emit: () => {},
    });
    await fn(1, "ls", LIMITS);
    expect(exec).toHaveBeenCalledWith(
      1,
      "ls",
      expect.objectContaining({ prompt: expect.anything() }),
    );
  });

  it("asks for the passphrase and retries when the key is encrypted", async () => {
    const registry = new SshPromptRegistry(60000);
    const events: Record<string, unknown>[] = [];
    const options: Array<Record<string, unknown>> = [];
    let fail = true;
    const withConnection = vi.fn(
      (
        _host: number,
        opts: Record<string, unknown>,
        run: (c: unknown) => Promise<unknown>,
      ) => {
        options.push(opts);
        if (fail) {
          return Promise.reject(
            new Error(
              "SSH key is encrypted. Please enter the passphrase to unlock it.",
            ),
          );
        }
        const stream = makeStream();
        setTimeout(() => {
          stream.emit("data", "unlocked");
          stream.emit("exit", 0);
          stream.emit("close");
        }, 0);
        return run({
          exec: (
            _command: string,
            cb: (err: Error | undefined, opened?: FakeStream) => void,
          ) => cb(undefined, stream),
        });
      },
    );
    const ctx = makeCtx({ withConnection });
    const fn = createSshExecFn(ctx, {
      userId: "u1",
      runId: "r1",
      prompts: registry,
      emit: (e) => events.push(e),
    });

    const pending = fn(9, "echo ok", LIMITS);
    // The encrypted-key failure asks the user through the stream.
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "ssh_prompt")).toBe(true),
    );
    const promptEvent = events.find((e) => e.type === "ssh_prompt")!;
    expect(String(promptEvent.prompt)).toContain("passphrase");
    fail = false;
    registry.resolve("u1", String(promptEvent.promptId), "hunter2");
    const result = (await pending) as { stdout: string; code: number | null };
    expect(result.stdout).toBe("unlocked");
    expect(result.code).toBe(0);
    // The retry forced the passphrase into the connection.
    expect(options[1].overrides).toEqual({
      keyPassword: "hunter2",
      forceKeyboardInteractive: true,
    });
    // The answer is cached: a second command connects without asking again.
    const second = (await fn(9, "echo again", LIMITS)) as { stdout: string };
    expect(second.stdout).toBe("unlocked");
    expect(events.filter((e) => e.type === "ssh_prompt")).toHaveLength(1);
  });

  it("does not retry other connection errors", async () => {
    const withConnection = vi.fn(() =>
      Promise.reject(new Error("connection refused")),
    );
    const ctx = makeCtx({ withConnection });
    const fn = createSshExecFn(ctx, {
      userId: "u1",
      runId: "r1",
      prompts: registry,
      emit: () => {},
    });
    await expect(fn(9, "ls", LIMITS)).rejects.toThrow("connection refused");
    expect(withConnection).toHaveBeenCalledTimes(1);
  });

  it("falls back to connect and a raw channel when neither exists", async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const dispose = vi.fn();
    const connect = vi.fn(async () => ({ client, dispose }));
    const ctx = makeCtx({ connect });
    const fn = createSshExecFn(ctx, {
      userId: "u1",
      runId: "r1",
      prompts: registry,
      emit: () => {},
    });
    const pending = fn(7, "uname -a", LIMITS);
    // connect resolves asynchronously; wait until the channel is opened.
    await vi.waitFor(() => expect(client.commands).toHaveLength(1));
    stream.emit("data", "Linux");
    stream.emit("exit", 0);
    stream.emit("close");
    const result = await pending;
    expect(connect).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        purpose: "agent-chat",
        prompt: expect.anything(),
      }),
    );
    expect(result.stdout).toBe("Linux");
    expect(result.code).toBe(0);
    // The connection is always released.
    expect(dispose).toHaveBeenCalled();
  });

  it("releases the connection even when the channel fails to open", async () => {
    const client = makeClient(null, new Error("boom"));
    const dispose = vi.fn();
    const connect = vi.fn(async () => ({ client, dispose }));
    const ctx = makeCtx({ connect });
    const fn = createSshExecFn(ctx, {
      userId: "u1",
      runId: "r1",
      prompts: registry,
      emit: () => {},
    });
    const result = await fn(3, "ls", LIMITS);
    expect(result.stderr).toContain("boom");
    expect(dispose).toHaveBeenCalled();
  });
});

describe("SshPromptRegistry", () => {
  const base = {
    userId: "u1",
    runId: "r1",
    hostId: 5,
    request: {
      kind: "input" as const,
      prompt: "Enter passphrase for key:",
      echo: false,
    },
  };

  it("asks, is answered and remembers the answer", async () => {
    const registry = new SshPromptRegistry(60000);
    const events: Record<string, unknown>[] = [];
    const pending = registry.ask({ ...base, emit: (e) => events.push(e) });
    registry.resolve("u1", String(events[0].promptId), "secret");
    await expect(pending).resolves.toBe("secret");
    // A second ask for the same prompt is answered from the cache.
    const again = registry.ask({
      ...base,
      runId: "r2",
      emit: () => {},
    });
    await expect(again).resolves.toBe("secret");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ssh_prompt",
      kind: "input",
      echo: false,
    });
  });

  it("never caches TOTP codes", async () => {
    const registry = new SshPromptRegistry(60000);
    const events: Record<string, unknown>[] = [];
    const first = registry.ask({
      ...base,
      request: { kind: "totp", prompt: "Verification code:", retry: false },
      emit: (e) => events.push(e),
    });
    registry.resolve("u1", String(events[0].promptId), "123456");
    await expect(first).resolves.toBe("123456");
    let asked = 0;
    registry.ask({
      ...base,
      request: { kind: "totp", prompt: "Verification code:", retry: false },
      emit: () => asked++,
    });
    expect(asked).toBe(1);
  });

  it("gives up on timeout", async () => {
    vi.useFakeTimers();
    const registry = new SshPromptRegistry(1000);
    const events: Record<string, unknown>[] = [];
    const pending = registry.ask({ ...base, emit: (e) => events.push(e) });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: "ssh_prompt_resolved",
      timeout: true,
    });
    vi.useRealTimers();
  });

  it("cancels a run's prompts and never another run's", async () => {
    const registry = new SshPromptRegistry(60000);
    const eventsA: Record<string, unknown>[] = [];
    const eventsB: Record<string, unknown>[] = [];
    const a = registry.ask({ ...base, emit: (e) => eventsA.push(e) });
    const b = registry.ask({
      ...base,
      runId: "r2",
      emit: (e) => eventsB.push(e),
    });
    registry.cancelRun("r1");
    await expect(a).resolves.toBeNull();
    expect(registry.resolve("u1", String(eventsB[0].promptId), "later")).toBe(
      true,
    );
    await expect(b).resolves.toBe("later");
  });

  it("gives up immediately for browser sign-in rounds", async () => {
    const registry = new SshPromptRegistry(60000);
    const result = await registry.ask({
      ...base,
      request: {
        kind: "browser",
        prompt: "",
        label: "SSO",
        url: "https://sso.test",
        code: "N/A",
        instructions: "Open the link",
      },
      emit: () => {},
    });
    expect(result).toBeNull();
  });
});
