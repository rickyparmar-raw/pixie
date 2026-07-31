// Single place where every environment variable is read, defaulted and
// validated. Everything else imports the frozen `config` object instead of
// touching process.env, so a missing value fails loudly at startup with the
// full list of what's absent — rather than degrading into an ERROR_FALLBACK on
// every question, or a console.error nobody reads.
require("dotenv").config();

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_MODEL = "deepseek-v4-flash-free";
const DEFAULT_VISION_MODEL = "kr/claude-sonnet-4.5";
const DEFAULT_REFRESH_INTERVAL_MIN = 30;

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

const config = {
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
  answer: {
    apiKey: process.env.OPENCODE_API_KEY,
    baseUrl: normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, ZEN_BASE_URL),
    model: process.env.PIXIE_MODEL || DEFAULT_MODEL,
  },

  intent: {
    apiKey: process.env.INTENT_CLASSIFIER_API_KEY || process.env.OPENCODE_API_KEY,
    baseUrl: normalizeBaseUrl(process.env.INTENT_CLASSIFIER_BASE_URL, ZEN_BASE_URL),
    model: process.env.INTENT_CLASSIFIER_MODEL || DEFAULT_MODEL,
  },

  vision: {
    apiKey: process.env.VISION_API_KEY || process.env.OPENCODE_API_KEY,
    baseUrl: normalizeBaseUrl(
      process.env.PIXIE_VISION_BASE_URL || process.env.OPENCODE_BASE_URL,
      ZEN_BASE_URL,
    ),
    model: process.env.PIXIE_VISION_MODEL || DEFAULT_VISION_MODEL,
  },

  // Where the weekly report gets posted. Defaults to the help channel, since
  // that's where the people who'd act on it already are. Unset with no help
  // channel either, and the scheduled post stays off — /pixie-report still
  // works, so this is a "where", not an "whether".
  reportChannel: process.env.PIXIE_REPORT_CHANNEL || null,

  refreshIntervalMin: positiveNumber(process.env.REFRESH_INTERVAL_MIN, DEFAULT_REFRESH_INTERVAL_MIN),
  debug: process.env.PIXIE_DEBUG === "1" || process.env.PIXIE_DEBUG === "true",

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

module.exports = { config, validate, missingVars, isAdmin, resolveBotUserId, normalizeBaseUrl, ZEN_BASE_URL };
