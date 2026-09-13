process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const cache = require("./cache");

db.open(":memory:");

// The key is a sorted set of meaningful words, not the sentence: filler and
// word order are exactly the noise that split one answer across several keys.
test("normalize collapses punctuation, case, spacing and filler", () => {
  assert.equal(cache.normalize("Whats  the DEADLINE??"), "deadline");
});

test("normalize drops user mentions so a ping does not split the key", () => {
  assert.equal(cache.normalize("<@U0PIXIE> whats the deadline"), "deadline");
});

// Contracted and apostrophised question words have to reduce the same way, or
// the same question asked two ordinary ways is two cache entries.
test("keyFor treats a contraction and its apostrophe form as one question", () => {
  assert.equal(cache.keyFor("What's Restoration Energy?"), cache.keyFor("whats restoration energy"));
  assert.equal(cache.keyFor("wheres the game"), cache.keyFor("where is the game"));
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

test("keyFor preserves the legacy question-only hash when program ID is omitted", () => {
  assert.equal(cache.keyFor("whats the deadline?"), "e23839cd729a3f6017fc6cbf5ef21eeb64d77cdf");
});

// This is the case the old exact-string key missed, and it is most of why the
// measured hit rate was 2.6%: one question, three phrasings, three misses.
test("keyFor survives a reworded question", () => {
  const asked = cache.keyFor("when is the deadline");
  assert.equal(cache.keyFor("the deadline is when?"), asked);
  assert.equal(cache.keyFor("deadline?"), cache.keyFor("deadline"));
});

test("keyFor differs for genuinely different questions", () => {
  assert.notEqual(cache.keyFor("whats the deadline"), cache.keyFor("where do i play"));
  // Sharing a keyword is not sharing a question.
  assert.notEqual(cache.keyFor("how do i submit my project"), cache.keyFor("can i submit late"));
});

// Every word is filler, so there is nothing to key on. Returning a key anyway
// would put "what is it" and "how do you do that" in the same cache slot and
// serve one of them the other's reply.
test("keyFor refuses a question with no meaningful words", () => {
  assert.equal(cache.normalize("what is it"), "");
  assert.equal(cache.keyFor("what is it"), null);

  cache.put("what is it", { source: "Pixl FAQ", answer: "nope" });
  assert.equal(cache.get("what is it"), null);
  assert.equal(cache.get("how do you do that"), null);
});

test("get returns null on a miss and the stored result on a hit", () => {
  assert.equal(cache.get("never asked before"), null);

  cache.put("how do i join", { source: "Pixl FAQ", answer: "just sign up at play.pixl.rsvp" });
  assert.deepEqual(cache.get("How do I join?"), {
    source: "Pixl FAQ",
    answer: "just sign up at play.pixl.rsvp",
  });
});

test("cache keeps the same normalized question isolated by program ID", () => {
  const question = "when is the deadline?";

  cache.put(question, { source: "Pixl FAQ", answer: "august 18" }, undefined, "pixl");
  cache.put(question, { source: "Sprig FAQ", answer: "september 30" }, undefined, "sprig");

  assert.notEqual(cache.keyFor(question, "pixl"), cache.keyFor(question, "sprig"));
  assert.deepEqual(cache.get(question, "pixl"), { source: "Pixl FAQ", answer: "august 18" });
  assert.deepEqual(cache.get(question, "sprig"), { source: "Sprig FAQ", answer: "september 30" });
});

/* --------------------------------------------------------- staleness -- */

// A stale answer is normally fine to serve — the warmer regenerates it behind
// the scenes, and the wording of a rule doesn't change between refreshes.
test("an aged answer is still served, so a popular question stays instant", () => {
  cache.put("how do i unlock a region", { source: "Pixl Docs", answer: "finish the sidequests" });
  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, refreshed_at = ? WHERE question_hash = ?")
    .run(1, 1, cache.keyFor("how do i unlock a region"));

  assert.equal(cache.get("how do i unlock a region").answer, "finish the sidequests");
});

// Except the timeline, whose answers carry a live countdown. Yesterday's copy
// of "august 18 — in 21 days" is not merely old, it is wrong, and wrong about
// the single most-asked category.
test("an aged timeline answer is refused rather than served", () => {
  cache.put("when does pixl launch", { source: "Program timeline", answer: "august 18 — in 21 days" });
  assert.equal(cache.get("when does pixl launch").answer, "august 18 — in 21 days");

  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, refreshed_at = ? WHERE question_hash = ?")
    .run(1, 1, cache.keyFor("when does pixl launch"));

  assert.equal(cache.get("when does pixl launch"), null, "a countdown must never be served from yesterday");
});

test("isVolatile matches the timeline section however it is cased", () => {
  assert.equal(cache.isVolatile("Program timeline"), true);
  assert.equal(cache.isVolatile("  program TIMELINE "), true);
  assert.equal(cache.isVolatile("Pixl FAQ"), false);
  assert.equal(cache.isVolatile(null), false);
});

/* ------------------------------------------- STEP 1 characterization pins -- */

test("keyFor is sha1(programId:sorted tokens) and strictly tenant-isolated", () => {
  const crypto = require("crypto");
  const q = "when is the char deadline?";
  const normalized = cache.normalize(q);
  const expectPlain = crypto.createHash("sha1").update(normalized).digest("hex");
  const expectScoped = crypto.createHash("sha1").update(`char-prog:${normalized}`).digest("hex");
  assert.equal(cache.keyFor(q), expectPlain);
  assert.equal(cache.keyFor(q, "char-prog"), expectScoped);
  assert.notEqual(cache.keyFor(q, "char-prog"), cache.keyFor(q, "other-prog"));

  // No cross-tenant fallback: an answer stored for one program never serves another.
  cache.put(q, { source: "Docs", answer: "august 18" }, undefined, "char-prog-a");
  assert.equal(cache.get(q, "char-prog-b"), null);
  assert.equal(cache.get(q), null);
  assert.deepEqual(cache.get(q, "char-prog-a"), { source: "Docs", answer: "august 18" });
});

test("fresh volatile answers serve but stale volatile answers bypass", () => {
  cache.put("char volatile q", { source: "Program timeline", answer: "launch soon" });
  assert.equal(cache.get("char volatile q").answer, "launch soon");
  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, refreshed_at = ? WHERE question_hash = ?")
    .run(1, 1, cache.keyFor("char volatile q"));
  assert.equal(cache.get("char volatile q"), null);
});

test("cache layer itself is unconditional — !contextPrompt guard lives in the caller", () => {
  // lib/lookup.js checks `if (contextPrompt) return null` before touching the
  // cache. cache.get/put take no contextPrompt, so they must store regardless;
  // pinning that here so a rewrite does not silently add filtering here while
  // the caller still filters (double-guard) or remove it there (leak).
  cache.put("char unconditional q", { source: "Docs", answer: "stored" });
  assert.ok(cache.get("char unconditional q"));
  assert.equal(cache.put.length >= 2, true);
});

test("cache hits increment ask_count and last_asked_at, while peeks remain read-only", () => {
  cache.clearCache();
  const question = "cache counter characterization question";
  cache.put(question, { source: "Docs", answer: "answer" }, undefined, "counter-tenant");
  const hash = cache.keyFor(question, "counter-tenant");
  assert.equal(cache.peekCachedAnswer(hash).askCount, 1);
  assert.ok(db.handle().query("SELECT last_asked_at FROM answer_cache WHERE question_hash = ?").get(hash).last_asked_at > 0);
  assert.deepEqual(cache.get(question, "counter-tenant"), { source: "Docs", answer: "answer" });
  const row = db.handle().query("SELECT ask_count, last_asked_at FROM answer_cache WHERE question_hash = ?").get(hash);
  assert.equal(row.ask_count, 2);
  assert.ok(row.last_asked_at > 0);
});

test("refresh changes the answer without resetting counters", () => {
  cache.clearCache();
  const question = "refresh characterization question";
  cache.put(question, { source: "Docs", answer: "old" }, undefined, "refresh-tenant");
  assert.equal(cache.get(question, "refresh-tenant").answer, "old");
  cache.put(question, { source: "Docs", answer: "new" }, { refreshed: true }, "refresh-tenant");
  assert.equal(cache.get(question, "refresh-tenant").answer, "new");
  const row = db.handle().query("SELECT ask_count, last_asked_at, refreshed_at FROM answer_cache WHERE question_hash = ?").get(cache.keyFor(question, "refresh-tenant"));
  assert.equal(row.ask_count, 3);
  assert.ok(row.last_asked_at > 0);
  assert.ok(row.refreshed_at > 0);
});

test("cache rows survive a persistence restart and idle rows are swept", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-cache-"));
  const filename = path.join(directory, "cache.db");
  const question = "restart compatibility question";
  try {
    db.close();
    db.open(filename);
    cache.put(question, { source: "Docs", answer: "durable" }, undefined, "restart-tenant");
    assert.equal(cache.get(question, "restart-tenant").answer, "durable");
    db.close();
    db.open(filename);
    assert.equal(cache.get(question, "restart-tenant").answer, "durable");
    db.handle().query("UPDATE answer_cache SET last_asked_at = ? WHERE question_hash = ?").run(1, cache.keyFor(question, "restart-tenant"));
    db.sweep();
    assert.equal(cache.get(question, "restart-tenant"), null);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    db.open(":memory:");
  }
});
