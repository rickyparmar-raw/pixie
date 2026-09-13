// Pure source-resolution policy for lib/knowledge.js.
//
// No I/O here: no require of ./db, ./programs, ./shop, ./cache. Callers in
// knowledge.js assemble plain-data inputs (health rows, cache presence,
// program source lists, shop-question booleans) and delegate. Every function
// below is a byte-for-byte decision copy of the logic that lived inline in
// knowledge.js, so observable behavior is unchanged.
const crypto = require("crypto");

// Storage key for one source's last-good text. Namespaced by location, not
// just name: two hosted programs can each have a "Docs" source pointing at
// different URLs, and a bare-name key would let one program's fetch overwrite
// the other's fallback. Identical name+URL shares the row, which is safe
// because the content is byte-identical by construction. Inline sources have
// no URL, so their content is part of the location identity instead.
function sourceCacheKey(source) {
  if (!source || !source.name) return null;
  if (source.url) return `${source.name}::${source.url}`;
  const inlineIdentity = JSON.stringify({ type: source.type, content: source.content });
  const digest = crypto.createHash("sha256").update(inlineIdentity).digest("hex");
  return `${source.name}::inline::${digest}`;
}

function isDynamicSource(source) {
  return Boolean(source && (source.dynamic === true || source.type === "pixl-shop" || source.type === "live-shop"));
}

// Pure twin of the former knowledge.sourceFreshness. healthRow is a plain
// {last_success_at, fail_count, last_error} row (or null when no row exists);
// hasLastGood is the caller's cache-presence input (knowledge.js passes
// Boolean(row?.last_success_at) || cache.has(memKey)). The last-success term
// is OR-ed here as well so callers may pass only the memory-cache bit and
// still get the exact historical result.
function freshnessFromRow(source, healthRow, hasLastGood) {
  const key = sourceCacheKey(source);
  if (!key) return {
    key: null,
    name: source?.name || null,
    authority: "unknown",
    freshness: "unavailable",
    lastSuccessAt: null,
    failCount: 0,
    lastError: null,
    hasLastGood: false,
  };

  const lastSuccessAt = healthRow?.last_success_at || null;
  const failCount = Number(healthRow?.fail_count || 0);
  const hasGood = Boolean(lastSuccessAt) || Boolean(hasLastGood);
  const freshness = !hasGood ? "unavailable" : failCount > 0 ? "stale" : "fresh";

  return {
    key,
    name: source.name,
    authority: isDynamicSource(source) ? "dynamic" : "static",
    freshness,
    lastSuccessAt,
    failCount,
    lastError: healthRow?.last_error || null,
    hasLastGood: hasGood,
  };
}

// Consumers that make exact claims can use this boundary without needing to
// know how source_cache is persisted. A stale dynamic source remains usable as
// last-good context, but is not eligible to authorize an exact current claim.
function eligibilityFromFreshness(metadata) {
  const exactClaimsAllowed = metadata.freshness === "fresh" ||
    (metadata.authority !== "dynamic" && metadata.freshness === "stale");
  return {
    ...metadata,
    exactClaimsAllowed,
    eligible: metadata.hasLastGood,
  };
}

// Pure twin of the former knowledge.excludedSources. programSources and
// sharedSources are already-resolved plain arrays (the caller applies the
// sharedSources === false rule). isShopQuestion is the precomputed boolean
// (shop.isShopQuestion(question)) from the caller.
function excludedSourceNames({ programSources, sharedSources, isShopQuestion } = {}) {
  const progSources = Array.isArray(programSources) ? programSources : [];
  const shared = Array.isArray(sharedSources) ? sharedSources : [];
  const all = [...progSources, ...shared];
  const shopSources = all.filter((s) => s && (s.type === "pixl-shop" || s.type === "live-shop"));
  if (shopSources.length === 0) return null;
  if (Boolean(isShopQuestion)) return null;
  return new Set(shopSources.map((s) => s.name));
}

module.exports = {
  sourceCacheKey,
  isDynamicSource,
  freshnessFromRow,
  eligibilityFromFreshness,
  excludedSourceNames,
};
