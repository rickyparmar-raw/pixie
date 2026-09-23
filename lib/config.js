// Single place where every environment variable is read, defaulted and
// validated. Everything else imports the frozen `config` object instead of
// touching process.env, so a missing value fails loudly at startup with the
// full list of what's absent — rather than degrading into an ERROR_FALLBACK on
// every question, or a console.error nobody reads.
require("dotenv").config();

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_MODEL = "deepseek-v4-flash-free";
// Both defaults must be names Zen actually serves, since ZEN_BASE_URL is where
// an unconfigured deployment points. This used to be "kr/claude-sonnet-4.5" — a
// name only a local 9Router gateway understands — so the built-in vision default
// was dead on arrival anywhere else. mimo-v2.5-free is the one free Zen model
// that accepts an image.
const DEFAULT_VISION_MODEL = "mimo-v2.5-free";
const DEFAULT_REFRESH_INTERVAL_MIN = 30;

// Where answers land when the whole Zen key pool is out of quota. Same
// endpoint intent already runs on in production.
const NINE_ROUTER_BASE_URL = "http://pixie.railway.internal:20128/v1";
const ANSWER_FALLBACK_MODEL = "gc/gemini-3.1-flash-lite-preview";

const HCAI_BASE_URL = "https://ai.hackclub.com/proxy/v1";
const DEFAULT_HCAI_MODEL = "openrouter/free";
const DEFAULT_HCAI_VISION_MODEL = "xiaomi/mimo-v2-omni";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
const DEFAULT_GROQ_INTENT_MODEL = "qwen/qwen3.8-27b";

// Slack credentials are only needed when actually connecting. `--ask` builds
// the corpus and answers on the console, so it requires the model keys only.
const SLACK_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_HELP_CHANNEL", "SLACK_FAQ_CHANNELS"];
const MODEL_VARS = ["OPENCODE_API_KEY"];

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

// Tolerates a full ".../chat/completions" URL as well as a bare base, since
// the old README documented OPENCODE_BASE_URL with the path included.
function normalizeBaseUrl(url, fallback) {
  if (!url) return fallback;
  return stripTrailingSlash(url).replace(/\/chat\/completions$/, "");
}

// A key that just returned 429 is known-bad for a while; handing it to the very
// next caller wastes an attempt. Parked briefly instead, so rotation lands on a
// key with quota left.
const KEY_COOLDOWN_MS = 60 * 1000;
const coolingUntil = new Map();

function penalizeZenKey(key, ms = KEY_COOLDOWN_MS) {
  if (!key) return;
  if (ms <= 0) {
    coolingUntil.delete(key);
  } else if (config.zenApiKeys.includes(key)) {
    coolingUntil.set(key, Date.now() + ms);
  }
}

// Round-robin scan shared by every key pool: at most one full lap, so an
// all-cooling pool can't spin. Returns the first non-cooling key, or null when
// every key is cooling (the caller then falls back to soonest-recovery).
function scanPool(keys, coolingUntil, state) {
  for (let i = 0; i < keys.length; i++) {
    const idx = state.index % keys.length;
    state.index += 1;
    const key = keys[idx];
    if (!(coolingUntil.get(key) > state.now)) return key;
  }
  return null;
}

// Every key is cooling. Return the one that recovers soonest — a doomed attempt
// still beats sending no key at all and turning a 429 into a 401.
function soonestRecovery(keys, coolingUntil) {
  return keys.reduce((best, k) => ((coolingUntil.get(k) || 0) < (coolingUntil.get(best) || 0) ? k : best), keys[0]);
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

function zenStandby(baseUrl, model = DEFAULT_MODEL) {
  if (baseUrl === ZEN_BASE_URL) return null;
  return {
    baseUrl: ZEN_BASE_URL,
    apiKey: () => nextZenApiKey(),
    model: DEFAULT_MODEL,
  };
}

// Fallback standby tier: prefers OpenRouter when configured, then falls back to Zen
function standbyFallback(baseUrl, defaultZenModel = DEFAULT_MODEL) {
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

function parseChannels(raw) {
  return (raw || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

function probability(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

// Jev: the engagement classifier (lib/jevDecision.js). Experiential Labs
// only, free model only, one bounded request, no provider or model fallback.
// Where Pixie engages is a per-program setting (lib/programModel.js), not a
// Jev channel list.
const JEV_BASE_URL = "https://api.experientiallabs.ai/v1/systemone";
const JEV_FREE_MODEL = "jev-latest:free";

function jevConfig() {
  return {
    enabled: envFlag(process.env.JEV_ENABLED, false),
    provider: "experiential",
    model: (process.env.JEV_MODEL || "").trim() || JEV_FREE_MODEL,
    baseUrl: (process.env.JEV_BASE_URL || JEV_BASE_URL).trim() || JEV_BASE_URL,
    timeoutMs: positiveNumber(process.env.JEV_TIMEOUT_MS, 8000),
    engageThreshold: probability(process.env.JEV_ENGAGE_THRESHOLD, 0.7),
    // Booleans only — key material itself never enters the config object, so
    // no log or metric writer can ever print it.
    experientialApiKeyPresent: Boolean((process.env.EXPERIENTIAL_API_KEY || "").trim()),
  };
}

const faqChannels = parseChannels(process.env.SLACK_FAQ_CHANNELS);
// Staging guardrail: when set (comma-separated channel IDs), the process
// drops every Slack event outside those channels before any handling —
// answers, tickets, reactions, and jobs never touch other channels. This is
// what lets a staging Core share workspace credentials without disturbing
// production traffic. Unset means no restriction (production behavior).
const stagingOnlyChannels = parseChannels(process.env.PIXIE_STAGING_ONLY_CHANNELS);
// Who may teach pixie and approve what it learned. Empty means nobody — the
// learning commands refuse rather than falling open, since anything approved
// goes straight into the corpus every answer is grounded in.
const adminUserIds = parseChannels(process.env.PIXIE_ADMIN_USER_IDS);

// Resolved up front so each call site can hand its own URL to zenStandby().
const intentBaseUrl = normalizeBaseUrl(
  process.env.INTENT_CLASSIFIER_BASE_URL,
  process.env.GROQ_API_KEY ? GROQ_BASE_URL : ZEN_BASE_URL,
);
const visionBaseUrl = normalizeBaseUrl(
  process.env.PIXIE_VISION_BASE_URL || process.env.OPENCODE_BASE_URL,
  ZEN_BASE_URL,
);

// Ordinal so the pool is deterministic: bare key first, then _2, _3, ... Gaps are
// fine — someone deleting OPENCODE_API_KEY_3 must not renumber the rest.
function zenKeyOrder(name) {
  const m = name.match(/_(\d+)$/);
  return m ? Number(m[1]) : 1;
}

// One scanner for every numbered-key pool (Zen, HCAI, Groq): bare key first,
// then _2, _3, blanks dropped. Scanned rather than listed, so adding a key is
// a Railway variable and never a code change.
function collectNumberedKeys(env, prefix) {
  const pattern = new RegExp(`^${prefix}(_\\d+)?$`);
  return Object.keys(env)
    .filter((k) => pattern.test(k))
    .sort((a, b) => zenKeyOrder(a) - zenKeyOrder(b))
    .map((k) => (env[k] || "").trim())
    .filter(Boolean);
}

// Every Zen account currently in play. Scanned rather than listed, so adding a
// key is a Railway variable and never a code change.
function collectZenKeys(env = process.env) {
  return collectNumberedKeys(env, "OPENCODE_API_KEY");
}

const zenApiKeys = collectZenKeys();

// Same round-robin-plus-cooldown shape as Zen's pool above, kept as an
// independent copy rather than a shared helper: different provider, different
// keys, and one pool cooling down must never block rotation on the other.
const hcaiCoolingUntil = new Map();
let hcaiKeyIndex = 0;

function penalizeHcaiKey(key, ms = KEY_COOLDOWN_MS) {
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

// Same shape as collectZenKeys — HCAI_API_KEY, HCAI_API_KEY_2, ...
function collectHcaiKeys(env = process.env) {
  return collectNumberedKeys(env, "HCAI_API_KEY");
}

const hcaiApiKeys = collectHcaiKeys();

function hcaiTier(model) {
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

function penalizeGroqKey(key, ms = KEY_COOLDOWN_MS) {
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

// 9Router/Gemini answers — the operator's preferred primary model, ahead of
// Zen's deepseek-v4-flash-free. Same PIXIE_ANSWER_BASE_URL/PIXIE_MODEL/
// PIXIE_ANSWER_API_KEY vars this tier has always used when it was configured
// as Zen's standby; no Railway variable has to move for this to keep working.
//
// zenStandby() gives it a REAL fallback: Zen's own rotating key pool, used
// only when 9Router itself errors. Before this, primary being pointed
// straight at 9Router made the old answerFallback() (which refused to hand
// back a fallback pointed at wherever primary already was) return null —
// a single 9Router hiccup had nothing to catch it and every question hit
// ERROR_FALLBACK. zenStandby() has no such self-reference problem: Zen is
// never wherever 9Router already is.
//
// Briefly flipped to Zen-primary/9Router-fallback when 9Router's free quota
// was getting rate-limited hard, but that made replies noticeably slower
// overall (Zen's deepseek-v4-flash-free is the slower model day-to-day) —
// reverted back to this.
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
    // The first FAQ channel (#pixl) is the one that gets intent-based
    // auto-replies without needing a mention.
    autoReplyChannel: faqChannels[0] || null,
    // Filled in at startup from auth.test — see resolveBotUserId().
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

  // Where the weekly report gets posted. Defaults to the help channel, since
  // that's where the people who'd act on it already are. Unset with no help
  // channel either, and the scheduled post stays off — /pixie-report still
  // works, so this is a "where", not an "whether".
  reportChannel: process.env.PIXIE_REPORT_CHANNEL || null,

  refreshIntervalMin: positiveNumber(process.env.REFRESH_INTERVAL_MIN, DEFAULT_REFRESH_INTERVAL_MIN),
  debug: process.env.PIXIE_DEBUG === "1" || process.env.PIXIE_DEBUG === "true",

  // Web server base URL for constructing absolute URLs (screenshot serving, etc.)
  web: {
    baseUrl: process.env.PIXIE_WEB_BASE_URL || `http://localhost:${process.env.PIXIE_WEB_PORT || 4100}`,
  },

  // Emoji pixie reacts with in the help channel when the docs can't answer a
  // question — the marker helpers (and Pixorpheus's ticket flow) look for.
  // Empty disables the handoff. Stored without colons.
  escalateReaction: (process.env.PIXIE_ESCALATE_REACTION || "").replace(/:/g, "").trim() || null,

  // Emoji pixie places on the requester's message when a support ticket opens,
  // so the collapsed channel view shows at a glance that it's been picked up —
  // swapped for a check when the ticket resolves. Set PIXIE_TICKET_REACTION=""
  // to turn the markers off. Stored without colons.
  ticketOpenReaction:
    process.env.PIXIE_TICKET_REACTION === "" ? null : (process.env.PIXIE_TICKET_REACTION || "ticket").replace(/:/g, "").trim() || null,
  ticketResolvedReaction:
    process.env.PIXIE_TICKET_REACTION === "" ? null : (process.env.PIXIE_TICKET_RESOLVED_REACTION || "white_check_mark").replace(/:/g, "").trim() || null,

  // Emojis pixie pre-places on its own answers so voting is one click. Off by
  // default — pixie reacting to itself reads as self-congratulation, and votes
  // from people who add a reaction themselves still count either way. Set
  // PIXIE_FEEDBACK_REACTIONS (e.g. "sparkling_heart") to turn seeding back on.
  // Every name here must be in UP_REACTIONS/DOWN_REACTIONS (lib/handlers.js) or
  // the reaction is decorative and records nothing.
  feedbackReactions: (process.env.PIXIE_FEEDBACK_REACTIONS ?? "")
    .split(",")
    .map((r) => r.replace(/:/g, "").trim())
    .filter(Boolean),

  jev: jevConfig(),
};

// Returns the list of missing variable names for the given mode, so callers
// can report all of them at once instead of one per restart.
function missingVars({ needsSlack }) {
  const required = needsSlack ? [...MODEL_VARS, ...SLACK_VARS] : MODEL_VARS;
  return required.filter((name) => !process.env[name]);
}

function validate({ needsSlack = true } = {}) {
  const missing = missingVars({ needsSlack });
  if (missing.length > 0) {
    throw new Error(
      `missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}\n` +
        `see .env.example — copy it to .env and fill in the blanks`,
    );
  }
  return config;
}

// Slack only tells us our own user ID at runtime. Resolving it once here means
// mention detection can compare against a real ID everywhere, instead of the
// `undefined` it used to build into `<@undefined>`.
async function resolveBotUserId(client) {
  const auth = await client.auth.test();
  config.slack.botUserId = auth.user_id;
  return auth.user_id;
}

// Guard for the commands that mutate what pixie knows. Fails closed on an
// empty allowlist — an unconfigured deployment must not let anyone rewrite the
// corpus.
function isAdmin(userId) {
  return !!userId && config.slack.adminUserIds.includes(userId);
}

module.exports = {
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
