const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBaseUrl, missingVars, isAdmin, config, ZEN_BASE_URL } = require("./config");

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
