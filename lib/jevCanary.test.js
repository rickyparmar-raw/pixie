process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const programs = require("./programs");
const jev = require("./jevDecision");

test("C0BK4F6STFZ is a Pixl normal program channel, not the help channel", () => {
  const program = programs.forChannel("C0BK4F6STFZ");
  assert.equal(program.id, "pixl");
  assert.notEqual(program.helpChannel, "C0BK4F6STFZ");
  assert.ok(program.channels.includes("C0BK4F6STFZ"));
});

test("canary remains explicit and never globally enables Jev", () => {
  const cfg = { enabled: true, gatewayApiKeyPresent: true, provider: "vercel", canaryChannels: ["C0BK4F6STFZ"] };
  assert.equal(jev.isJevActiveForChannel("C0BK4F6STFZ", cfg), true);
  assert.equal(jev.isJevActiveForChannel("C-other", cfg), false);
  assert.equal(jev.isJevActiveForChannel("C0BK4F6STFZ", { ...cfg, canaryChannels: [] }), false);
});
