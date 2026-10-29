import { assertOk, sseEvents } from "./sse.js";
import {
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_PARAMETERS,
  parseToolArguments,
} from "./tool-schema.js";
import type {
  AgentMessage,
  ChatCompletionRequest,
  ListModelsRequest,
  ProviderAdapter,
  ProviderModelInfo,
  ProviderTurnResult,
  StreamHandlers,
  ToolCallSpec,
} from "./types.js";

/**
 * Anthropic Messages wire format, with extended thinking support.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const BASE_MAX_TOKENS = 8192;
const THINKING_BUDGET: Record<Exclude<ReasoningEffort, "none">, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

type ReasoningEffort = ChatCompletionRequest["effort"];

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface WireMessage {
  role: "user" | "assistant";
  content: ContentBlock[] | string;
}

export function toWire(messages: AgentMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  const push = (role: "user" | "assistant", block: ContentBlock) => {
    const last = wire[wire.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      wire.push({ role, content: [block] });
    }
  };

  for (const message of messages) {
    if (message.role === "user") {
      push("user", { type: "text", text: message.text });
    } else if (message.role === "assistant") {
      if (message.thinking) {
        push("assistant", { type: "thinking", thinking: message.thinking });
      }
      if (message.text) {
        push("assistant", { type: "text", text: message.text });
      }
      for (const call of message.toolCalls) {
        push("assistant", {
          type: "tool_use",
          id: call.id,
          name: TOOL_NAME,
          input: { hostId: call.hostId, command: call.command },
        });
      }
    } else {
      push("user", {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.text,
      });
    }
  }
  return wire;
}

export function buildRequestBody(
  req: ChatCompletionRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    system: req.system,
    messages: toWire(req.messages),
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        input_schema: TOOL_PARAMETERS,
      },
    ],
    max_tokens: BASE_MAX_TOKENS,
    stream: true,
  };
  if (req.effort !== "none") {
    const budget = THINKING_BUDGET[req.effort];
    body.thinking = { type: "enabled", budget_tokens: budget };
    body.max_tokens = budget + BASE_MAX_TOKENS;
    body.temperature = 1;
  }
  return body;
}

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

interface OpenBlock {
  type: string;
  id?: string;
  name?: string;
  text: string;
  thinking: string;
  json: string;
}

export function createAnthropicAdapter(
  defaultBaseUrl: string,
): ProviderAdapter {
  return {
    id: "anthropic",
    defaultBaseUrl,

    async stream(
      req: ChatCompletionRequest,
      handlers: StreamHandlers,
    ): Promise<ProviderTurnResult> {
      const base =
        (req.baseUrl || "").trim().replace(/\/+$/, "") || defaultBaseUrl;
      const response = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": req.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildRequestBody(req)),
        signal: req.signal,
      });
      await assertOk(response);

      const blocks = new Map<number, OpenBlock>();
      const order: number[] = [];
      let usage: { inputTokens?: number; outputTokens?: number } | null = null;
      let stopReason = "";

      for await (const event of sseEvents(response)) {
        if (!event.data) continue;
        let parsed: StreamEvent;
        try {
          parsed = JSON.parse(event.data) as StreamEvent;
        } catch {
          continue;
        }
        if (parsed.type === "error") {
          throw new Error(parsed.error?.message ?? "Anthropic stream error");
        }
        if (parsed.type === "message_start" && parsed.message?.usage) {
          usage = { inputTokens: parsed.message.usage.input_tokens };
        }
        if (parsed.type === "content_block_start" && parsed.content_block) {
          const index = parsed.index ?? 0;
          blocks.set(index, {
            type: parsed.content_block.type ?? "text",
            id: parsed.content_block.id,
            name: parsed.content_block.name,
            text: "",
            thinking: "",
            json: "",
          });
          order.push(index);
        }
        if (parsed.type === "content_block_delta" && parsed.delta) {
          const block = blocks.get(parsed.index ?? 0);
          if (!block) continue;
          if (parsed.delta.type === "text_delta" && parsed.delta.text) {
            block.text += parsed.delta.text;
            handlers.onText(parsed.delta.text);
          } else if (
            parsed.delta.type === "thinking_delta" &&
            parsed.delta.thinking
          ) {
            block.thinking += parsed.delta.thinking;
            handlers.onThinking(parsed.delta.thinking);
          } else if (
            parsed.delta.type === "input_json_delta" &&
            parsed.delta.partial_json
          ) {
            block.json += parsed.delta.partial_json;
          }
        }
        if (parsed.type === "message_delta") {
          if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
          if (parsed.usage?.output_tokens != null) {
            usage = {
              ...(usage ?? {}),
              outputTokens: parsed.usage.output_tokens,
            };
          }
        }
      }

      let text = "";
      let thinking = "";
      const toolCalls: ToolCallSpec[] = [];
      for (const index of order) {
        const block = blocks.get(index);
        if (!block) continue;
        if (block.type === "text") text += block.text;
        else if (block.type === "thinking") thinking += block.thinking;
        else if (block.type === "tool_use") {
          const spec = parseToolArguments(
            block.json || "{}",
            block.id ?? `tool_${index}`,
          );
          if (spec) toolCalls.push(spec);
        }
      }

      // A stop_reason of "tool_use" with no parsed calls means the model asked
      // for a tool we could not parse; surface that rather than ending the
      // turn silently.
      if (toolCalls.length === 0 && stopReason === "tool_use") {
        toolCalls.push({
          id: `unparsed_${Date.now()}`,
          hostId: 0,
          command: "",
        });
      }

      return { text, toolCalls, thinking: thinking || undefined, usage };
    },

    async listModels(req: ListModelsRequest): Promise<ProviderModelInfo[]> {
      const base =
        (req.baseUrl ?? "").trim().replace(/\/+$/, "") || defaultBaseUrl;
      const headers: Record<string, string> = {
        "anthropic-version": ANTHROPIC_VERSION,
      };
      if (req.apiKey) headers["x-api-key"] = req.apiKey;
      const response = await fetch(`${base}/models?limit=100`, { headers });
      await assertOk(response);
      const parsed = (await response.json()) as {
        data?: Array<{ id?: string; display_name?: string; name?: string }>;
      };
      return (parsed.data ?? [])
        .filter(
          (
            model,
          ): model is { id: string; display_name?: string; name?: string } =>
            typeof model.id === "string",
        )
        .map((model) => ({
          id: model.id,
          name: model.display_name ?? model.name ?? model.id,
        }));
    },
  };
}
