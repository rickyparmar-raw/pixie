process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const cache = require("./cache");

db.open(":memory:");

test("normalize collapses punctuation, case and spacing", () => {
  assert.equal(cache.normalize("Whats  the DEADLINE??"), "whats the deadline");
});

test("normalize drops user mentions so a ping does not split the key", () => {
  assert.equal(cache.normalize("<@U0PIXIE> whats the deadline"), "whats the deadline");
});

// The same question asked three slightly different ways should be one cache
// entry, not three.
test("keyFor is stable across wording noise", () => {
  const a = cache.keyFor("whats the deadline?");
  const b = cache.keyFor("Whats the deadline");
  const c = cache.keyFor("  whats   the  deadline!!  ");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("keyFor differs for genuinely different questions", () => {
  assert.notEqual(cache.keyFor("whats the deadline"), cache.keyFor("where do i play"));
});

test("get returns null on a miss and the stored result on a hit", () => {
  assert.equal(cache.get("never asked before"), null);

  cache.put("how do i join", { source: "Pixl FAQ", answer: "just sign up at play.pixl.rsvp" });
  assert.deepEqual(cache.get("How do I join?"), {
    source: "Pixl FAQ",
    answer: "just sign up at play.pixl.rsvp",
  });
});
