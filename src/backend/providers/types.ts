export type ProviderId = "openrouter" | "openai" | "anthropic";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/** A command the assistant asked to run. */
export interface ToolCallSpec {
  id: string;
  hostId: number;
  command: string;
}

/**
 * The provider-agnostic conversation format the agent loop works with.
 * Adapters map this onto each provider's wire format.
 */
export type AgentMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCallSpec[];
      thinking?: string;
    }
  | { role: "tool"; toolCallId: string; text: string };

export interface StreamHandlers {
  /** Assistant prose, as it arrives. */
  onText: (delta: string) => void;
  /** Reasoning text, when the provider streams it. */
  onThinking: (delta: string) => void;
}

export interface ProviderTurnResult {
  text: string;
  toolCalls: ToolCallSpec[];
  thinking?: string;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
}

export interface ChatCompletionRequest {
  model: string;
  apiKey: string;
  baseUrl: string;
  system: string;
  messages: AgentMessage[];
  effort: ReasoningEffort;
  signal?: AbortSignal;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
}

export interface ListModelsRequest {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  defaultBaseUrl: string;
  stream(
    req: ChatCompletionRequest,
    handlers: StreamHandlers,
  ): Promise<ProviderTurnResult>;
  listModels(req: ListModelsRequest): Promise<ProviderModelInfo[]>;
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
