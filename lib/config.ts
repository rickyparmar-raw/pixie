// Environment parsing, defaults, and provider-key rotation live in one place so
// callers cannot silently disagree about which endpoint or credentials to use.
import dotenv = require("dotenv");
import type { WebClient } from "@slack/web-api";

type UntypedInput = any;
dotenv.config();

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_MODEL = "deepseek-v4-flash-free";


const DEFAULT_VISION_MODEL = "mimo-v2.5-free";
const DEFAULT_REFRESH_INTERVAL_MIN = 30;


const NINE_ROUTER_BASE_URL = "http://pixie.railway.internal:20128/v1";
const ANSWER_FALLBACK_MODEL = "gc/gemini-3.1-flash-lite-preview";

const HCAI_BASE_URL = "https://ai.hackclub.com/proxy/v1";
const DEFAULT_HCAI_MODEL = "openrouter/free";
const DEFAULT_HCAI_VISION_MODEL = "xiaomi/mimo-v2-omni";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
const DEFAULT_GROQ_INTENT_MODEL = "qwen/qwen3.8-27b";


const SLACK_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_HELP_CHANNEL", "SLACK_FAQ_CHANNELS"];
const MODEL_VARS = ["OPENCODE_API_KEY"];

function stripTrailingSlash(url: UntypedInput) {
  return url.replace(/\/+$/, "");
}


function normalizeBaseUrl(url: UntypedInput, fallback: UntypedInput) {
  // Accept the documented chat/completions form while storing one base URL shape.
  if (!url) return fallback;
  return stripTrailingSlash(url).replace(/\/chat\/completions$/, "");
}


const KEY_COOLDOWN_MS = 60 * 1000;
const coolingUntil = new Map();

function penalizeZenKey(key: UntypedInput, ms = KEY_COOLDOWN_MS) {
  // Cooldown state is process-local and never exposes key material in the config object.
  if (!key) return;
  if (ms <= 0) {
    coolingUntil.delete(key);
  } else if (config.zenApiKeys.includes(key)) {
    coolingUntil.set(key, Date.now() + ms);
  }
}


function scanPool(keys: UntypedInput, coolingUntil: UntypedInput, state: UntypedInput) {
  // Scan at most one full lap; an exhausted pool cannot spin in the event loop.
  for (let i = 0; i < keys.length; i++) {
    const idx = state.index % keys.length;
    state.index += 1;
    const key = keys[idx];
    if (!(coolingUntil.get(key) > state.now)) return key;
  }
  return null;
}


function soonestRecovery(keys: string[], coolingUntil: Map<string, number>): string | undefined {
  // A cooling key is still preferable to no key when every account is rate-limited.
  return keys.reduce((best: string, k: string) => ((coolingUntil.get(k) || 0) < (coolingUntil.get(best) || 0) ? k : best), keys[0]);
}

let zenKeyIndex = 0;
function nextZenApiKey() {
  const keys = config.zenApiKeys;
  if (!keys || keys.length === 0) return undefined;

  const state = { index: zenKeyIndex, now: Date.now() };
  const fresh = scanPool(keys, coolingUntil, state);
  zenKeyIndex = state.index;
  if (fresh) return fresh;
  return soonestRecovery(keys, coolingUntil);
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";

function zenStandby(baseUrl: UntypedInput, model = DEFAULT_MODEL) {
  // Never return the same endpoint as its caller's fallback: that would self-reference.
  if (baseUrl === ZEN_BASE_URL) return null;
  return {
    baseUrl: ZEN_BASE_URL,
    apiKey: () => nextZenApiKey(),
    model: DEFAULT_MODEL,
  };
}


function standbyFallback(baseUrl: UntypedInput, defaultZenModel = DEFAULT_MODEL) {
  // Prefer a different provider, then Zen's rotating pool, so fallback remains real.
  if (baseUrl === OPENROUTER_BASE_URL) return zenStandby(baseUrl, defaultZenModel);
  if (baseUrl === ZEN_BASE_URL && !process.env.OPENROUTER_API_KEY) return null;

  if (process.env.OPENROUTER_API_KEY) {
    return {
      baseUrl: normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, OPENROUTER_BASE_URL),
      apiKey: () => process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      fallback: zenStandby(process.env.OPENROUTER_BASE_URL, defaultZenModel),
    };
  }

  return zenStandby(baseUrl, defaultZenModel);
}

function parseChannels(raw: UntypedInput) {
  // Comma-separated settings are normalized once so every caller sees the same channel list.
  return (raw || "")
    .split(",")
    .map((c: UntypedInput) => c.trim())
    .filter(Boolean);
}

function positiveNumber(raw: UntypedInput, fallback: UntypedInput) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(raw: UntypedInput, fallback = false) {
  // Only explicit true values enable a flag; missing and arbitrary text stay at the fallback.
  if (raw === undefined || raw === null || raw === "") return fallback;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

function probability(raw: UntypedInput, fallback: UntypedInput) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}


const JEV_BASE_URL = "https://api.experientiallabs.ai/v1/systemone";
const JEV_FREE_MODEL = "jev-latest:free";

function jevConfig() {
  // JEV is a bounded classifier call with one configured endpoint, not a provider pool.
  return {
    enabled: envFlag(process.env.JEV_ENABLED, false),
    provider: "experiential",
    model: (process.env.JEV_MODEL || "").trim() || JEV_FREE_MODEL,
    baseUrl: (process.env.JEV_BASE_URL || JEV_BASE_URL).trim() || JEV_BASE_URL,
    timeoutMs: positiveNumber(process.env.JEV_TIMEOUT_MS, 8000),
    engageThreshold: probability(process.env.JEV_ENGAGE_THRESHOLD, 0.7),


    experientialApiKeyPresent: Boolean((process.env.JEV_API_KEY || process.env.EXPERIENTIAL_API_KEY || "").trim()),
  };
}

const faqChannels = parseChannels(process.env.SLACK_FAQ_CHANNELS);
// The first FAQ channel is the legacy ambient-answer channel.


const stagingOnlyChannels = parseChannels(process.env.PIXIE_STAGING_ONLY_CHANNELS);
// When set, every Slack event outside this allowlist is ignored before handling.


const adminUserIds = parseChannels(process.env.PIXIE_ADMIN_USER_IDS);


const intentBaseUrl = normalizeBaseUrl(
  process.env.INTENT_CLASSIFIER_BASE_URL,
  process.env.GROQ_API_KEY ? GROQ_BASE_URL : ZEN_BASE_URL,
);
const visionBaseUrl = normalizeBaseUrl(
  process.env.PIXIE_VISION_BASE_URL || process.env.OPENCODE_BASE_URL,
  ZEN_BASE_URL,
);


function zenKeyOrder(name: UntypedInput) {
  const m = name.match(/_(\d+)$/);
  return m ? Number(m[1]) : 1;
}


function collectNumberedKeys(env: UntypedInput, prefix: UntypedInput) {
  // Gaps are allowed so removing KEY_3 does not silently renumber another account.
  const pattern = new RegExp(`^${prefix}(_\\d+)?$`);
  return Object.keys(env)
    .filter((k: UntypedInput) => pattern.test(k))
    .sort((a, b) => zenKeyOrder(a) - zenKeyOrder(b))
    .map((k: UntypedInput) => (env[k] || "").trim())
    .filter(Boolean);
}

function collectZenKeys(env = process.env) {
  return collectNumberedKeys(env, "OPENCODE_API_KEY");
}

const zenApiKeys = collectZenKeys();

const hcaiCoolingUntil = new Map();
let hcaiKeyIndex = 0;

function penalizeHcaiKey(key: UntypedInput, ms = KEY_COOLDOWN_MS) {
  if (!key) return;
  if (ms <= 0) {
    hcaiCoolingUntil.delete(key);
  } else if (config.hcaiApiKeys.includes(key)) {
    hcaiCoolingUntil.set(key, Date.now() + ms);
  }
}

function nextHcaiApiKey() {
  const keys = config.hcaiApiKeys;
  if (!keys || keys.length === 0) return undefined;

  const state = { index: hcaiKeyIndex, now: Date.now() };
  const fresh = scanPool(keys, hcaiCoolingUntil, state);
  hcaiKeyIndex = state.index;
  if (fresh) return fresh;
  return soonestRecovery(keys, hcaiCoolingUntil);
}

function collectHcaiKeys(env = process.env) {
  return collectNumberedKeys(env, "HCAI_API_KEY");
}

const hcaiApiKeys = collectHcaiKeys();

function hcaiTier(model: UntypedInput) {
  return {
    apiKey: () => process.env.HCAI_API_KEY,
    baseUrl: HCAI_BASE_URL,
    model,
    onRateLimited: penalizeHcaiKey,
  };
}


function collectGroqKeys(env = process.env) {
  return collectNumberedKeys(env, "GROQ_API_KEY");
}

const groqApiKeys = collectGroqKeys();
const groqCoolingUntil = new Map();
let groqKeyIndex = 0;

function penalizeGroqKey(key: UntypedInput, ms = KEY_COOLDOWN_MS) {
  if (!key) return;
  if (ms <= 0) {
    groqCoolingUntil.delete(key);
  } else {
    groqCoolingUntil.set(key, Date.now() + ms);
  }
}

function nextGroqApiKey() {
  const keys = (config && config.groqApiKeys && config.groqApiKeys.length > 0) ? config.groqApiKeys : groqApiKeys;
  if (!keys || keys.length === 0) return process.env.GROQ_API_KEY || undefined;

  const state = { index: groqKeyIndex, now: Date.now() };
  const fresh = scanPool(keys, groqCoolingUntil, state);
  groqKeyIndex = state.index;
  if (fresh) return fresh;
  return soonestRecovery(keys, groqCoolingUntil);
}

const DEFAULT_PRIMARY_MODEL = "kr/claude-sonnet-4.5";
const DEFAULT_FALLBACK_MODEL = "ag/gemini-3.6-flash-low";

const nineRouterSecondaryFallbackTier = {
  apiKey: () =>
    process.env.PIXIE_ANSWER_API_KEY || process.env.INTENT_CLASSIFIER_API_KEY || process.env.VISION_API_KEY,
  baseUrl: normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL),
  model: process.env.PIXIE_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL,
  fallback: standbyFallback(normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL), DEFAULT_MODEL),
};

const nineRouterAnswerTier = {
  apiKey: () =>
    process.env.PIXIE_ANSWER_API_KEY || process.env.INTENT_CLASSIFIER_API_KEY || process.env.VISION_API_KEY,
  baseUrl: normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL),
  model: process.env.PIXIE_MODEL || DEFAULT_PRIMARY_MODEL,
  fallback: process.env.OPENROUTER_API_KEY
    ? {
        apiKey: () => process.env.OPENROUTER_API_KEY,
        baseUrl: normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, OPENROUTER_BASE_URL),
        model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        fallback: nineRouterSecondaryFallbackTier,
      }
    : nineRouterSecondaryFallbackTier,
};

const openRouterAnswerTier = process.env.OPENROUTER_API_KEY
  ? {
      apiKey: () => process.env.OPENROUTER_API_KEY,
      baseUrl: normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, OPENROUTER_BASE_URL),
      model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      fallback: nineRouterAnswerTier,
    }
  : nineRouterAnswerTier;

const nineRouterPingTier = {
  apiKey: () =>
    process.env.PIXIE_PING_API_KEY || process.env.PIXIE_ANSWER_API_KEY || process.env.INTENT_CLASSIFIER_API_KEY || process.env.VISION_API_KEY,
  baseUrl: normalizeBaseUrl(process.env.PIXIE_PING_BASE_URL || process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL),
  model: process.env.PIXIE_PING_MODEL || process.env.PIXIE_MODEL || DEFAULT_PRIMARY_MODEL,
  fallback: openRouterAnswerTier,
};

const config = {
  zenApiKeys,
  hcaiApiKeys,
  groqApiKeys,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || null,

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    helpChannel: process.env.SLACK_HELP_CHANNEL,
    faqChannels,
    stagingOnlyChannels,
    autoReplyChannel: faqChannels[0] || null,
    botUserId: null,
    adminUserIds,
  },

  pingAnswer: nineRouterPingTier,
  helpAnswer: nineRouterAnswerTier,
  answer: hcaiApiKeys.length > 0
    ? {
        apiKey: () => nextHcaiApiKey(),
        baseUrl: process.env.HCAI_BASE_URL || HCAI_BASE_URL,
        model: process.env.HCAI_MODEL || DEFAULT_HCAI_MODEL,
        onRateLimited: penalizeHcaiKey,
        fallback: nineRouterAnswerTier,
      }
    : nineRouterAnswerTier,
  intent: {
    apiKey: () => {
      if (process.env.INTENT_CLASSIFIER_API_KEY) return process.env.INTENT_CLASSIFIER_API_KEY;
      if (intentBaseUrl === GROQ_BASE_URL) return nextGroqApiKey();
      return nextZenApiKey();
    },
    baseUrl: intentBaseUrl,
    model:
      process.env.INTENT_CLASSIFIER_MODEL ||
      (intentBaseUrl === GROQ_BASE_URL ? (process.env.GROQ_MODEL || DEFAULT_GROQ_INTENT_MODEL) : DEFAULT_MODEL),
    fallback: standbyFallback(intentBaseUrl, DEFAULT_MODEL),
    onRateLimited: intentBaseUrl === GROQ_BASE_URL ? penalizeGroqKey : penalizeZenKey,
  },
  vision: {
    apiKey: () => process.env.VISION_API_KEY || nextZenApiKey(),
    baseUrl: visionBaseUrl,
    model: process.env.PIXIE_VISION_MODEL || DEFAULT_VISION_MODEL,
    fallback: standbyFallback(visionBaseUrl, DEFAULT_VISION_MODEL),
    onRateLimited: penalizeZenKey,
  },

  reportChannel: process.env.PIXIE_REPORT_CHANNEL || null,

  refreshIntervalMin: positiveNumber(process.env.REFRESH_INTERVAL_MIN, DEFAULT_REFRESH_INTERVAL_MIN),
  debug: process.env.PIXIE_DEBUG === "1" || process.env.PIXIE_DEBUG === "true",

  web: {
    baseUrl: process.env.PIXIE_WEB_BASE_URL || `http://localhost:${process.env.PIXIE_WEB_PORT || 4100}`,
  },


  escalateReaction: (process.env.PIXIE_ESCALATE_REACTION || "").replace(/:/g, "").trim() || null,


  ticketOpenReaction:
    process.env.PIXIE_TICKET_REACTION === "" ? null : (process.env.PIXIE_TICKET_REACTION || "ticket").replace(/:/g, "").trim() || null,
  ticketResolvedReaction:
    process.env.PIXIE_TICKET_REACTION === "" ? null : (process.env.PIXIE_TICKET_RESOLVED_REACTION || "white_check_mark").replace(/:/g, "").trim() || null,


  feedbackReactions: (process.env.PIXIE_FEEDBACK_REACTIONS ?? "")
    .split(",")
    .map((r: UntypedInput) => r.replace(/:/g, "").trim())
    .filter(Boolean),

  jev: jevConfig(),
};


function missingVars({ needsSlack }: Record<string, UntypedInput>) {
  const required = needsSlack ? [...MODEL_VARS, ...SLACK_VARS] : MODEL_VARS;
  return required.filter((name: UntypedInput) => !process.env[name]);
}

function validate({ needsSlack = true }: Record<string, UntypedInput> = {}) {
  const missing = missingVars({ needsSlack });
  if (missing.length > 0) {
    throw new Error(
      `missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}\n` +
        `see .env.example — copy it to .env and fill in the blanks`,
    );
  }
  return config;
}

async function resolveBotUserId(client: UntypedInput) {
  const auth = await client.auth.test();
  config.slack.botUserId = auth.user_id;
  return auth.user_id;
}

function isAdmin(userId: UntypedInput) {
  // An empty admin allowlist fails closed so an unconfigured deployment cannot mutate knowledge.
  return !!userId && config.slack.adminUserIds.includes(userId);
}

export = {
  config,
  jevConfig,
  validate,
  missingVars,
  isAdmin,
  resolveBotUserId,
  normalizeBaseUrl,
  zenStandby,
  standbyFallback,
  nextZenApiKey,
  collectZenKeys,
  zenKeyOrder,
  penalizeZenKey,
  nextHcaiApiKey,
  collectHcaiKeys,
  penalizeHcaiKey,
  nextGroqApiKey,
  collectGroqKeys,
  penalizeGroqKey,
  ZEN_BASE_URL,
  HCAI_BASE_URL,
  OPENROUTER_BASE_URL,
  GROQ_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_HCAI_MODEL,
  DEFAULT_HCAI_VISION_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_GROQ_INTENT_MODEL,
  ANSWER_FALLBACK_MODEL,
};
