import type { DomainError, Result } from "./result";

export interface SecretString { readonly kind: "secret"; readonly value: string }
export interface SecretProvider { readonly kind: "secret-provider"; get(): string | undefined }
export interface ModelTierConfig { baseUrl: string; model: string; apiKey: SecretProvider; maxTokens?: number }
export interface TicketRuntimeConfig { enabled: boolean; autoEscalate: boolean; openReaction: string | null; resolvedReaction: string | null; requireHelper: boolean }
export interface SlackRuntimeConfig { botToken: SecretString; appToken: SecretString; botUserId: string | null; helpChannel: string | null; faqChannels: readonly string[]; stagingOnlyChannels: readonly string[] }
export interface ProgramRuntimeConfig { programId: string | null; programName: string; supportName: string | null; supportIconUrl: string | null; posture: "active" | "passive" | "muted"; scope: "any" | "program"; aiAnswers: boolean; tickets: TicketRuntimeConfig; shadowMode: boolean; requireGroundedAnswer: boolean; threadRequireMention: boolean }
export interface RuntimeConfig { slack: SlackRuntimeConfig; models: { answer: ModelTierConfig; fallback: ModelTierConfig | null; vision: ModelTierConfig | null; intent: ModelTierConfig | null }; program: ProgramRuntimeConfig; refreshIntervalMin: number; adminUserIds: readonly string[]; webBaseUrl: string | null }
export type RuntimeConfigError = DomainError & { code: "missing_required_value" | "invalid_url" | "invalid_number" | "invalid_enum" | "invalid_config" };
export type PublicRuntimeConfig = Omit<RuntimeConfig, "slack" | "models"> & { slack: Pick<SlackRuntimeConfig, "botUserId" | "helpChannel" | "faqChannels"> };

export function publicRuntimeConfig(config: RuntimeConfig): PublicRuntimeConfig {
  return { ...config, slack: { botUserId: config.slack.botUserId, helpChannel: config.slack.helpChannel, faqChannels: config.slack.faqChannels } };
}

export function validateRuntimeConfig(config: RuntimeConfig): Result<RuntimeConfig, RuntimeConfigError> {
  if (!config.program.programName.trim()) return { ok: false, error: { code: "invalid_config", message: "program name is required" } };
  if (!Number.isFinite(config.refreshIntervalMin) || config.refreshIntervalMin <= 0) return { ok: false, error: { code: "invalid_number", message: "refresh interval must be positive" } };
  return { ok: true, value: config };
}
