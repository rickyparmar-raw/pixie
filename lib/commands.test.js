process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseForgetInput, parseId } = require("./commands");

test("parseForgetInput parses single ids, ranges, pending, and all", () => {
  assert.deepEqual(parseForgetInput("15"), { type: "id", id: 15 });
  assert.deepEqual(parseForgetInput("#15"), { type: "id", id: 15 });

  assert.deepEqual(parseForgetInput("12-40"), { type: "range", from: 12, to: 40 });
  assert.deepEqual(parseForgetInput("#12-#40"), { type: "range", from: 12, to: 40 });

  assert.deepEqual(parseForgetInput("pending"), { type: "pending" });
  assert.deepEqual(parseForgetInput("PENDING"), { type: "pending" });

  assert.deepEqual(parseForgetInput("all"), { type: "all" });
  // 'all' requires exact literal matching, not prefix
  assert.equal(parseForgetInput("allofit"), null);
  assert.equal(parseForgetInput("invalid"), null);
});

test("parseId accepts a bare or hashed id and rejects anything else", () => {
  assert.equal(parseId("7"), 7);
  assert.equal(parseId("#7"), 7);
  assert.equal(parseId(" 7 "), 7);
  assert.equal(parseId("0"), null);
  assert.equal(parseId("-3"), null);
  assert.equal(parseId("seven"), null);
  assert.equal(parseId(""), null);
});
