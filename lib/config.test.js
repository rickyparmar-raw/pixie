const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBaseUrl,
  missingVars,
  isAdmin,
  config,
  zenStandby,
  answerFallback,
  nextZenApiKey,
  collectZenKeys,
  penalizeZenKey,
  ZEN_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VISION_MODEL,
  ANSWER_FALLBACK_MODEL,
} = require("./config");

// The allowlist gates everything that rewrites the corpus, so an unconfigured
// deployment must fail closed rather than letting anyone teach pixie.
test("isAdmin denies everyone when no allowlist is configured", () => {
  const saved = config.slack.adminUserIds;
  config.slack.adminUserIds = [];
  try {
    assert.equal(isAdmin("U1"), false);
    assert.equal(isAdmin(undefined), false);
  } finally {
    config.slack.adminUserIds = saved;
  }
});

test("isAdmin allows only listed users", () => {
  const saved = config.slack.adminUserIds;
  config.slack.adminUserIds = ["U1", "U2"];
  try {
    assert.equal(isAdmin("U1"), true);
    assert.equal(isAdmin("U2"), true);
    assert.equal(isAdmin("U3"), false);
    assert.equal(isAdmin(""), false);
  } finally {
    config.slack.adminUserIds = saved;
  }
});

// Retrying Zen after Zen just failed buys nothing but latency, so the standby
// only exists for call sites actually pointed somewhere else.
test("zenStandby is null when the call site already targets Zen", () => {
  assert.equal(zenStandby(ZEN_BASE_URL, "any-model"), null);
});

test("zenStandby names Zen and the given model for a self-hosted gateway", () => {
  const standby = zenStandby("http://9router.railway.internal:20128/v1", "deepseek-v4-flash-free");
  assert.equal(standby.baseUrl, ZEN_BASE_URL);
  assert.equal(standby.model, "deepseek-v4-flash-free");
});

// Every built-in default has to be a name Zen actually serves, since Zen is
// where an unconfigured deployment points. "kr/claude-sonnet-4.5" was baked in
// as the vision default and only ever resolved on a local 9Router — a provider
// prefix is a sign the name came from a gateway's catalogue, not Zen's.
test("the built-in model defaults are names Zen serves", () => {
  assert.ok(!DEFAULT_MODEL.includes("/"), `${DEFAULT_MODEL} is gateway-only`);
  assert.ok(!DEFAULT_VISION_MODEL.includes("/"), `${DEFAULT_VISION_MODEL} is gateway-only`);
});

test("normalizeBaseUrl falls back when unset", () => {
  assert.equal(normalizeBaseUrl(undefined, ZEN_BASE_URL), ZEN_BASE_URL);
  assert.equal(normalizeBaseUrl("", ZEN_BASE_URL), ZEN_BASE_URL);
});

test("normalizeBaseUrl strips a trailing slash", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1/", ZEN_BASE_URL), "https://example.com/v1");
});

// The old README documented OPENCODE_BASE_URL with the full path included, so
// existing .env files in the wild have it that way.
test("normalizeBaseUrl tolerates a full chat/completions URL", () => {
  assert.equal(
    normalizeBaseUrl("https://opencode.ai/zen/v1/chat/completions", ZEN_BASE_URL),
    "https://opencode.ai/zen/v1",
  );
});

test("missingVars reports every absent required var at once", () => {
  const saved = { ...process.env };
  delete process.env.OPENCODE_API_KEY;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_HELP_CHANNEL;
  delete process.env.SLACK_FAQ_CHANNELS;

  try {
    const missing = missingVars({ needsSlack: true });
    assert.ok(missing.includes("OPENCODE_API_KEY"));
    assert.ok(missing.includes("SLACK_BOT_TOKEN"));
    assert.equal(missing.length, 5);
  } finally {
    Object.assign(process.env, saved);
  }
});

// `--ask` runs the whole pipeline offline, so requiring Slack tokens there
// would block the one workflow that needs no Slack at all.
/* --------------------------------------------------------- zen key pool -- */

test("collectZenKeys finds bare and numbered keys in order, filtering blanks", () => {
  const mockEnv = {
    OPENCODE_API_KEY_3: "key-3",
    OPENCODE_API_KEY: "key-1",
    OPENCODE_API_KEY_2: "key-2",
    OPENCODE_API_KEY_7: " key-7 ",
    OPENCODE_API_KEY_4: "",
    OTHER_VAR: "ignore",
  };
  const keys = collectZenKeys(mockEnv);
  assert.deepEqual(keys, ["key-1", "key-2", "key-3", "key-7"]);
});

test("nextZenApiKey skips a penalized key", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    penalizeZenKey("key-a", 10000);
    assert.equal(nextZenApiKey(), "key-b");
    assert.equal(nextZenApiKey(), "key-b");
  } finally {
    config.zenApiKeys = saved;
    penalizeZenKey("key-a", 0);
  }
});

test("an all-cooling pool still returns a key rather than undefined", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    penalizeZenKey("key-a", 5000);
    penalizeZenKey("key-b", 10000);
    assert.equal(nextZenApiKey(), "key-a");
  } finally {
    config.zenApiKeys = saved;
    penalizeZenKey("key-a", 0);
    penalizeZenKey("key-b", 0);
  }
});

test("penalizeZenKey ignores non-pool keys", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a"];
  try {
    penalizeZenKey("9router-key", 10000);
    assert.equal(nextZenApiKey(), "key-a");
  } finally {
    config.zenApiKeys = saved;
  }
});

// Order-independent on purpose: other test files also read config.answer.apiKey
// (the calling code builds that options object even with llm.complete stubbed),
// which silently advances the shared rotation counter across the whole suite.
// These assert relative rotation behaviour, never an absolute starting key.
test("nextZenApiKey returns undefined with no keys configured", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = [];
  try {
    assert.equal(nextZenApiKey(), undefined);
  } finally {
    config.zenApiKeys = saved;
  }
});

test("nextZenApiKey always returns the only configured key", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["solo-key"];
  try {
    assert.equal(nextZenApiKey(), "solo-key");
    assert.equal(nextZenApiKey(), "solo-key");
    assert.equal(nextZenApiKey(), "solo-key");
  } finally {
    config.zenApiKeys = saved;
  }
});

test("nextZenApiKey round-robins across every configured key", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    const first = nextZenApiKey();
    const second = nextZenApiKey();
    assert.notEqual(first, second);
    assert.ok(["key-a", "key-b"].includes(first));
    assert.ok(["key-a", "key-b"].includes(second));
  } finally {
    config.zenApiKeys = saved;
  }
});

// config.answer.apiKey and a zenStandby fallback both hit real Zen, so both
// must draw from the same pool rather than each keeping their own rotation —
// otherwise one call site could keep hammering an exhausted key while the
// other's copy of the pool sat on the healthy one.
test("config.answer.apiKey and zenStandby's apiKey draw from the same rotating pool", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    const standby = zenStandby("http://9router.railway.internal:20128/v1", "some-model");
    const getApiKey = (fnOrStr) => (typeof fnOrStr === "function" ? fnOrStr() : fnOrStr);
    const seen = new Set([
      getApiKey(config.answer.apiKey),
      getApiKey(standby.apiKey),
      getApiKey(config.answer.apiKey),
      getApiKey(standby.apiKey),
    ]);
    assert.deepEqual(seen, new Set(["key-a", "key-b"]));
  } finally {
    config.zenApiKeys = saved;
  }
});

// The whole Zen key pool running out of quota is the outage this exists for,
// so — unlike zenStandby() — the default standby must not also be Zen.
test("answerFallback defaults to the 9Router/Gemini endpoint, not Zen", () => {
  const saved = { ...process.env };
  delete process.env.PIXIE_ANSWER_BASE_URL;
  delete process.env.PIXIE_ANSWER_FALLBACK_BASE_URL;
  try {
    const fallback = answerFallback();
    assert.notEqual(fallback, null);
    assert.notEqual(fallback.baseUrl, ZEN_BASE_URL);
    assert.equal(fallback.model, ANSWER_FALLBACK_MODEL);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("answerFallback is null when explicitly pointed at the primary's own base", () => {
  const saved = { ...process.env };
  delete process.env.PIXIE_ANSWER_BASE_URL; // primary defaults to ZEN_BASE_URL
  process.env.PIXIE_ANSWER_FALLBACK_BASE_URL = ZEN_BASE_URL;
  try {
    assert.equal(answerFallback(), null);
  } finally {
    delete process.env.PIXIE_ANSWER_FALLBACK_BASE_URL;
    Object.assign(process.env, saved);
  }
});

test("answerFallback's apiKey prefers its own override, then intent's key, then vision's", () => {
  const saved = { ...process.env };
  delete process.env.PIXIE_ANSWER_FALLBACK_BASE_URL;
  delete process.env.PIXIE_ANSWER_FALLBACK_API_KEY;
  delete process.env.INTENT_CLASSIFIER_API_KEY;
  process.env.VISION_API_KEY = "vision-key";
  try {
    assert.equal(answerFallback().apiKey(), "vision-key");
    process.env.INTENT_CLASSIFIER_API_KEY = "intent-key";
    assert.equal(answerFallback().apiKey(), "intent-key");
    process.env.PIXIE_ANSWER_FALLBACK_API_KEY = "own-key";
    assert.equal(answerFallback().apiKey(), "own-key");
  } finally {
    delete process.env.PIXIE_ANSWER_FALLBACK_API_KEY;
    delete process.env.INTENT_CLASSIFIER_API_KEY;
    Object.assign(process.env, saved);
  }
});

test("missingVars ignores Slack vars when Slack is not needed", () => {
  const saved = { ...process.env };
  process.env.OPENCODE_API_KEY = "test-key";
  delete process.env.SLACK_BOT_TOKEN;

  try {
    assert.deepEqual(missingVars({ needsSlack: false }), []);
  } finally {
    Object.assign(process.env, saved);
  }
});
