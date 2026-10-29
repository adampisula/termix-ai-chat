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
 * OpenAI Chat Completions wire format, shared by the OpenAI adapter and
 * OpenRouter (which is OpenAI-compatible with a different reasoning knob).
 */

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export function toWire(messages: AgentMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      wire.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      wire.push({
        role: "assistant",
        content: message.text || null,
        tool_calls:
          message.toolCalls.length > 0
            ? message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: TOOL_NAME,
                  arguments: JSON.stringify({
                    hostId: call.hostId,
                    command: call.command,
                  }),
                },
              }))
            : undefined,
      });
    } else {
      wire.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.text,
      });
    }
  }
  return wire;
}

export function buildRequestBody(
  req: ChatCompletionRequest,
  providerId: "openrouter" | "openai",
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      ...toWire(req.messages),
    ],
    tools: [
      {
        type: "function",
        function: {
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          parameters: TOOL_PARAMETERS,
        },
      },
    ],
    stream: true,
  };
  if (req.effort !== "none") {
    if (providerId === "openai") body.reasoning_effort = req.effort;
    else body.reasoning = { effort: req.effort };
  }
  if (providerId === "openai") body.stream_options = { include_usage: true };
  else body.usage = { include: true };
  return body;
}

interface DeltaChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function trimBase(baseUrl?: string): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function createOpenAiCompatAdapter(
  id: "openrouter" | "openai",
  defaultBaseUrl: string,
): ProviderAdapter {
  return {
    id,
    defaultBaseUrl,

    async stream(
      req: ChatCompletionRequest,
      handlers: StreamHandlers,
    ): Promise<ProviderTurnResult> {
      const base = trimBase(req.baseUrl) || defaultBaseUrl;
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${req.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(req, id)),
        signal: req.signal,
      });
      await assertOk(response);

      let text = "";
      const partials = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      let usage: { inputTokens?: number; outputTokens?: number } | null = null;

      for await (const event of sseEvents(response)) {
        if (!event.data) continue;
        let chunk: DeltaChunk;
        try {
          chunk = JSON.parse(event.data) as DeltaChunk;
        } catch {
          continue;
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          handlers.onText(delta.content);
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) handlers.onThinking(reasoning);
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          const partial = partials.get(index) ?? { id: "", name: "", args: "" };
          if (call.id) partial.id = call.id;
          if (call.function?.name) partial.name += call.function.name;
          if (call.function?.arguments) partial.args += call.function.arguments;
          partials.set(index, partial);
        }
      }

      const toolCalls: ToolCallSpec[] = [];
      const ordered = [...partials.entries()].sort((a, b) => a[0] - b[0]);
      for (const [index, partial] of ordered) {
        const spec = parseToolArguments(
          partial.args,
          partial.id || `call_${index}`,
        );
        if (spec) toolCalls.push(spec);
      }

      return { text, toolCalls, usage };
    },

    async listModels(req: ListModelsRequest): Promise<ProviderModelInfo[]> {
      const base = trimBase(req.baseUrl) || defaultBaseUrl;
      const headers: Record<string, string> = {};
      if (req.apiKey) headers.authorization = `Bearer ${req.apiKey}`;
      const response = await fetch(`${base}/models`, { headers });
      await assertOk(response);
      const parsed = (await response.json()) as {
        data?: Array<{ id?: string; name?: string }>;
      };
      return (parsed.data ?? [])
        .filter(
          (model): model is { id: string; name?: string } =>
            typeof model.id === "string",
        )
        .map((model) => ({ id: model.id, name: model.name ?? model.id }));
    },
  };
}
