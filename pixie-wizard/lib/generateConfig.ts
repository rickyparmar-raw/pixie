import type { PixieTrialRow } from "@/lib/types";

// Same defaults the wizard offered in step 2 (app/wizard/actions.ts) — repeated
// here rather than imported so this module has no "use server" dependency and
// stays callable from a plain script/test.
const DEFAULT_LLM_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_LLM_MODEL = "deepseek-v4-flash-free";

// Trimmed relative to apps/pixie/lib/identity.js's own IDENTITY block — no
// "who made you" or "are you pixorpheus" pairs, since neither is true for a
// trial deployed elsewhere. See that file's PIXIE_IDENTITY_OVERRIDE support.
export function generateIdentityOverride(botName: string, programName: string): string {
  return [
    "Q: Who are you? / What are you? / Introduce yourself",
    `A: I'm ${botName} — the Slack bot for ${programName}. I answer questions from ${programName}'s docs and FAQ, help debug code and screenshots, and walk people through setup. If I don't know something, ask a helper in the channel.`,
    "",
    "Q: How are you? / How's it going?",
    `A: Just a bot vibing — chatting and answering questions. Ask me anything about ${programName}.`,
    "",
    "Q: What can you do? / How do I use you?",
    "A: Ping me or say my name anywhere, DM me, or use /pixie <question> for a private answer. I can also read screenshots and error messages if you upload them.",
  ].join("\n");
}

export interface TrialSecrets {
  botToken: string;
  appToken: string;
  llmKey: string;
}

const SECRET_ENV_KEYS = new Set(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "OPENCODE_API_KEY"]);

export function generateTrialEnv(trial: PixieTrialRow, secrets: TrialSecrets): Record<string, string> {
  const baseUrl = trial.llm_base_url || DEFAULT_LLM_BASE_URL;
  const model = trial.llm_model || DEFAULT_LLM_MODEL;
  const botName = trial.bot_name || trial.program_name;

  const env: Record<string, string> = {
    SLACK_BOT_TOKEN: secrets.botToken,
    SLACK_APP_TOKEN: secrets.appToken,
    OPENCODE_API_KEY: secrets.llmKey,
    PIXIE_IDENTITY_OVERRIDE: generateIdentityOverride(botName, trial.program_name),
  };

  if (trial.channels?.helpChannel) env.SLACK_HELP_CHANNEL = trial.channels.helpChannel.id;
  const faq = trial.channels?.faqChannels ?? [];
  if (faq.length > 0) env.SLACK_FAQ_CHANNELS = faq.map((c) => c.id).join(",");

  if (trial.requester_slack_id) env.PIXIE_ADMIN_USER_IDS = trial.requester_slack_id;

  if (baseUrl !== DEFAULT_LLM_BASE_URL) {
    env.PIXIE_ANSWER_BASE_URL = baseUrl;
    env.PIXIE_MODEL = model;
  }

  // The landmine from plan §6: apps/pixie/lib/config.js defaults
  // PIXIE_ANSWER_FALLBACK_BASE_URL to a Railway-internal address that only
  // resolves inside the original Pixl project. Setting it equal to the
  // primary base URL makes answerFallback() return null and cleanly disables
  // the fallback instead of pointing every trial at an unreachable host.
  env.PIXIE_ANSWER_FALLBACK_BASE_URL = baseUrl;

  return env;
}

// What actually gets written to config_snapshot — same map minus the values
// that are secrets, so the audit trail in Supabase never holds a live token.
export function redactEnvForSnapshot(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SECRET_ENV_KEYS.has(key) ? "(hidden)" : value;
  }
  return redacted;
}
