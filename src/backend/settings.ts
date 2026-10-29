import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ProviderId, ReasoningEffort } from "./providers/types.js";
import { apiKeySettingKey, baseUrlSettingKey } from "./providers/index.js";
import { parseAllowlist } from "./agent/allowlist.js";
import type { Allowlist } from "./agent/allowlist.js";

export interface UserProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  effort: ReasoningEffort;
}

export interface AdminLimits {
  commandTimeoutSec: number;
  maxOutputChars: number;
  maxTurnsPerRun: number;
}

const PROVIDER_IDS: ProviderId[] = ["openrouter", "openai", "anthropic"];
const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];

const DEFAULT_LIMITS: AdminLimits = {
  commandTimeoutSec: 30,
  maxOutputChars: 20000,
  maxTurnsPerRun: 25,
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function loadProviderConfig(
  ctx: PluginContext,
  userId: string,
): Promise<UserProviderConfig | null> {
  const providerRaw =
    asString(await ctx.settings.getUser(userId, "provider")) ?? "openrouter";
  if (!PROVIDER_IDS.includes(providerRaw as ProviderId)) return null;
  const provider = providerRaw as ProviderId;
  const apiKey = asString(
    await ctx.settings.getUser(userId, apiKeySettingKey(provider)),
  );
  if (!apiKey) return null;
  const model = asString(await ctx.settings.getUser(userId, "model"));
  if (!model) return null;
  const baseUrl =
    asString(await ctx.settings.getUser(userId, baseUrlSettingKey(provider))) ??
    "";
  const effortRaw =
    asString(await ctx.settings.getUser(userId, "reasoningEffort")) ?? "none";
  const effort = EFFORTS.includes(effortRaw as ReasoningEffort)
    ? (effortRaw as ReasoningEffort)
    : "none";
  return { provider, model, apiKey, baseUrl, effort };
}

export async function loadLimits(ctx: PluginContext): Promise<AdminLimits> {
  const readNumber = async (key: string, fallback: number): Promise<number> => {
    const value = await ctx.settings.get<number>(key);
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : fallback;
  };
  return {
    commandTimeoutSec: await readNumber(
      "commandTimeoutSec",
      DEFAULT_LIMITS.commandTimeoutSec,
    ),
    maxOutputChars: await readNumber(
      "maxOutputChars",
      DEFAULT_LIMITS.maxOutputChars,
    ),
    maxTurnsPerRun: await readNumber(
      "maxTurnsPerRun",
      DEFAULT_LIMITS.maxTurnsPerRun,
    ),
  };
}

export async function loadAllowlist(
  ctx: PluginContext,
  userId: string,
): Promise<Allowlist> {
  const raw = await ctx.settings.getUser<string>(userId, "safeAllowlist");
  return parseAllowlist(raw ?? undefined);
}

export const APPROVAL_MODES = ["ask", "auto-safe", "auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export function asApprovalMode(value: unknown): ApprovalMode {
  return APPROVAL_MODES.includes(value as ApprovalMode)
    ? (value as ApprovalMode)
    : "ask";
}

export function asEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === "string" && EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined;
}
