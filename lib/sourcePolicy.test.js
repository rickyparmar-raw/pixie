const { test } = require("node:test");
const assert = require("node:assert/strict");

// Source-policy matrix, asserted against the pure lib/sourcePolicy.js module.
// Knowledge.js keeps thin wrappers that assemble I/O inputs and delegate;
// spot delegation checks at the bottom prove the wrappers stayed identical.

const policy = require("./sourcePolicy");

const T = 1757800000000;

function cleanKey(db, key) {
  try {
    db.handle().query("DELETE FROM source_cache WHERE name = ?").run(key);
  } catch (_) {}
}

test("policy module is pure: no store or service requires", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "sourcePolicy.js"), "utf8");
  for (const banned of ["./db", "./programs", "./shop", "./cache", "./liveShop", "./sourceGuard"]) {
    assert.doesNotMatch(src, new RegExp(`require\\(["']${banned.replace("./", ".\\/")}["']\\)`), `must not require ${banned}`);
  }
});

test("sourceCacheKey namespaces by location, including inline content", () => {
  assert.equal(policy.sourceCacheKey({ name: "Docs", url: "https://example.com/a" }), "Docs::https://example.com/a");
  const faqKey = policy.sourceCacheKey({ name: "FAQ", type: "json-faq", content: [{ question: "q", answer: "a" }] });
  assert.match(faqKey, /^FAQ::inline::[a-f0-9]{64}$/);
  assert.notEqual(faqKey, policy.sourceCacheKey({ name: "FAQ", type: "json-faq", content: [{ question: "q", answer: "different" }] }));
  assert.match(policy.sourceCacheKey({ name: "NoUrl", url: undefined, content: "hi" }), /^NoUrl::inline::[a-f0-9]{64}$/);
  assert.equal(policy.sourceCacheKey({ url: "https://example.com" }), null);
  assert.equal(policy.sourceCacheKey(null), null);
});

test("isDynamicSource: shop types and the dynamic flag", () => {
  assert.equal(policy.isDynamicSource({ name: "A", type: "pixl-shop", url: "https://x" }), true);
  assert.equal(policy.isDynamicSource({ name: "B", type: "live-shop", url: "https://x" }), true);
  assert.equal(policy.isDynamicSource({ name: "C", type: "url", url: "https://x", dynamic: true }), true);
  assert.equal(policy.isDynamicSource({ name: "D", type: "url", url: "https://x" }), false);
  assert.equal(policy.isDynamicSource({ name: "E", type: "text", content: "hi" }), false);
  assert.equal(policy.isDynamicSource(null), false);
  assert.equal(policy.isDynamicSource(undefined), false);
});

test("freshness matrix: static fresh source is fresh and exact-claim eligible", () => {
  const source = { name: "SP Static Fresh", type: "text", url: "https://example.com/sp-static-fresh" };
  const key = policy.sourceCacheKey(source);
  const meta = policy.freshnessFromRow(source, { last_success_at: T, fail_count: 0, last_error: null }, true);
  assert.deepEqual(meta, {
    key,
    name: source.name,
    authority: "static",
    freshness: "fresh",
    lastSuccessAt: T,
    failCount: 0,
    lastError: null,
    hasLastGood: true,
  });

  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.exactClaimsAllowed, true);
  assert.equal(elig.eligible, true);
});

test("freshness matrix: static stale source allows exact claims but stays eligible", () => {
  const source = { name: "SP Static Stale", type: "json-faq", url: "https://example.com/sp-static-stale" };
  const key = policy.sourceCacheKey(source);
  const meta = policy.freshnessFromRow(source, { last_success_at: T, fail_count: 1, last_error: "static endpoint offline" }, true);
  assert.deepEqual(meta, {
    key,
    name: source.name,
    authority: "static",
    freshness: "stale",
    lastSuccessAt: T,
    failCount: 1,
    lastError: "static endpoint offline",
    hasLastGood: true,
  });

  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.exactClaimsAllowed, true);
  assert.equal(elig.eligible, true);
});

test("freshness matrix: static source with no successful refresh is unavailable and ineligible", () => {
  const source = { name: "SP Static Missing", type: "url", url: "https://example.com/sp-static-missing" };
  const key = policy.sourceCacheKey(source);
  const meta = policy.freshnessFromRow(source, { last_success_at: null, fail_count: 1, last_error: "never came up" }, false);
  assert.deepEqual(meta, {
    key,
    name: source.name,
    authority: "static",
    freshness: "unavailable",
    lastSuccessAt: null,
    failCount: 1,
    lastError: "never came up",
    hasLastGood: false,
  });

  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.exactClaimsAllowed, false);
  assert.equal(elig.eligible, false);
});

test("freshness matrix: null health row without a good copy is unavailable", () => {
  const source = { name: "SP No Row", type: "url", url: "https://example.com/sp-no-row" };
  const meta = policy.freshnessFromRow(source, null, false);
  assert.equal(meta.freshness, "unavailable");
  assert.equal(meta.lastSuccessAt, null);
  assert.equal(meta.failCount, 0);
  assert.equal(meta.lastError, null);
  assert.equal(meta.hasLastGood, false);
  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.exactClaimsAllowed, false);
  assert.equal(elig.eligible, false);
});

test("freshness matrix: dynamic fresh source is fresh and exact-claim eligible", () => {
  const source = { name: "SP Dynamic Fresh", type: "live-shop", url: "https://example.com/sp-dynamic-fresh" };
  const meta = policy.freshnessFromRow(source, { last_success_at: T, fail_count: 0, last_error: null }, true);
  assert.equal(meta.authority, "dynamic");
  assert.equal(meta.freshness, "fresh");
  assert.equal(meta.failCount, 0);
  assert.equal(meta.hasLastGood, true);

  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.exactClaimsAllowed, true);
  assert.equal(elig.eligible, true);
});

test("freshness matrix: dynamic stale source cannot authorize exact claims", () => {
  const source = { name: "SP Dynamic Stale", type: "live-shop", url: "https://example.com/sp-dynamic-stale" };
  const key = policy.sourceCacheKey(source);
  const meta = policy.freshnessFromRow(source, { last_success_at: T, fail_count: 1, last_error: "dynamic endpoint offline" }, true);
  assert.deepEqual(meta, {
    key,
    name: source.name,
    authority: "dynamic",
    freshness: "stale",
    lastSuccessAt: T,
    failCount: 1,
    lastError: "dynamic endpoint offline",
    hasLastGood: true,
  });

  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.exactClaimsAllowed, false);
  assert.equal(elig.eligible, true);
});

test("freshness matrix: dynamic source with no success is unavailable", () => {
  const source = { name: "SP Dynamic Missing", type: "pixl-shop", url: "https://example.com/sp-dynamic-missing" };
  const meta = policy.freshnessFromRow(source, { last_success_at: null, fail_count: 2, last_error: "dynamic never came up" }, false);
  assert.equal(meta.authority, "dynamic");
  assert.equal(meta.freshness, "unavailable");
  assert.equal(meta.hasLastGood, false);

  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.exactClaimsAllowed, false);
  assert.equal(elig.eligible, false);
});

test("freshness matrix: last success alone implies a good copy even when the cache bit is false", () => {
  const source = { name: "SP Success Only", type: "text", url: "https://example.com/sp-success-only" };
  const meta = policy.freshnessFromRow(source, { last_success_at: T, fail_count: 1, last_error: "blip" }, false);
  assert.equal(meta.hasLastGood, true);
  assert.equal(meta.freshness, "stale");
});

test("freshness matrix: keyless source yields unknown/unavailable shape", () => {
  const meta = policy.freshnessFromRow({ type: "url" }, { last_success_at: T, fail_count: 0, last_error: null }, true);
  assert.deepEqual(meta, {
    key: null,
    name: null,
    authority: "unknown",
    freshness: "unavailable",
    lastSuccessAt: null,
    failCount: 0,
    lastError: null,
    hasLastGood: false,
  });

  const elig = policy.eligibilityFromFreshness(meta);
  assert.equal(elig.authority, "unknown");
  assert.equal(elig.freshness, "unavailable");
  assert.equal(elig.exactClaimsAllowed, false);
  assert.equal(elig.eligible, false);
});

test("excludedSourceNames: no shop sources returns null", () => {
  assert.equal(
    policy.excludedSourceNames({
      programSources: [{ name: "Plain Docs", type: "url", url: "https://example.com/docs" }],
      sharedSources: [],
      isShopQuestion: false,
      question: "my widget keeps crashing",
    }),
    null,
  );
});

test("excludedSourceNames: shop question returns null even with shop sources", () => {
  const shopSources = [{ name: "Pixl Shop", type: "pixl-shop", url: "https://x" }];
  assert.equal(
    policy.excludedSourceNames({ programSources: shopSources, sharedSources: [], isShopQuestion: true, question: "what is in the shop" }),
    null,
  );
});

test("excludedSourceNames: non-shop question with shop sources returns the shop name set", () => {
  const excluded = policy.excludedSourceNames({
    programSources: [
      { name: "Docs", type: "url", url: "https://example.com/docs" },
      { name: "Pixl Shop", type: "pixl-shop", url: "https://x/shop" },
    ],
    sharedSources: [{ name: "Live Shop", type: "live-shop", url: "https://x/live" }],
    isShopQuestion: false,
    question: "my widget keeps crashing",
  });
  assert.ok(excluded instanceof Set);
  assert.deepEqual([...excluded].sort(), ["Live Shop", "Pixl Shop"]);
});

/* --------------------------------- wrapper delegation parity -- */
// The thin knowledge.js wrappers must keep returning exactly what the policy
// module computes from the same inputs.

test("delegation: knowledge.sourceCacheKey matches the policy", () => {
  const knowledge = require("./knowledge");
  const source = { name: "SP Deleg Key", type: "text", url: "https://example.com/sp-deleg-key" };
  assert.equal(knowledge.sourceCacheKey(source), policy.sourceCacheKey(source));
});

test("delegation: knowledge.sourceFreshness/sourceEligibility match the policy", () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const source = { name: "SP Deleg Fresh", type: "text", url: "https://example.com/sp-deleg-fresh" };
  const key = policy.sourceCacheKey(source);
  cleanKey(db, key);
  db.saveSourceText(key, "delegation copy");
  try {
    assert.deepEqual(knowledge.sourceFreshness(source), policy.freshnessFromRow(source, db.getSourceHealth([key])[0] || null, true));
    assert.deepEqual(knowledge.sourceEligibility(source), policy.eligibilityFromFreshness(knowledge.sourceFreshness(source)));
  } finally {
    cleanKey(db, key);
  }
});

test("delegation: knowledge.excludedSources pins (no shop sources, shop question, exclusion set)", () => {
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    {
      id: "sp-noshop",
      name: "No Shop",
      sharedSources: false,
      sources: [{ name: "Plain Docs", type: "url", url: "https://example.com/docs" }],
    },
  ]);
  programs.invalidate();
  try {
    assert.equal(knowledge.excludedSources("sp-noshop", "my widget keeps crashing"), null);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
  assert.equal(knowledge.excludedSources("pixl", "what is in the shop"), null);
  const excluded = knowledge.excludedSources("pixl", "my widget keeps crashing");
  assert.ok(excluded instanceof Set);
  assert.ok(excluded.has("Pixl Shop"));
});
