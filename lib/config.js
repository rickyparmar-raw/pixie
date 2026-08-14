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
const NINE_ROUTER_BASE_URL = "http://9router.railway.internal:20128/v1";
const ANSWER_FALLBACK_MODEL = "gc/gemini-3.1-flash-lite-preview";

// Hack Club AI (https://ai.hackclub.com) — a free proxy for individual teen
// developers, not a production backend (docs.ai.hackclub.com/guide/rules).
// Optional extra tier ahead of Zen for answers specifically: entirely opt-in,
// on by setting HCAI_API_KEY, and does nothing to config.answer otherwise. Its
// own rate limit is per-key (450 req/30min), which is why it gets a pool with
// the same round-robin-plus-cooldown shape as Zen's rather than one shared key.
const HCAI_BASE_URL = "https://ai.hackclub.com/proxy/v1";
// Measured fastest of HCAI's catalogue by direct latency test, not a guess.
// Only used when HCAI_API_KEY is set and HCAI_MODEL isn't — without this,
// leaving HCAI_MODEL unset would fall through to DEFAULT_MODEL, which is a
// Zen-catalogue name ("deepseek-v4-flash-free") that means nothing on HCAI's
// endpoint and would 400 on every single answer before Zen ever got a turn.
const DEFAULT_HCAI_MODEL = "deepseek/deepseek-v4-flash-latest";

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

let zenKeyIndex = 0;
function nextZenApiKey() {
  const keys = config.zenApiKeys;
  if (!keys || keys.length === 0) return undefined;

  const now = Date.now();
  // At most one full lap, so an all-cooling pool can't spin.
  for (let i = 0; i < keys.length; i++) {
    const idx = zenKeyIndex % keys.length;
    zenKeyIndex += 1;
    const key = keys[idx];
    if (!(coolingUntil.get(key) > now)) return key;
  }
  // Every key is cooling. Return the one that recovers soonest — a doomed attempt
  // still beats sending no key at all and turning a 429 into a 401.
  return keys.reduce((best, k) => ((coolingUntil.get(k) || 0) < (coolingUntil.get(best) || 0) ? k : best), keys[0]);
}

// Zen as a standby for any call site aimed somewhere else. A self-hosted
// gateway is the cheap way to a better model and also a single point of
// failure — when it is unreachable, answering worse beats not answering, and
// for the intent gate specifically it is the difference between a degraded
// verdict and pixie going silent channel-wide (see lib/llm.js complete()).
//
// Returns null when the primary already IS Zen, so the common case pays for no
// second attempt against the endpoint that just failed.
function zenStandby(baseUrl, model) {
  if (baseUrl === ZEN_BASE_URL) return null;
  return {
    baseUrl: ZEN_BASE_URL,
    apiKey: () => nextZenApiKey(),
    model,
  };
}

// Answers' standby, specifically: Zen's own free tier maxing out is the outage
// this guards against, so — unlike zenStandby() — the standby must NOT be Zen.
// Defaults to the same 9Router/Gemini endpoint intent already runs on and its
// key, so no new Railway variable is required to turn this on; all three are
// still independently overridable, matching every other call site's pattern.
function answerFallback() {
  const baseUrl = normalizeBaseUrl(process.env.PIXIE_ANSWER_FALLBACK_BASE_URL, NINE_ROUTER_BASE_URL);
  if (baseUrl === answerBaseUrl) return null;
  return {
    baseUrl,
    apiKey: () =>
      process.env.PIXIE_ANSWER_FALLBACK_API_KEY || process.env.INTENT_CLASSIFIER_API_KEY || process.env.VISION_API_KEY,
    model: process.env.PIXIE_ANSWER_FALLBACK_MODEL || ANSWER_FALLBACK_MODEL,
  };
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

const faqChannels = parseChannels(process.env.SLACK_FAQ_CHANNELS);
// Who may teach pixie and approve what it learned. Empty means nobody — the
// learning commands refuse rather than falling open, since anything approved
// goes straight into the corpus every answer is grounded in.
const adminUserIds = parseChannels(process.env.PIXIE_ADMIN_USER_IDS);

// Resolved up front so each call site can hand its own URL to zenStandby().
const answerBaseUrl = normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, ZEN_BASE_URL);
const intentBaseUrl = normalizeBaseUrl(process.env.INTENT_CLASSIFIER_BASE_URL, ZEN_BASE_URL);
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

// Every Zen account currently in play. Scanned rather than listed, so adding a
// key is a Railway variable and never a code change.
function collectZenKeys(env = process.env) {
  return Object.keys(env)
    .filter((k) => /^OPENCODE_API_KEY(_\d+)?$/.test(k))
    .sort((a, b) => zenKeyOrder(a) - zenKeyOrder(b))
    .map((k) => (env[k] || "").trim())
    .filter(Boolean);
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

  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = hcaiKeyIndex % keys.length;
    hcaiKeyIndex += 1;
    const key = keys[idx];
    if (!(hcaiCoolingUntil.get(key) > now)) return key;
  }
  return keys.reduce(
    (best, k) => ((hcaiCoolingUntil.get(k) || 0) < (hcaiCoolingUntil.get(best) || 0) ? k : best),
    keys[0],
  );
}

// Same shape as collectZenKeys — HCAI_API_KEY, HCAI_API_KEY_2, ...
function collectHcaiKeys(env = process.env) {
  return Object.keys(env)
    .filter((k) => /^HCAI_API_KEY(_\d+)?$/.test(k))
    .sort((a, b) => zenKeyOrder(a) - zenKeyOrder(b))
    .map((k) => (env[k] || "").trim())
    .filter(Boolean);
}

const hcaiApiKeys = collectHcaiKeys();

// Zen answers, with the existing 9Router standby behind them — unchanged from
// before HCAI existed. Reused as-is below, either as config.answer directly or
// as the tier HCAI falls back to.
const zenAnswerTier = {
  apiKey: () => process.env.PIXIE_ANSWER_API_KEY || nextZenApiKey(),
  baseUrl: answerBaseUrl,
  model: process.env.PIXIE_MODEL || DEFAULT_MODEL,
  // Deliberately not zenStandby(): the whole Zen key pool exhausting its
  // quota is the exact outage this exists for, so a fallback that is ALSO
  // Zen helps nothing. Reuses the 9Router/Gemini endpoint already wired for
  // intent — degraded but real beats ERROR_FALLBACK.
  fallback: answerFallback(),
  onRateLimited: penalizeZenKey,
};

const config = {
  zenApiKeys,
  hcaiApiKeys,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || null,

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    helpChannel: process.env.SLACK_HELP_CHANNEL,
    faqChannels,
    // The first FAQ channel (#pixl) is the one that gets intent-based
    // auto-replies without needing a mention.
    autoReplyChannel: faqChannels[0] || null,
    // Filled in at startup from auth.test — see resolveBotUserId().
    botUserId: null,
    adminUserIds,
  },

  // Each call site gets its own base URL. They used to be tangled: answers
  // hardcoded Zen while ignoring OPENCODE_BASE_URL (which the README claimed
  // controlled them), and vision quietly consumed OPENCODE_BASE_URL instead —
  // so pointing that var at a local proxy retargeted the wrong one.
  //
  // Answers default to Zen and only move if PIXIE_ANSWER_BASE_URL says so,
  // because PIXIE_MODEL is a Zen model name. Vision still honours
  // OPENCODE_BASE_URL as a fallback, which is the meaning it actually had in
  // deployed .env files.
  // Answers only, not intent/vision — HCAI is a free personal-use proxy, not
  // something to point every call site at. With no HCAI_API_KEY set this is
  // exactly zenAnswerTier, unchanged from before HCAI existed. With one set,
  // HCAI goes first and Zen (with its own existing 9Router standby) becomes
  // what it falls back to — a real three-tier chain via complete()'s recursive
  // fallback (see lib/llm.js).
  answer: hcaiApiKeys.length > 0
    ? {
        apiKey: () => nextHcaiApiKey(),
        baseUrl: process.env.HCAI_BASE_URL || HCAI_BASE_URL,
        model: process.env.HCAI_MODEL || DEFAULT_HCAI_MODEL,
        onRateLimited: penalizeHcaiKey,
        fallback: zenAnswerTier,
      }
    : zenAnswerTier,

  intent: {
    apiKey: () => process.env.INTENT_CLASSIFIER_API_KEY || nextZenApiKey(),
    baseUrl: intentBaseUrl,
    model: process.env.INTENT_CLASSIFIER_MODEL || DEFAULT_MODEL,
    fallback: zenStandby(intentBaseUrl, DEFAULT_MODEL),
    onRateLimited: penalizeZenKey,
  },

  vision: {
    apiKey: () => process.env.VISION_API_KEY || nextZenApiKey(),
    baseUrl: visionBaseUrl,
    model: process.env.PIXIE_VISION_MODEL || DEFAULT_VISION_MODEL,
    fallback: zenStandby(visionBaseUrl, DEFAULT_VISION_MODEL),
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
  validate,
  missingVars,
  isAdmin,
  resolveBotUserId,
  normalizeBaseUrl,
  zenStandby,
  answerFallback,
  nextZenApiKey,
  collectZenKeys,
  zenKeyOrder,
  penalizeZenKey,
  nextHcaiApiKey,
  collectHcaiKeys,
  penalizeHcaiKey,
  ZEN_BASE_URL,
  HCAI_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_HCAI_MODEL,
  ANSWER_FALLBACK_MODEL,
};
