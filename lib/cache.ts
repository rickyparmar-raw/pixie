

import crypto = require("node:crypto");
import db = require("./db");
import retrieve = require("./retrieve");

interface CacheRow {
  source: string | null;
  answer: string;
  ask_count: number;
  written_at: number;
}


type UntypedInput = any;
const VOLATILE_SOURCE = "Program timeline";


function isVolatile(source: UntypedInput) {
  if (!source) return false;
  return String(source).trim().toLowerCase() === VOLATILE_SOURCE.toLowerCase();
}


function normalize(question: UntypedInput) {
  const terms = retrieve.tokenize((question || "").replace(/<@[^>]+>/g, " "));
  return [...new Set(terms)].sort().join(" ");
}


function keyFor(question: UntypedInput, programId: string | null = null) {
  const normalized = normalize(question);
  if (!normalized) return null;
  const input = programId ? `${programId}:${normalized}` : normalized;
  return crypto.createHash("sha1").update(input).digest("hex");
}

function get(question: UntypedInput, programId = null) {
  const key = keyFor(question, programId);
  if (!key) return null;
  const hit = getCachedAnswer(key);
  if (!hit) return null;
  if (isVolatile(hit.source) && hit.ageMs > db.CACHE_FRESH_MS) return null;
  return { source: hit.source, answer: hit.answer };
}

function put(question: UntypedInput, result: UntypedInput, options: Record<string, UntypedInput> | string = {}, programId: string | null = null) {
  if (typeof options === "string") {
    programId = options;
    options = {};
  }
  const key = keyFor(question, programId);
  if (!key) return;
  putCachedAnswer(key, question, result, options || {});
}


function cacheRow(hash: UntypedInput) {
  return db.handle()
    .query("SELECT source, answer, ask_count, COALESCE(refreshed_at, created_at) AS written_at FROM answer_cache WHERE question_hash = ?")
    .get(hash) as CacheRow | null;
}

function peekCachedAnswer(hash: UntypedInput) {
  const row = cacheRow(hash);
  if (!row) return null;
  return { source: row.source, answer: row.answer, askCount: row.ask_count, ageMs: db.now() - row.written_at };
}

function getCachedAnswer(hash: UntypedInput) {
  const hit = peekCachedAnswer(hash);
  if (!hit) return null;
  db.handle()
    .query("UPDATE answer_cache SET ask_count = ask_count + 1, last_asked_at = ? WHERE question_hash = ?")
    .run(db.now(), hash);
  return hit;
}

function putCachedAnswer(hash: UntypedInput, question: UntypedInput, result: UntypedInput, { refreshed = false }: Record<string, UntypedInput> = {}) {
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

function staleCacheEntries(staleAfterMs: UntypedInput, limit: UntypedInput) {
  return db.handle()
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

function topCached(limit = 5) {
  return db.handle()
    .query("SELECT question_hash, question, ask_count, source, COALESCE(refreshed_at, created_at) AS written_at FROM answer_cache ORDER BY ask_count DESC, question LIMIT ?")
    .all(limit);
}

function clearCache() {
  db.handle().query("DELETE FROM answer_cache").run();
}

function forget(hash: UntypedInput) {
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
