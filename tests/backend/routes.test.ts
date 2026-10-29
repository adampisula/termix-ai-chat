import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { clearModelCache } from "../../src/backend/routes.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;
let requestActor = "user-1";
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  clearModelCache();
  requestActor = "user-1";
  db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
    .run("user-1", "user-1");

  let router: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: ["ai-chat.use"],
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor(requestActor);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("ROUTE ERROR:", error);
      res.status(500).json({ error: "internal" });
    },
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Non-JSON response ${response.status} for ${method} ${path}: ${text.slice(0, 200)}`,
    );
  }
  return { status: response.status, body: parsed };
}

/**
 * Provider API stand-in. Only intercepts the provider host; everything else
 * (including the test's own requests to the express server) goes through the
 * real fetch.
 */
function stubProviderFetch(mode: "reject" | "hang"): {
  release: () => void;
} {
  let release: () => void = () => {};
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://openrouter.ai/")) {
      return originalFetch(input as Parameters<typeof originalFetch>[0], init);
    }
    if (mode === "reject") {
      throw new Error("provider unreachable");
    }
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error("released");
  }) as typeof fetch;
  return { release: () => release() };
}

async function configureProvider() {
  await mock.ctx.settings.setUser("user-1", "provider", "openrouter");
  await mock.ctx.settings.setUser("user-1", "apiKeyOpenrouter", "sk-test");
  await mock.ctx.settings.setUser("user-1", "model", "test/model");
  await mock.ctx.settings.setUser("user-1", "reasoningEffort", "low");
}

describe("chat routes", () => {
  it("creates, lists, patches and deletes chats", async () => {
    const created = await request("POST", "/chats", {
      approvalMode: "auto-safe",
    });
    expect(created.status).toBe(201);
    const chatId = created.body.chat.id;
    expect(created.body.chat).toMatchObject({
      userId: "user-1",
      approvalMode: "auto-safe",
    });

    const patched = await request("PATCH", `/chats/${chatId}`, {
      title: "Disk check",
      approvalMode: "auto",
    });
    expect(patched.body.chat).toMatchObject({
      title: "Disk check",
      approvalMode: "auto",
    });

    const listed = await request("GET", "/chats");
    expect(listed.body.chats).toHaveLength(1);
    expect(listed.body.chats[0].title).toBe("Disk check");

    const deleted = await request("DELETE", `/chats/${chatId}`);
    expect(deleted.status).toBe(200);
    const after = await request("GET", "/chats");
    expect(after.body.chats).toHaveLength(0);
  });

  it("falls back to ask for an unknown approval mode", async () => {
    const created = await request("POST", "/chats", { approvalMode: "yolo" });
    expect(created.body.chat.approvalMode).toBe("ask");
  });

  it("keeps other users' chats unreachable", async () => {
    const created = await request("POST", "/chats", {});
    const chatId = created.body.chat.id;
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run("user-2", "user-2");
    requestActor = "user-2";
    const list = await request("GET", "/chats");
    expect(list.body.chats).toHaveLength(0);
    const patch = await request("PATCH", `/chats/${chatId}`, { title: "x" });
    expect(patch.status).toBe(404);
    const messages = await request("GET", `/chats/${chatId}/messages`);
    expect(messages.status).toBe(404);
  });

  it("rejects sending a message without a configured provider", async () => {
    const created = await request("POST", "/chats", {});
    const sent = await request(
      "POST",
      `/chats/${created.body.chat.id}/messages`,
      {
        text: "hello",
      },
    );
    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/not configured/i);
  });

  it("rejects an empty message", async () => {
    const created = await request("POST", "/chats", {});
    const sent = await request(
      "POST",
      `/chats/${created.body.chat.id}/messages`,
      {
        text: "   ",
      },
    );
    expect(sent.status).toBe(400);
  });

  it("starts a run, stores the user message and titles the chat", async () => {
    stubProviderFetch("reject");
    await configureProvider();

    const created = await request("POST", "/chats", { approvalMode: "auto" });
    const chatId = created.body.chat.id;
    const sent = await request("POST", `/chats/${chatId}/messages`, {
      text: "check the disk",
    });
    expect(sent.status).toBe(201);
    expect(typeof sent.body.runId).toBe("string");

    const listed = await request("GET", `/chats/${chatId}/messages`);
    expect(listed.body.messages).toHaveLength(1);
    expect(listed.body.messages[0]).toMatchObject({
      role: "user",
      parts: { text: "check the disk" },
    });
    expect(listed.body.chat.title).toBe("check the disk");
  });

  it("runs one chat at a time and cancels on request", async () => {
    const provider = stubProviderFetch("hang");
    await configureProvider();

    const created = await request("POST", "/chats", { approvalMode: "auto" });
    const chatId = created.body.chat.id;
    const first = await request("POST", `/chats/${chatId}/messages`, {
      text: "one",
    });
    expect(first.status).toBe(201);
    const second = await request("POST", `/chats/${chatId}/messages`, {
      text: "two",
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already active/i);

    const cancelled = await request("POST", `/runs/${first.body.runId}/cancel`);
    expect(cancelled.status).toBe(200);
    provider.release();
  });

  it("answers 404 for another user's run", async () => {
    const provider = stubProviderFetch("hang");
    await configureProvider();
    const created = await request("POST", "/chats", {});
    const sent = await request(
      "POST",
      `/chats/${created.body.chat.id}/messages`,
      {
        text: "hello",
      },
    );
    const runId = sent.body.runId;
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run("user-2", "user-2");
    requestActor = "user-2";
    const stream = await request("GET", `/runs/${runId}/stream`);
    expect(stream.status).toBe(404);
    const approve = await request("POST", `/runs/${runId}/approvals/t1`, {
      decision: "approved",
    });
    expect(approve.status).toBe(404);
    requestActor = "user-1";
    provider.release();
  });

  it("answers 404 for unknown pending approvals", async () => {
    const provider = stubProviderFetch("hang");
    await configureProvider();
    const created = await request("POST", "/chats", { approvalMode: "ask" });
    const sent = await request(
      "POST",
      `/chats/${created.body.chat.id}/messages`,
      {
        text: "hello",
      },
    );
    const runId = sent.body.runId as string;

    // The first provider call hangs, so there is no approval yet.
    const early = await request("POST", `/runs/${runId}/approvals/nope`, {
      decision: "approved",
    });
    expect(early.status).toBe(404);
    provider.release();
  });

  it("lists hosts and reports configuration status", async () => {
    const hosts = await request("GET", "/hosts");
    expect(hosts.status).toBe(200);
    expect(hosts.body.hosts).toEqual([]);

    const status = await request("GET", "/status");
    expect(status.body).toMatchObject({ configured: false });

    await configureProvider();
    const configured = await request("GET", "/status");
    expect(configured.body).toMatchObject({
      configured: true,
      provider: "openrouter",
      model: "test/model",
    });
  });

  it("answers 502 when the provider model list fails", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://openrouter.ai/")) {
        return new Response("nope", { status: 500 });
      }
      return originalFetch(input as Parameters<typeof originalFetch>[0], init);
    }) as typeof fetch;
    await configureProvider();
    const models = await request("GET", "/models");
    expect(models.status).toBe(502);
  });

  it("lists models through the provider", async () => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://openrouter.ai/")) {
        return new Response(
          JSON.stringify({ data: [{ id: "m1", name: "Model One" }] }),
          {
            status: 200,
          },
        );
      }
      return originalFetch(input as Parameters<typeof originalFetch>[0], init);
    }) as typeof fetch;
    await configureProvider();
    const models = await request("GET", "/models");
    expect(models.status).toBe(200);
    expect(models.body.models).toEqual([{ id: "m1", name: "Model One" }]);
    // Second call is served from the cache without a provider request.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://openrouter.ai/")) {
        throw new Error("should be cached");
      }
      return originalFetch(input as Parameters<typeof originalFetch>[0], init);
    }) as typeof fetch;
    const cached = await request("GET", "/models");
    expect(cached.body.models).toHaveLength(1);
  });
});

describe("without the permission", () => {
  it("answers 403 on every route", async () => {
    let router: Router | null = null;
    const denied = createMockCtx({
      pluginId: manifest.id,
      manifest,
      capabilities: manifest.capabilities,
      db: db.database,
      router: () => (router = express.Router()),
      permissions: [],
    });
    await activate(denied.ctx);
    const app2 = express();
    app2.use(express.json());
    app2.use((_req, _res, next) => {
      denied.setActor("user-1");
      next();
    });
    app2.use((req, res, next) => router!(req, res, next));
    const server2 = http.createServer(app2);
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const port2 = (server2.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port2}/chats`);
      expect(response.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });
});
