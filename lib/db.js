// SQLite-backed state. Everything pixie remembers used to live in in-memory
// Maps, so a restart meant amnesia — dropped thread context and, worse, a
// cleared dedupe set that let pixie re-answer messages it had already replied
// to. One file, no server, no migrations beyond CREATE TABLE IF NOT EXISTS.
const path = require("path");
const { Database } = require("bun:sqlite");
const { SCHEMA, MIGRATIONS, POST_MIGRATION_SCHEMA } = require("./schema");
const log = require("./log");

const DEFAULT_PATH = path.join(__dirname, "..", "pixie.db");

// Retention windows. Sweeps run on an interval instead of the per-entry
// setTimeout the Map version used.
const ANSWERED_TTL_MS = 24 * 60 * 60 * 1000;
const THREAD_TTL_MS = 60 * 60 * 1000;
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GUIDE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// The answer cache is the one thing pixie is supposed to ACCUMULATE, so it has
// two windows instead of one TTL.
//
// It used to have a flat 6h TTL, which meant freshness and forgetting were the
// same action: the only way to avoid serving a stale answer was to throw the
// answer away. A question asked at 9am was a full model call again by 4pm,
// every day, and the table never got above a handful of rows.
//
// Now: younger than CACHE_FRESH_MS, serve it. Older, still serve it but let the
// warmer regenerate it in the background. Only drop it when nobody has asked
// that phrasing for CACHE_IDLE_MS — keyed on last_asked_at, so something people
// keep asking is never dropped at all.
const CACHE_FRESH_MS = 6 * 60 * 60 * 1000;
const CACHE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_THREAD_MESSAGES = 20;
const MAX_USER_TOPICS = 10;


let db = null;
let sweepTimer = null;

function migrate(database) {
  for (const [table, column, sql] of MIGRATIONS) {
    const columns = database.query(`PRAGMA table_info(${table})`).all();
    if (columns.some((c) => c.name === column)) continue;
    database.exec(sql);
    log.info("db", `migrated: ${table}.${column}`);
  }
}

function open(filename = process.env.PIXIE_DB_PATH || DEFAULT_PATH) {
  if (db) return db;
  db = new Database(filename, { create: true });
  // WAL keeps reads from blocking on the sweep, and matters once slash
  // commands start querying while the event loop is writing.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  db.exec(POST_MIGRATION_SCHEMA);
  db.exec("DELETE FROM answer_cache");
  log.info("db", `opened ${filename}`);
  return db;
}

function handle() {
  if (!db) open();
  return db;
}

function now() {
  return Date.now();
}

/* ---------------------------------------------------------------- dedupe -- */

// Returns true if this ts was already claimed. The INSERT is the claim, so the
// check and the mark are one atomic step — no window where two events for the
// same ts both see "not answered".
function claimMessage(ts, channel = null) {
  const changes = handle()
    .query("INSERT OR IGNORE INTO answered_messages (ts, channel, answered_at) VALUES (?, ?, ?)")
    .run(ts, channel, now());
  return changes.changes > 0;
}

function wasAnswered(ts) {
  return !!handle().query("SELECT 1 FROM answered_messages WHERE ts = ?").get(ts);
}

/* --------------------------------------------------------------- threads -- */

function touchThread(threadTs, channel = null, fields = {}) {
  handle()
    .query(
      `INSERT INTO threads (thread_ts, channel, seeded, pixie_spoke, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_ts) DO UPDATE SET
         channel     = COALESCE(excluded.channel, threads.channel),
         seeded      = MAX(threads.seeded, excluded.seeded),
         pixie_spoke = MAX(threads.pixie_spoke, excluded.pixie_spoke),
         updated_at  = excluded.updated_at`,
    )
    .run(threadTs, channel, fields.seeded ? 1 : 0, fields.pixieSpoke ? 1 : 0, now());
}

function getThread(threadTs) {
  return handle().query("SELECT * FROM threads WHERE thread_ts = ?").get(threadTs) || null;
}

function addThreadMessage(threadTs, role, content, userId = null) {
  handle()
    .query("INSERT INTO thread_messages (thread_ts, role, content, user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(threadTs, role, content, userId, now());

  // Trim to the newest N so a long thread can't grow the prompt without bound.
  handle()
    .query(
      `DELETE FROM thread_messages
       WHERE thread_ts = ? AND id NOT IN (
         SELECT id FROM thread_messages WHERE thread_ts = ? ORDER BY id DESC LIMIT ?
       )`,
    )
    .run(threadTs, threadTs, MAX_THREAD_MESSAGES);
}

function getThreadMessages(threadTs) {
  const cutoff = now() - THREAD_TTL_MS;
  return handle()
    .query("SELECT role, content, user_id FROM thread_messages WHERE thread_ts = ? AND created_at > ? ORDER BY id ASC")
    .all(threadTs, cutoff);
}

/* ---------------------------------------------------------- user history -- */

function recordTopic(userId, topic, wasHelpful = true) {
  if (!userId || !topic) return;
  handle()
    .query(
      `INSERT INTO user_topics (user_id, topic, was_helpful, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, topic) DO UPDATE SET created_at = excluded.created_at, was_helpful = excluded.was_helpful`,
    )
    .run(userId, topic, wasHelpful ? 1 : 0, now());

  handle()
    .query(
      `DELETE FROM user_topics
       WHERE user_id = ? AND topic NOT IN (
         SELECT topic FROM user_topics WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .run(userId, userId, MAX_USER_TOPICS);
}

function getTopics(userId) {
  if (!userId) return [];
  const cutoff = now() - HISTORY_TTL_MS;
  return handle()
    .query("SELECT topic, was_helpful FROM user_topics WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC")
    .all(userId, cutoff);
}

/* ------------------------------------------------------- gaps & feedback -- */

function recordGap(question, userId = null, channel = null, messageTs = null) {
  handle()
    .query("INSERT INTO doc_gaps (question, user_id, channel, message_ts, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(question, userId, channel, messageTs, now());
}

// The question pixie missed on this thread's parent message, if any. Bounded
// by age so a reply to a week-old thread doesn't get captured as an answer.
function gapForThread(messageTs, sinceMs = 7 * 24 * 60 * 60 * 1000) {
  if (!messageTs) return null;
  return (
    handle()
      .query("SELECT question, user_id FROM doc_gaps WHERE message_ts = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1")
      .get(messageTs, now() - sinceMs) || null
  );
}

// Groups near-identical asks so the maintainer view shows "8 people asked this"
// rather than eight separate rows.
//
// `kind` narrows it to one verdict — in practice "docs", which is the only one
// that belongs on a to-do list. Unjudged rows (kind IS NULL) are deliberately
// excluded by any kind filter: not yet classified is not the same as classified
// as a docs gap, and guessing here is what made the old list unreadable.
function topGaps(limit = 20, sinceMs = 30 * 24 * 60 * 60 * 1000, { kind = null, untilMs = null } = {}) {
  const clauses = ["created_at > ?"];
  const params = [now() - sinceMs];

  if (untilMs !== null) {
    clauses.push("created_at <= ?");
    params.push(untilMs);
  }
  if (kind !== null) {
    clauses.push("kind = ?");
    params.push(kind);
  }
  params.push(limit);

  return handle()
    .query(
      `SELECT MIN(id) AS id, LOWER(TRIM(question)) AS question, COUNT(*) AS count, MAX(created_at) AS last_asked
       FROM doc_gaps WHERE ${clauses.join(" AND ")}
       GROUP BY LOWER(TRIM(question))
       ORDER BY count DESC, last_asked DESC
       LIMIT ?`,
    )
    .all(...params);
}

// Rows the judge hasn't seen yet. Newest first: a question asked today matters
// more than one from three weeks ago, and the backlog drains behind it.
function unclassifiedGaps(limit = 5) {
  return handle()
    .query("SELECT id, question FROM doc_gaps WHERE kind IS NULL ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

function setGapKind(id, kind) {
  handle().query("UPDATE doc_gaps SET kind = ? WHERE id = ?").run(kind, id);
}

// The channel/thread refs behind one normalized question. topGaps groups
// matching questions into one row and only returns a representative id, so
// this is how lib/report.js's draftGaps pulls the real Slack thread(s) to
// ground a draft in — every occurrence, not just one, since a human may have
// answered in any of them.
function gapThreads(question, limit = 2, sinceMs = 30 * 24 * 60 * 60 * 1000) {
  return handle()
    .query(
      `SELECT DISTINCT channel, message_ts FROM doc_gaps
       WHERE LOWER(TRIM(question)) = LOWER(TRIM(?)) AND created_at > ? AND channel IS NOT NULL AND message_ts IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(question, now() - sinceMs, limit);
}

// Distinct questions per verdict, so the report can say how much it filtered
// out without listing any of it.
function gapCountsByKind(sinceMs = 7 * 24 * 60 * 60 * 1000, untilMs = null) {
  const upper = untilMs === null ? now() : untilMs;
  return Object.fromEntries(
    handle()
      .query(
        `SELECT COALESCE(kind, 'unjudged') AS kind, COUNT(DISTINCT LOWER(TRIM(question))) AS count
         FROM doc_gaps WHERE created_at > ? AND created_at <= ?
         GROUP BY COALESCE(kind, 'unjudged')`,
      )
      .all(now() - sinceMs, upper)
      .map((r) => [r.kind, r.count]),
  );
}

function recordFeedback(messageTs, userId, vote) {
  handle()
    .query(
      `INSERT INTO feedback (message_ts, user_id, vote, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(message_ts, user_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`,
    )
    .run(messageTs, userId, vote, now());
}

function removeFeedback(messageTs, userId) {
  handle().query("DELETE FROM feedback WHERE message_ts = ? AND user_id = ?").run(messageTs, userId);
}

function feedbackTotals() {
  return (
    handle()
      .query("SELECT SUM(vote > 0) AS up, SUM(vote < 0) AS down FROM feedback")
      .get() || { up: 0, down: 0 }
  );
}

/* --------------------------------------------------------------- learned -- */

// Returns the new row id, or null if this source message was already captured.
function addLearnedFact({ question, answer, authorId = null, status = "pending", sourceTs = null, channel = null }) {
  const result = handle()
    .query(
      `INSERT OR IGNORE INTO learned_facts (question, answer, author_id, status, source_ts, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(question, answer, authorId, status, sourceTs, channel, now());
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

function listLearnedFacts(status, limit = 25) {
  return handle()
    .query("SELECT * FROM learned_facts WHERE status = ? ORDER BY created_at ASC LIMIT ?")
    .all(status, limit);
}

function approvedFacts(limit = 50) {
  return handle()
    .query("SELECT question, answer FROM learned_facts WHERE status = 'approved' ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .reverse();
}

function setLearnedStatus(id, status) {
  const result = handle().query("UPDATE learned_facts SET status = ? WHERE id = ?").run(status, id);
  return result.changes > 0;
}

function deleteLearnedFact(id) {
  return handle().query("DELETE FROM learned_facts WHERE id = ?").run(id).changes > 0;
}

function deleteLearnedByStatus(status) {
  if (status === "all") {
    return handle().query("DELETE FROM learned_facts").run().changes;
  }
  return handle().query("DELETE FROM learned_facts WHERE status = ?").run(status).changes;
}

function deleteLearnedRange(fromId, toId) {
  return handle().query("DELETE FROM learned_facts WHERE id >= ? AND id <= ?").run(fromId, toId).changes;
}

function pendingCountForQuestion(question) {
  const row = handle()
    .query("SELECT COUNT(*) AS n FROM learned_facts WHERE question = ? AND status = 'pending'")
    .get(question);
  return row?.n || 0;
}

function hasCapturedSource(sourceTs) {
  return !!handle().query("SELECT 1 FROM learned_facts WHERE source_ts = ?").get(sourceTs);
}

/* ---------------------------------------------------------------- guides -- */

function saveGuide(threadTs, guideId, currentStep, userId) {
  handle()
    .query(
      `INSERT INTO active_guides (thread_ts, guide_id, current_step, user_id, started_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_ts) DO UPDATE SET guide_id = excluded.guide_id, current_step = excluded.current_step`,
    )
    .run(threadTs, guideId, currentStep, userId, now());
}

function getGuide(threadTs) {
  const cutoff = now() - GUIDE_TTL_MS;
  return handle().query("SELECT * FROM active_guides WHERE thread_ts = ? AND started_at > ?").get(threadTs, cutoff) || null;
}

// Set once the step's message actually lands in Slack (guides.js computes the
// next step before that post happens, so it can't know the ts yet). Lets a
// :upvote: reaction on that exact message be matched back to its guide.
function setGuideMessageTs(threadTs, messageTs) {
  handle().query("UPDATE active_guides SET message_ts = ? WHERE thread_ts = ?").run(messageTs, threadTs);
}

function getGuideByMessageTs(messageTs) {
  const cutoff = now() - GUIDE_TTL_MS;
  return (
    handle().query("SELECT * FROM active_guides WHERE message_ts = ? AND started_at > ?").get(messageTs, cutoff) ||
    null
  );
}

function deleteGuide(threadTs) {
  handle().query("DELETE FROM active_guides WHERE thread_ts = ?").run(threadTs);
}

/* ------------------------------------------------------ metrics & limits -- */

function recordMetric(kind, latencyMs = null, detail = null) {
  handle().query("INSERT INTO metrics (kind, latency_ms, detail, created_at) VALUES (?, ?, ?, ?)").run(kind, latencyMs, detail, now());
}

// `untilMs` closes the window at the top as well as the bottom, so the same
// query can count last week for the report's week-on-week comparison.
function metricCounts(sinceMs = 7 * 24 * 60 * 60 * 1000, untilMs = null) {
  return handle()
    .query("SELECT kind, COUNT(*) AS count FROM metrics WHERE created_at > ? AND created_at <= ? GROUP BY kind")
    .all(now() - sinceMs, untilMs === null ? now() : untilMs);
}

// When something last happened. The weekly report uses it as its own
// already-sent marker: metrics is the one table sweep() never deletes from, so
// a restart can't make pixie post the same report twice.
function lastMetricAt(kind) {
  return handle().query("SELECT MAX(created_at) AS at FROM metrics WHERE kind = ?").get(kind)?.at || null;
}

function metricDetails(kind, sinceMs = 7 * 24 * 60 * 60 * 1000) {
  return handle()
    .query("SELECT detail, COUNT(*) AS count FROM metrics WHERE kind = ? AND detail IS NOT NULL AND created_at > ? GROUP BY detail ORDER BY count DESC")
    .all(kind, now() - sinceMs);
}

function medianLatency(kind, sinceMs = 7 * 24 * 60 * 60 * 1000) {
  const rows = handle()
    .query("SELECT latency_ms FROM metrics WHERE kind = ? AND latency_ms IS NOT NULL AND created_at > ? ORDER BY latency_ms")
    .all(kind, now() - sinceMs);
  if (rows.length === 0) return null;
  return rows[Math.floor(rows.length / 2)].latency_ms;
}

function countRecentRequests(userId, windowMs) {
  const row = handle()
    .query("SELECT COUNT(*) AS count FROM rate_limits WHERE user_id = ? AND created_at > ?")
    .get(userId, now() - windowMs);
  return row?.count || 0;
}

function recordRequest(userId) {
  handle().query("INSERT INTO rate_limits (user_id, created_at) VALUES (?, ?)").run(userId, now());
}

/* ----------------------------------------------------------------- sweep -- */

function sweep() {
  const t = now();
  const d = handle();
  d.query("DELETE FROM answered_messages WHERE answered_at < ?").run(t - ANSWERED_TTL_MS);
  d.query("DELETE FROM thread_messages WHERE created_at < ?").run(t - THREAD_TTL_MS);
  d.query("DELETE FROM threads WHERE updated_at < ?").run(t - THREAD_TTL_MS);
  d.query("DELETE FROM user_topics WHERE created_at < ?").run(t - HISTORY_TTL_MS);
  // Idle, not merely old. An entry nobody has asked for in a week goes; one
  // that keeps being asked stays however old it is, and lib/warm.js keeps its
  // answer current.
  d.query("DELETE FROM answer_cache WHERE COALESCE(last_asked_at, created_at) < ?").run(t - CACHE_IDLE_MS);
  d.query("DELETE FROM active_guides WHERE started_at < ?").run(t - GUIDE_TTL_MS);
  d.query("DELETE FROM rate_limits WHERE created_at < ?").run(t - 60 * 60 * 1000);

  // The deletes above land in the WAL, which otherwise only truncates when it
  // crosses SQLite's default threshold — the file had grown to 4.1MB against a
  // 114KB database. Best-effort: a reader holding the file just means the next
  // sweep gets it.
  try {
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    log.debug("db", `wal checkpoint skipped: ${e.message}`);
  }
}

function startSweeper() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch (e) {
      log.error("db", "sweep failed:", e.message);
    }
  }, SWEEP_INTERVAL_MS);
  // Don't hold the process open just for housekeeping.
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function close() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (db) db.close();
  db = null;
}

module.exports = {
  open,
  close,
  // The moved answer-cache SQL in lib/cache.js writes through these.
  now,
  // Exposed for tests that need to backdate rows to exercise retention — there
  // is no other way to age a record without waiting days for it.
  handle,
  sweep,
  startSweeper,
  claimMessage,
  wasAnswered,
  touchThread,
  getThread,
  addThreadMessage,
  getThreadMessages,
  recordTopic,
  getTopics,
  recordGap,
  topGaps,
  unclassifiedGaps,
  setGapKind,
  gapCountsByKind,
  gapForThread,
  gapThreads,
  addLearnedFact,
  listLearnedFacts,
  approvedFacts,
  setLearnedStatus,
  deleteLearnedFact,
  deleteLearnedByStatus,
  deleteLearnedRange,
  pendingCountForQuestion,
  hasCapturedSource,
  recordFeedback,
  removeFeedback,
  feedbackTotals,
  saveGuide,
  getGuide,
  setGuideMessageTs,
  getGuideByMessageTs,
  deleteGuide,
  recordMetric,
  metricCounts,
  lastMetricAt,
  metricDetails,
  medianLatency,
  countRecentRequests,
  recordRequest,
  MAX_THREAD_MESSAGES,
  MAX_USER_TOPICS,
  GUIDE_TTL_MS,
  CACHE_FRESH_MS,
  CACHE_IDLE_MS,
};
