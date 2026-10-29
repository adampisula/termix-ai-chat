import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { chats, messages } from "./tables.js";
import { registerRoutes } from "./routes.js";

export async function activate(ctx: PluginContext) {
  const chatsTable = await ctx.db.define(chats);
  const messagesTable = await ctx.db.define(messages);
  const dispose = registerRoutes(ctx.http.router<Router>(), ctx, {
    chatsTable,
    messagesTable,
  });
  ctx.disposables.add(dispose);
  ctx.log.info("agent-chat ready");
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core; routes return
  // their own dispose which cancels active runs.
}
