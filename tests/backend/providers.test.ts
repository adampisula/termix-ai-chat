import { afterEach, describe, expect, it } from "vitest";
import {
  createAnthropicAdapter,
  buildRequestBody as buildAnthropicBody,
  toWire as toAnthropicWire,
} from "../../src/backend/providers/anthropic.js";
import {
  buildRequestBody as buildOpenAiBody,
  createOpenAiCompatAdapter,
} from "../../src/backend/providers/openai-compat.js";
import type {
  AgentMessage,
  ChatCompletionRequest,
} from "../../src/backend/providers/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function sseChunks(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join("");
}

const baseRequest = (
  overrides?: Partial<ChatCompletionRequest>,
): ChatCompletionRequest => ({
  model: "test-model",
  apiKey: "sk-test",
  baseUrl: "https://provider.test/v1",
  system: "You are a test.",
  messages: [{ role: "user", text: "list files" }],
  effort: "none",
});

function captureFetch(body: Record<string, unknown>[], response: Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    body.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response;
  }) as typeof fetch;
  return calls;
}

describe("OpenAI-compatible adapters", () => {
  it("builds the OpenAI wire format with reasoning_effort", () => {
    const body = buildOpenAiBody(
      { ...baseRequest(), effort: "high" },
      "openai",
    );
    expect(body.model).toBe("test-model");
    expect(body.reasoning_effort).toBe("high");
    expect(body.stream_options).toEqual({ include_usage: true });
    const messages = body.messages as Array<{ role: string; content?: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    const tools = body.tools as Array<{ function: { name: string } }>;
    expect(tools[0].function.name).toBe("run_command");
  });

  it("builds the OpenRouter wire format with the reasoning object", () => {
    const body = buildOpenAiBody(
      { ...baseRequest(), effort: "medium" },
      "openrouter",
    );
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.usage).toEqual({ include: true });
  });

  it("omits reasoning knobs when effort is none", () => {
    const body = buildOpenAiBody(baseRequest(), "openai");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it("maps tool results to role:tool messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "check disk" },
      {
        role: "assistant",
        text: "Running df.",
        toolCalls: [{ id: "call1", hostId: 3, command: "df -h" }],
      },
      { role: "tool", toolCallId: "call1", text: "stdout:\n/dev/sda1 90%" },
    ];
    const wire = buildOpenAiBody({ ...baseRequest(), messages }, "openai")
      .messages as Array<Record<string, unknown>>;
    expect(wire[2]).toMatchObject({
      role: "assistant",
      content: "Running df.",
      tool_calls: [{ id: "call1", function: { name: "run_command" } }],
    });
    expect(
      JSON.parse(
        (wire[2].tool_calls as Array<{ function: { arguments: string } }>)[0]
          .function.arguments,
      ),
    ).toEqual({
      hostId: 3,
      command: "df -h",
    });
    expect(wire[3]).toEqual({
      role: "tool",
      tool_call_id: "call1",
      content: "stdout:\n/dev/sda1 90%",
    });
  });

  it("streams text deltas, accumulates fragmented tool calls and reports usage", async () => {
    const bodies: Record<string, unknown>[] = [];
    const calls = captureFetch(
      bodies,
      sseResponse([
        sseChunks([
          '{"choices":[{"delta":{"content":"Running "}}]}',
          '{"choices":[{"delta":{"content":"df."}}]}',
        ]),
        sseChunks([
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"run_","arguments":"{\\"host"}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Id\\":7,\\"command\\":\\"df -h\\"}"}}]}}]}',
          '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
        ]),
      ]),
    );

    const deltas: string[] = [];
    const adapter = createOpenAiCompatAdapter(
      "openrouter",
      "https://fallback.test/v1",
    );
    const result = await adapter.stream(baseRequest(), {
      onText: (d) => deltas.push(d),
      onThinking: () => {},
    });

    expect(calls[0].url).toBe("https://provider.test/v1/chat/completions");
    expect(calls[0].init?.headers).toMatchObject({
      authorization: "Bearer sk-test",
    });
    expect(deltas.join("")).toBe("Running df.");
    expect(result.text).toBe("Running df.");
    expect(result.toolCalls).toEqual([
      { id: "call1", hostId: 7, command: "df -h" },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("falls back to the adapter default base URL when none is set", async () => {
    const bodies: Record<string, unknown>[] = [];
    const calls = captureFetch(
      bodies,
      sseResponse([sseChunks(['{"choices":[{"delta":{}}]}'])]),
    );
    const adapter = createOpenAiCompatAdapter(
      "openai",
      "https://api.openai.test/v1",
    );
    await adapter.stream(
      { ...baseRequest(), baseUrl: "" },
      { onText: () => {}, onThinking: () => {} },
    );
    expect(calls[0].url).toBe("https://api.openai.test/v1/chat/completions");
  });

  it("lists models", async () => {
    const calls: Array<{ url: string }> = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push({ url: String(url) });
      return new Response(
        JSON.stringify({
          data: [{ id: "m1", name: "Model One" }, { id: "m2" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const adapter = createOpenAiCompatAdapter(
      "openai",
      "https://api.openai.test/v1",
    );
    const models = await adapter.listModels({ apiKey: "k" });
    expect(calls[0].url).toBe("https://api.openai.test/v1/models");
    expect(models).toEqual([
      { id: "m1", name: "Model One" },
      { id: "m2", name: "m2" },
    ]);
  });

  it("surfaces provider errors with their message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
      })) as typeof fetch;
    const adapter = createOpenAiCompatAdapter(
      "openai",
      "https://api.openai.test/v1",
    );
    await expect(
      adapter.stream(baseRequest(), { onText: () => {}, onThinking: () => {} }),
    ).rejects.toThrow(/bad key/);
  });
});

describe("Anthropic adapter", () => {
  it("maps conversation history to content blocks, tool results into user turns", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "check disk" },
      {
        role: "assistant",
        text: "Running df.",
        thinking: "Need disk usage.",
        toolCalls: [{ id: "tool1", hostId: 3, command: "df -h" }],
      },
      { role: "tool", toolCallId: "tool1", text: "stdout:\n/dev/sda1 90%" },
    ];
    const wire = toAnthropicWire(messages);
    expect(wire).toHaveLength(3);
    expect(wire[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "check disk" }],
    });
    const assistantBlocks = wire[1].content as unknown as Array<
      Record<string, unknown>
    >;
    expect(assistantBlocks[0]).toEqual({
      type: "thinking",
      thinking: "Need disk usage.",
    });
    expect(assistantBlocks[1]).toEqual({ type: "text", text: "Running df." });
    expect(assistantBlocks[2]).toMatchObject({
      type: "tool_use",
      id: "tool1",
      name: "run_command",
    });
    const toolResultBlocks = wire[2].content as unknown as Array<
      Record<string, unknown>
    >;
    expect(toolResultBlocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tool1",
    });
  });

  it("enables thinking with a budget and temperature 1 when effort is set", () => {
    const body = buildAnthropicBody({ ...baseRequest(), effort: "medium" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.max_tokens).toBe(8192 + 8192);
    expect(body.temperature).toBe(1);
    expect(body.system).toBe("You are a test.");
  });

  it("keeps thinking off when effort is none", () => {
    const body = buildAnthropicBody(baseRequest());
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(8192);
  });

  it("streams text and tool_use blocks", async () => {
    const bodies: Record<string, unknown>[] = [];
    const calls = captureFetch(
      bodies,
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"disk."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool1","name":"run_command"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"hostId\\": 3,"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\"command\\": \\"df -h\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const deltas: string[] = [];
    const adapter = createAnthropicAdapter("https://api.anthropic.test/v1");
    const result = await adapter.stream(baseRequest(), {
      onText: (d) => deltas.push(d),
      onThinking: () => {},
    });

    expect(calls[0].url).toBe("https://provider.test/v1/messages");
    expect(calls[0].init?.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
    });
    expect(deltas.join("")).toBe("Checking disk.");
    expect(result.text).toBe("Checking disk.");
    expect(result.toolCalls).toEqual([
      { id: "tool1", hostId: 3, command: "df -h" },
    ]);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("lists models with the version header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-x", display_name: "Claude X" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const adapter = createAnthropicAdapter("https://api.anthropic.test/v1");
    const models = await adapter.listModels({ apiKey: "k" });
    expect(calls[0].url).toBe("https://api.anthropic.test/v1/models?limit=100");
    expect(calls[0].init?.headers).toMatchObject({ "x-api-key": "k" });
    expect(models).toEqual([{ id: "claude-x", name: "Claude X" }]);
  });
});
