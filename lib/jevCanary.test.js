process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jev = require("./jevDecision");

test("missing key material disables the gate", () => {
  const cfg = { enabled: true, experientialApiKeyPresent: false, model: "jev-latest:free" };
  assert.equal(jev.isEnabled(cfg), false);
});

test("disabled flag disables the gate", () => {
  assert.equal(jev.isEnabled({ enabled: false, experientialApiKeyPresent: true, model: "jev-latest:free" }), false);
  assert.equal(jev.isEnabled({ enabled: true, experientialApiKeyPresent: true, model: "jev-latest:free" }), true);
});

test("there is no per-channel Jev allowlist: engagement scope is a program setting", () => {
  assert.equal(jev.isJevActiveForChannel, undefined);
});
