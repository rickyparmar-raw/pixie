process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jev = require("./jevDecision");

// The channel gate is an optional allowlist: when Jev is enabled and no
// allowlist is configured, Jev applies everywhere. Scoping rollout is opt-in
// via JEV_CANARY_CHANNEL_IDS, never accidental silence.
const enabledCfg = (extra = {}) => ({ enabled: true, experientialApiKeyPresent: true, model: "jev-latest:free", ...extra });

test("unset allowlist means active in every channel", () => {
  assert.equal(jev.isJevActiveForChannel("C0BK4F6STFZ", enabledCfg()), true);
  assert.equal(jev.isJevActiveForChannel("C-other", enabledCfg()), true);
});

test("empty allowlist means active in every channel", () => {
  assert.equal(jev.isJevActiveForChannel("C0BK4F6STFZ", enabledCfg({ canaryChannels: [] })), true);
});

test("explicit allowlist restricts to listed channels", () => {
  const cfg = enabledCfg({ canaryChannels: ["C0BK4F6STFZ"] });
  assert.equal(jev.isJevActiveForChannel("C0BK4F6STFZ", cfg), true);
  assert.equal(jev.isJevActiveForChannel("C-other", cfg), false);
});

test("disabled Jev is active nowhere, even with an allowlist", () => {
  const cfg = { enabled: false, experientialApiKeyPresent: true, model: "jev-latest:free", canaryChannels: ["C0BK4F6STFZ"] };
  assert.equal(jev.isJevActiveForChannel("C0BK4F6STFZ", cfg), false);
  assert.equal(jev.isJevActiveForChannel("C0BK4F6STFZ", enabledCfg()), true);
});

test("missing key material disables the gate", () => {
  const cfg = { enabled: true, experientialApiKeyPresent: false, model: "jev-latest:free" };
  assert.equal(jev.isEnabled(cfg), false);
  assert.equal(jev.isJevActiveForChannel("C-any", cfg), false);
});
