import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAiCompatAdapter } from "./openai-compat.js";
import type { ProviderAdapter, ProviderId } from "./types.js";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  openrouter: createOpenAiCompatAdapter(
    "openrouter",
    "https://openrouter.ai/api/v1",
  ),
  openai: createOpenAiCompatAdapter("openai", "https://api.openai.com/v1"),
  anthropic: createAnthropicAdapter("https://api.anthropic.com/v1"),
};

export function getAdapter(provider: string): ProviderAdapter | null {
  if (
    provider === "openrouter" ||
    provider === "openai" ||
    provider === "anthropic"
  ) {
    return PROVIDERS[provider];
  }
  return null;
}

export function apiKeySettingKey(provider: ProviderId): string {
  return `apiKey${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

export function baseUrlSettingKey(provider: ProviderId): string {
  return `baseUrl${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}
