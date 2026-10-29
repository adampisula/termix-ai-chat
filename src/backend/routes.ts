import type { Request, Response, Router } from "express";
import { and, asc, desc, eq, max } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { randomUUID } from "node:crypto";
import { getAdapter, PROVIDERS } from "./providers/index.js";
import type { ProviderId } from "./providers/types.js";
import { ApprovalRegistry } from "./agent/approvals.js";
import {
  runAgentTurn,
  type ChatRecordLike,
  type HostInfo,
  type MessageParts,
  type RunHandle,
} from "./agent/runs.js";
import { hostLabel } from "./agent/prompt.js";
import {
  asApprovalMode,
  asEffort,
  loadAllowlist,
  loadLimits,
  loadProviderConfig,
} from "./settings.js";

// How long a run waits for an approval before denying the command.
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
// Model list cache, per provider, so pickers do not hammer the provider API.
const MODEL_CACHE_MS = 5 * 60 * 1000;
const modelCache = new Map<string, { at: number; models: unknown }>();

/** Clears the model list cache; for tests. */
export function clearModelCache(): void {
  modelCache.clear();
}

type ChatsTable = any;
type MessagesTable = any;

export interface RegisterRoutesOptions {
  chatsTable: ChatsTable;
  messagesTable: MessagesTable;
}

/**
 * Registers every route and returns a dispose function that cancels any
 * active runs. Call it once from activate; hand the return value to
 * ctx.disposables.add.
 */
export function registerRoutes(
  router: Router,
  ctx: PluginContext,
  options: RegisterRoutesOptions,
): () => void {
  router.use(ctx.rbac.require("use") as never);

  const { chatsTable, messagesTable } = options;
  const client = () => ctx.db.client<BetterSQLite3Database>();
  const actor = () => ctx.currentActor() as string;

  const approvals = new ApprovalRegistry();
  const runs = new Map<string, RunHandle>();
  const cancelHooks = new Map<string, AbortController>();
  const chatBusy = new Set<number>();

  const getRunForActor = (runId: string): RunHandle | null => {
    const run = runs.get(runId);
    if (!run || run.userId !== actor()) return null;
    return run;
  };

  const persist = () => ctx.db.persist();

  const dispose = () => {
    for (const controller of cancelHooks.values()) controller.abort();
    approvals.cancelAll();
    cancelHooks.clear();
  };

  async function loadHostsForPrompt(): Promise<HostInfo[]> {
    const summaries = await ctx.hosts.list();
    const hosts: HostInfo[] = [];
    for (const summary of summaries) {
      try {
        const access = await ctx.hosts.checkAccess(summary.id, "connect");
        if (!access.hasAccess) continue;
        hosts.push({
          id: summary.id,
          name: summary.name,
          ip: summary.ip,
          username: summary.username,
          tags: summary.tags,
        });
      } catch {
        // Host vanished mid-list; skip it.
      }
    }
    return hosts;
  }

  /**
   * @openapi
   * /plugin-api/ai-chat/chats:
   *   get:
   *     summary: List the signed-in user's chats
   *     tags:
   *       - AI Chat
   *     responses:
   *       200:
   *         description: The chats, most recently updated first
   */
  router.get("/chats", async (_req: Request, res: Response) => {
    const db = await client();
    const rows = await db
      .select()
      .from(chatsTable)
      .where(eq(chatsTable.userId, actor()))
      .orderBy(desc(chatsTable.updatedAt), desc(chatsTable.id));
    res.json({ chats: rows });
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/chats:
   *   post:
   *     summary: Create a chat
   *     tags:
   *       - AI Chat
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               approvalMode:
   *                 type: string
   *                 enum: [ask, auto-safe, auto]
   *     responses:
   *       201:
   *         description: The chat was created
   */
  router.post("/chats", async (req: Request, res: Response) => {
    const approvalMode = asApprovalMode(req.body?.approvalMode);
    const db = await client();
    const now = new Date().toISOString();
    await db.insert(chatsTable).values({
      userId: actor(),
      title: "",
      approvalMode,
      createdAt: now,
      updatedAt: now,
    });
    await persist();
    // No .returning(): MySQL does not have it. The newest empty-title row with
    // this mode is the one just written.
    const rows = await db
      .select()
      .from(chatsTable)
      .where(and(eq(chatsTable.userId, actor()), eq(chatsTable.title, "")))
      .orderBy(desc(chatsTable.id));
    const chat =
      rows.find(
        (row: { approvalMode: string }) => row.approvalMode === approvalMode,
      ) ?? rows[0];
    res.status(201).json({ chat });
  });

  async function ownChat(chatId: number): Promise<ChatRecordLike | null> {
    const db = await client();
    const rows = (await db
      .select()
      .from(chatsTable)
      .where(
        and(eq(chatsTable.id, chatId), eq(chatsTable.userId, actor())),
      )) as Array<ChatRecordLike>;
    return rows[0] ?? null;
  }

  /**
   * @openapi
   * /plugin-api/ai-chat/chats/{id}:
   *   patch:
   *     summary: Rename a chat or change its approval mode
   *     tags:
   *       - AI Chat
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               title:
   *                 type: string
   *               approvalMode:
   *                 type: string
   *                 enum: [ask, auto-safe, auto]
   *     responses:
   *       200:
   *         description: The updated chat
   *       404:
   *         description: No such chat
   */
  router.patch("/chats/:id", async (req: Request, res: Response) => {
    const chatId = Number(req.params.id);
    const chat = Number.isFinite(chatId) ? await ownChat(chatId) : null;
    if (!chat) return res.status(404).json({ error: "No such chat" });
    const update: Record<string, unknown> = {};
    if (typeof req.body?.title === "string") {
      update.title = req.body.title.trim().slice(0, 200);
    }
    if (req.body?.approvalMode !== undefined) {
      update.approvalMode = asApprovalMode(req.body.approvalMode);
    }
    if (Object.keys(update).length > 0) {
      const db = await client();
      update.updatedAt = new Date().toISOString();
      await db.update(chatsTable).set(update).where(eq(chatsTable.id, chatId));
      await persist();
    }
    const fresh = await ownChat(chatId);
    res.json({ chat: fresh });
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/chats/{id}:
   *   delete:
   *     summary: Delete a chat and its messages
   *     tags:
   *       - AI Chat
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The chat was deleted
   *       404:
   *         description: No such chat
   */
  router.delete("/chats/:id", async (req: Request, res: Response) => {
    const chatId = Number(req.params.id);
    const chat = Number.isFinite(chatId) ? await ownChat(chatId) : null;
    if (!chat) return res.status(404).json({ error: "No such chat" });
    const db = await client();
    await db.delete(messagesTable).where(eq(messagesTable.chatId, chatId));
    await db.delete(chatsTable).where(eq(chatsTable.id, chatId));
    await persist();
    res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/chats/{id}/messages:
   *   get:
   *     summary: List a chat's messages in order
   *     tags:
   *       - AI Chat
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The chat and its messages
   *       404:
   *         description: No such chat
   */
  router.get("/chats/:id/messages", async (req: Request, res: Response) => {
    const chatId = Number(req.params.id);
    const chat = Number.isFinite(chatId) ? await ownChat(chatId) : null;
    if (!chat) return res.status(404).json({ error: "No such chat" });
    const db = await client();
    const rows = (await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.chatId, chatId))
      .orderBy(asc(messagesTable.seq), asc(messagesTable.id))) as Array<{
      id: number;
      seq: number;
      role: string;
      parts: string | MessageParts;
    }>;
    res.json({
      chat,
      messages: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        role: row.role,
        parts:
          typeof row.parts === "string"
            ? (JSON.parse(row.parts) as MessageParts)
            : row.parts,
      })),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/chats/{id}/messages:
   *   post:
   *     summary: Send a user message and start an agent run
   *     tags:
   *       - AI Chat
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               text:
   *                 type: string
   *               model:
   *                 type: string
   *                 description: Overrides the user's default model for this run
   *               effort:
   *                 type: string
   *                 enum: [none, low, medium, high]
   *     responses:
   *       201:
   *         description: The run started; follow it on /runs/{runId}/stream
   *       400:
   *         description: Empty message, provider not configured, or a run already active
   *       404:
   *         description: No such chat
   */
  router.post("/chats/:id/messages", async (req: Request, res: Response) => {
    const chatId = Number(req.params.id);
    const chat = Number.isFinite(chatId) ? await ownChat(chatId) : null;
    if (!chat) return res.status(404).json({ error: "No such chat" });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text is required" });
    if (text.length > 16000)
      return res.status(400).json({ error: "text is too long" });
    if (chatBusy.has(chatId)) {
      return res
        .status(400)
        .json({ error: "A run is already active for this chat" });
    }

    const config = await loadProviderConfig(ctx, actor());
    if (!config) {
      return res.status(400).json({
        error:
          "Provider is not configured. Set an API key and model in Settings, AI Chat.",
      });
    }
    const adapter = getAdapter(config.provider);
    if (!adapter) return res.status(400).json({ error: "Unknown provider" });

    const limits = await loadLimits(ctx);
    const allowlist = await loadAllowlist(ctx, actor());
    const hosts = await loadHostsForPrompt();

    // Per-run overrides from the chat header; empty falls back to the user's
    // saved defaults.
    const modelOverride =
      typeof req.body?.model === "string" && req.body.model.trim()
        ? req.body.model.trim().slice(0, 200)
        : undefined;
    const effortOverride = asEffort(req.body?.effort);

    // Auto-title from the first user message.
    if (!chat.title) {
      const db = await client();
      await db
        .update(chatsTable)
        .set({ title: text.slice(0, 80), updatedAt: new Date().toISOString() })
        .where(eq(chatsTable.id, chatId));
      await persist();
    }

    const runId = randomUUID();
    const controller = new AbortController();
    // json() columns are plain text at the driver level: serialize by hand.
    const store = {
      async append(
        _chatId: number,
        userId: string,
        role: string,
        parts: MessageParts,
      ) {
        const db = await client();
        const rows = await db
          .select({ maxSeq: max(messagesTable.seq) })
          .from(messagesTable)
          .where(eq(messagesTable.chatId, chatId));
        const seq = (rows[0]?.maxSeq ?? 0) + 1;
        await db.insert(messagesTable).values({
          chatId,
          userId,
          seq,
          role,
          parts: JSON.stringify(parts),
          createdAt: new Date().toISOString(),
        });
        await db
          .update(chatsTable)
          .set({ updatedAt: new Date().toISOString() })
          .where(eq(chatsTable.id, chatId));
        await persist();
      },
      async list() {
        const db = await client();
        const rows = (await db
          .select()
          .from(messagesTable)
          .where(eq(messagesTable.chatId, chatId))
          .orderBy(asc(messagesTable.seq), asc(messagesTable.id))) as Array<{
          seq: number;
          role: string;
          parts: string | MessageParts;
        }>;
        return rows.map((row) => ({
          seq: row.seq,
          role: row.role,
          parts:
            typeof row.parts === "string"
              ? (JSON.parse(row.parts) as MessageParts)
              : row.parts,
        }));
      },
    };

    chatBusy.add(chatId);
    const handle = await runAgentTurn(runId, chat, text, ctx, {
      provider: adapter,
      providerConfig: {
        model: modelOverride ?? config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || adapter.defaultBaseUrl,
        effort: effortOverride ?? config.effort,
      },
      hosts,
      limits: {
        timeoutMs: limits.commandTimeoutSec * 1000,
        maxOutputChars: limits.maxOutputChars,
        maxTurnsPerRun: limits.maxTurnsPerRun,
      },
      allowlist,
      approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
      approvals,
      sshExec: (hostId, command, execOptions) =>
        ctx.ssh.exec(hostId, command, execOptions),
      store,
      isCancelled: () => controller.signal.aborted,
      signal: controller.signal,
    });
    runs.set(runId, handle);
    cancelHooks.set(runId, controller);
    void handle.promise.finally(() => {
      chatBusy.delete(chatId);
      runs.delete(runId);
      cancelHooks.delete(runId);
    });

    res.status(201).json({ runId });
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/runs/{id}/stream:
   *   get:
   *     summary: Stream a run's events as server-sent events
   *     tags:
   *       - AI Chat
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: An SSE stream of run events
   *       404:
   *         description: No such run
   */
  router.get("/runs/:id/stream", async (req: Request, res: Response) => {
    const run = getRunForActor(String(req.params.id));
    if (!run) return res.status(404).json({ error: "No such run" });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    const write = (event: unknown) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = run.subscribe(write);
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, 15000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.on("close", close);
    res.on("close", close);
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/runs/{id}/approvals/{toolCallId}:
   *   post:
   *     summary: Approve or deny a pending command
   *     tags:
   *       - AI Chat
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *       - name: toolCallId
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               decision:
   *                 type: string
   *                 enum: [approved, denied]
   *     responses:
   *       200:
   *         description: The decision was applied
   *       404:
   *         description: No such run or pending approval
   */
  router.post(
    "/runs/:id/approvals/:toolCallId",
    async (req: Request, res: Response) => {
      const run = getRunForActor(String(req.params.id));
      if (!run) return res.status(404).json({ error: "No such run" });
      const decision =
        req.body?.decision === "approved" ? "approved" : "denied";
      const ok = approvals.resolve(
        String(req.params.id),
        String(req.params.toolCallId),
        decision,
      );
      if (!ok)
        return res.status(404).json({ error: "No such pending approval" });
      res.json({ success: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai-chat/runs/{id}/cancel:
   *   post:
   *     summary: Cancel a run
   *     tags:
   *       - AI Chat
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The run was cancelled
   *       404:
   *         description: No such run
   */
  router.post("/runs/:id/cancel", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const run = getRunForActor(runId);
    if (!run) return res.status(404).json({ error: "No such run" });
    cancelHooks.get(runId)?.abort();
    approvals.cancelRun(runId);
    res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/models:
   *   get:
   *     summary: List models for the user's configured provider
   *     tags:
   *       - AI Chat
   *     responses:
   *       200:
   *         description: The provider's models
   *       400:
   *         description: Provider is not configured
   *       502:
   *         description: The provider API failed
   */
  router.get("/models", async (_req: Request, res: Response) => {
    const config = await loadProviderConfig(ctx, actor());
    if (!config) {
      return res.status(400).json({ error: "Provider is not configured" });
    }
    const adapter = getAdapter(config.provider);
    if (!adapter) return res.status(400).json({ error: "Unknown provider" });
    const cached = modelCache.get(config.provider);
    if (cached && Date.now() - cached.at < MODEL_CACHE_MS) {
      return res.json({ provider: config.provider, models: cached.models });
    }
    try {
      const models = await adapter.listModels({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
      modelCache.set(config.provider, { at: Date.now(), models });
      res.json({ provider: config.provider, models });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The provider being down is not a plugin bug: a 502 keeps it out of
      // the error budget.
      res.status(502).json({ error: message });
    }
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/hosts:
   *   get:
   *     summary: List hosts the user can connect to
   *     tags:
   *       - AI Chat
   *     responses:
   *       200:
   *         description: Hosts with connect access, one entry each
   */
  router.get("/hosts", async (_req: Request, res: Response) => {
    const hosts = await loadHostsForPrompt();
    res.json({
      hosts: hosts.map((host) => ({
        id: host.id,
        name: host.name,
        ip: host.ip,
        username: host.username,
        tags: host.tags,
        label: hostLabel(host),
      })),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai-chat/status:
   *   get:
   *     summary: Whether the user's provider is configured
   *     tags:
   *       - AI Chat
   *     responses:
   *       200:
   *         description: Configuration summary
   */
  router.get("/status", async (_req: Request, res: Response) => {
    const config = await loadProviderConfig(ctx, actor());
    res.json({
      configured: config !== null,
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      effort: config?.effort ?? null,
      knownProviders: Object.keys(PROVIDERS) as ProviderId[],
    });
  });

  return dispose;
}
