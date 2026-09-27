// Cache policy and storage stay together because freshness, staleness, and retention
// are one contract: context-free answers may be reused, threaded answers may not.
import crypto = require("node:crypto");
import db = require("./db");
import retrieve = require("./retrieve");

interface CacheRow {
  question_hash?: string;
  question: string;
  source: string | null;
  answer: string;
  ask_count: number;
  written_at: number;
}

interface CacheResult {
  source?: string | null;
  answer: string;
}

interface CacheOptions {
  refreshed?: boolean;
}

const VOLATILE_SOURCE = "Program timeline";

function isVolatile(source: string | null | undefined) {
  // Timeline answers contain a countdown, so an old hit is incorrect rather than merely stale.
  if (!source) return false;
  return String(source).trim().toLowerCase() === VOLATILE_SOURCE.toLowerCase();
}

function normalize(question: string) {
  // Sorted meaningful terms make filler and word order irrelevant to the cache key.
  const terms = retrieve.tokenize((question || "").replace(/<@[^>]+>/g, " "));
  return [...new Set(terms)].sort().join(" ");
}

function keyFor(question: string, programId: string | null = null) {
  const normalized = normalize(question);
  if (!normalized) return null;
  // Program identity is part of the key; identical questions must not cross tenant boundaries.
  const input = programId ? `${programId}:${normalized}` : normalized;
  return crypto.createHash("sha1").update(input).digest("hex");
}

function get(question: string, programId: string | null = null) {
  const key = keyFor(question, programId);
  if (!key) return null;
  const hit = getCachedAnswer(key);
  if (!hit) return null;
  // Non-volatile entries can be served while a background refresh catches up.
  if (isVolatile(hit.source) && hit.ageMs > db.CACHE_FRESH_MS) return null;
  return { source: hit.source, answer: hit.answer };
}

function put(
  question: string,
  result: CacheResult,
  options: CacheOptions | string = {},
  programId: string | null = null,
) {
  // The legacy string overload is retained for callers that passed programId as the third argument.
  if (typeof options === "string") {
    programId = options;
    options = {};
  }
  const key = keyFor(question, programId);
  if (!key) return;
  putCachedAnswer(key, question, result, options || {});
}

function cacheRow(hash: string) {
  return db
    .handle()
    .query(
      "SELECT source, answer, ask_count, COALESCE(refreshed_at, created_at) AS written_at FROM answer_cache WHERE question_hash = ?",
    )
    .get(hash) as CacheRow | null;
}

function peekCachedAnswer(hash: string) {
  // Peeking is read-only because dashboards must not change popularity statistics.
  const row = cacheRow(hash);
  if (!row) return null;
  return { source: row.source, answer: row.answer, askCount: row.ask_count, ageMs: db.now() - row.written_at };
}

function getCachedAnswer(hash: string) {
  const hit = peekCachedAnswer(hash);
  if (!hit) return null;
  // A read counts as an ask; inspection uses peekCachedAnswer and must not bump it.
  db.handle()
    .query("UPDATE answer_cache SET ask_count = ask_count + 1, last_asked_at = ? WHERE question_hash = ?")
    .run(db.now(), hash);
  return hit;
}

function putCachedAnswer(
  hash: string,
  question: string,
  result: CacheResult,
  { refreshed = false }: CacheOptions = {},
) {
  // Refreshes replace the answer without pretending that somebody asked again.
  const t = db.now();
  db.handle()
    .query(
      `INSERT INTO answer_cache (question_hash, question, source, answer, created_at, last_asked_at, refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(question_hash) DO UPDATE SET
         source = excluded.source, answer = excluded.answer, refreshed_at = excluded.refreshed_at`,
    )
    .run(hash, question, result.source || null, result.answer, t, refreshed ? null : t, t);
}

function staleCacheEntries(staleAfterMs: number, limit: number) {
  // Warm popular stale rows first; idle cleanup is a separate retention decision.
  return db
    .handle()
    .query(
      `SELECT question_hash, question, ask_count FROM answer_cache
       WHERE COALESCE(refreshed_at, created_at) < ?
       ORDER BY ask_count DESC, COALESCE(refreshed_at, created_at) ASC
       LIMIT ?`,
    )
    .all(db.now() - staleAfterMs, limit);
}

function cachedCount() {
  const row = db.handle().query("SELECT COUNT(*) AS n FROM answer_cache").get() as { n: number } | null;
  return row?.n || 0;
}

function topCached(limit = 5): CacheRow[] {
  return db
    .handle()
    .query(
      "SELECT question_hash, question, ask_count, source, COALESCE(refreshed_at, created_at) AS written_at FROM answer_cache ORDER BY ask_count DESC, question LIMIT ?",
    )
    .all(limit) as CacheRow[];
}

function clearCache() {
  db.handle().query("DELETE FROM answer_cache").run();
}

function forget(hash: string) {
  db.handle().query("DELETE FROM answer_cache WHERE question_hash = ?").run(hash);
}

export = {
  get,
  put,
  keyFor,
  normalize,
  isVolatile,
  VOLATILE_SOURCE,
  getCachedAnswer,
  peekCachedAnswer,
  putCachedAnswer,
  staleCacheEntries,
  cachedCount,
  topCached,
  clearCache,
  forget,
};
