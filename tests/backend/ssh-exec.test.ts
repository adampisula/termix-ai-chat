import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  createSshExecFn,
  execOverClient,
  type ExecClient,
} from "../../src/backend/agent/ssh-exec.js";

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
  it("uses ctx.ssh.exec when the runtime provides it", async () => {
    const exec = vi.fn(async () => ({
      stdout: "ok",
      stderr: "",
      code: 0,
      truncated: false,
      timedOut: false,
    }));
    const ctx = { ssh: { exec } } as unknown as PluginContext;
    const fn = createSshExecFn(ctx);
    const result = await fn(1, "ls", LIMITS);
    expect(exec).toHaveBeenCalledWith(1, "ls", LIMITS);
    expect(result.stdout).toBe("ok");
  });

  it("falls back to connect and a raw channel when exec is missing", async () => {
    const stream = makeStream();
    const client = makeClient(stream);
    const dispose = vi.fn();
    const connect = vi.fn(async () => ({ client, dispose }));
    const ctx = { ssh: { connect } } as unknown as PluginContext;
    const fn = createSshExecFn(ctx);
    const pending = fn(7, "uname -a", LIMITS);
    // connect resolves asynchronously; wait until the channel is opened.
    await vi.waitFor(() => expect(client.commands).toHaveLength(1));
    stream.emit("data", "Linux");
    stream.emit("exit", 0);
    stream.emit("close");
    const result = await pending;
    expect(connect).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ purpose: "agent-chat" }),
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
    const ctx = { ssh: { connect } } as unknown as PluginContext;
    const fn = createSshExecFn(ctx);
    const result = await fn(3, "ls", LIMITS);
    expect(result.stderr).toContain("boom");
    expect(dispose).toHaveBeenCalled();
  });
});
