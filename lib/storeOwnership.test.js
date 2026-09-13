const { test } = require("node:test");
const assert = require("node:assert/strict");

// Store/cache ownership map. Every durable or shared structure has exactly one
// owner and one read/write path; these tests fail if a second store, a second
// key scheme, or a second writer is introduced for the same data.
//
//   threads         owner lib/context.js (transientThreads Map)
//                   db.addThreadMessage/getThreadMessages delegate via lazy require
//   answer_cache    owner lib/cache.js (policy + SQL); connection/sweep in db.js
//                   sole writer path cache.put; sole production read lookup.cacheHit;
//                   invalidated by knowledge.refreshCorpus via answerCache.clearCache
//   source_cache    owner lib/db.js (rows); key scheme owned by lib/sourcePolicy.js
//                   (sourceCacheKey); knowledge.js reads/writes through that scheme only
//   corpus / index  owner lib/knowledge.js, per-program keys, memoized, rebuilt by
//                   invalidate() on refresh — never two live builds for one program
//   llm_usage       owner lib/db.js (recordLlmUsage); sole writer lib/modelTelemetry.js

const context = require("./context");
const db = require("./db");
const cache = require("./cache");
const lookup = require("./lookup");
const knowledge = require("./knowledge");
const sourcePolicy = require("./sourcePolicy");

/* ------------------------------------------------------- threads: 1 store -- */

test("ownership: db thread writes land in the context store and read back identically", () => {
  const ts = `own-db-write-${Date.now()}`;
  db.addThreadMessage(ts, "user", "which program is this", "U1");
  // One store, two views: the db path projects {role, content}, the context
  // path projects {text, speaker}. Both must show the same underlying row.
  const viaDb = db.getThreadMessages(ts);
  const viaContext = context.getThreadMessages(ts, 50);
  assert.ok(viaDb.length > 0 && viaContext.length > 0);
  assert.deepEqual(
    viaDb.map((m) => [m.role, m.content]),
    viaContext.map((m) => [m.speaker === "pixie" ? "assistant" : "user", m.text]),
  );
});

test("ownership: context writes are visible through the db read path (no fork)", () => {
  const ts = `own-ctx-write-${Date.now()}`;
  context.addToThread(ts, "assistant", "here is the answer", null, "C1");
  const viaDb = db.getThreadMessages(ts);
  assert.ok(viaDb.some((m) => m.role === "assistant" && /here is the answer/.test(m.content)));
});

/* --------------------------------------------- answer cache: 1 path, 1 key -- */

test("ownership: cache.put is readable through the production lookup.cacheHit path", () => {
  const q = `ownership probe question ${Date.now()}`;
  cache.put(q, { source: "Pixl Docs", answer: "yes, that works" }, "prog-own");
  const hit = lookup.cacheHit(q, "", "prog-own");
  assert.ok(hit);
  assert.equal(hit.answer, "yes, that works");
});

test("ownership: answer cache is tenant-isolated by program key", () => {
  const q = `ownership tenant probe ${Date.now()}`;
  cache.put(q, { source: "Pixl Docs", answer: "program a answer" }, "prog-a");
  assert.equal(lookup.cacheHit(q, "", "prog-b"), null);
  assert.ok(lookup.cacheHit(q, "", "prog-a"));
});

test("ownership: clearCache converges readers (refresh invalidation has one switch)", () => {
  const q = `ownership clear probe ${Date.now()}`;
  cache.put(q, { source: "Pixl Docs", answer: "temporary" }, "prog-own");
  assert.ok(lookup.cacheHit(q, "", "prog-own"));
  cache.clearCache();
  assert.equal(lookup.cacheHit(q, "", "prog-own"), null);
});

/* ------------------------------------------- source keys: 1 scheme, 1 owner -- */

test("ownership: same display name in two programs keys apart (no cross reads)", () => {
  const a = sourcePolicy.sourceCacheKey({ name: "Docs", url: "https://a.example/docs" });
  const b = sourcePolicy.sourceCacheKey({ name: "Docs", url: "https://b.example/docs" });
  assert.ok(a && b && a !== b);
});

test("ownership: inline and fetched sources never share a key", () => {
  const inline = sourcePolicy.sourceCacheKey({ name: "FAQ", type: "json-faq", content: [{ q: "x" }] });
  const fetched = sourcePolicy.sourceCacheKey({ name: "FAQ", type: "json-faq", url: "https://x.example/faq.json" });
  assert.ok(inline && fetched && inline !== fetched);
});

/* ---------------------------------------------- corpus/index: 1 live build -- */

test("ownership: corpus and index memoize per program (no duplicate builds)", () => {
  const firstCorpus = knowledge.getCorpus("pixl");
  assert.equal(knowledge.getCorpus("pixl"), firstCorpus);
  assert.equal(knowledge.getIndex("pixl"), knowledge.getIndex("pixl"));
});
