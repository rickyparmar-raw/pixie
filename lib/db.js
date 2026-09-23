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

// What the intent gate gets to see: the last few things this person said, and
// how far back it is still worth looking. Three messages was enough to tell
// "still broken" mid-debug apart from "still broken" as a punchline; more just
// made the prompt longer. Two hours because context this old stops describing
// what someone is doing right now.
const MAX_USER_MESSAGES = 12;
const USER_MESSAGE_WINDOW_MS = 2 * 60 * 60 * 1000;
const USER_MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;


let db = null;
let sweepTimer = null;
const ephemeralThreadMessages = new Map();

// Most rows are ADD COLUMN: the column slot is what we look up to decide
// whether to skip. A few are CREATE TABLE: same shape, different idempotency
// check. Treat "this column exists" as a stand-in for "this migration ran" on
// ADD COLUMN migrations, and "this table exists" for CREATE TABLE ones.
function migrate(database) {
  for (const [table, column, sql] of MIGRATIONS) {
    if (sql.startsWith("CREATE TABLE")) {
      const exists = database
        .query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
        .get("table", table);
      if (exists) continue;
    } else {
      const columns = database.query(`PRAGMA table_info(${table})`).all();
      if (columns.some((c) => c.name === column)) continue;
    }
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
  log.info("db", `opened ${filename}`);
  return db;
}

// Bring an arbitrary database file up to the current schema WITHOUT the
// boot side effects of open() (no cache wipe, no sweeper). Used by migration
// tooling and tests that operate on files other than the live database.
function ensureSchema(filename) {
  const { Database: BunDatabase } = require("bun:sqlite");
  const file = filename || process.env.PIXIE_DB_PATH || DEFAULT_PATH;
  const database = new BunDatabase(file, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA);
  migrate(database);
  database.exec(POST_MIGRATION_SCHEMA);
  database.close();
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
      `INSERT INTO threads (thread_ts, channel, seeded, pixie_spoke, helper_pinged, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_ts) DO UPDATE SET
         channel       = COALESCE(excluded.channel, threads.channel),
         seeded        = MAX(threads.seeded, excluded.seeded),
         pixie_spoke   = MAX(threads.pixie_spoke, excluded.pixie_spoke),
         helper_pinged = MAX(threads.helper_pinged, excluded.helper_pinged),
         updated_at    = excluded.updated_at`,
    )
    .run(threadTs, channel, fields.seeded ? 1 : 0, fields.pixieSpoke ? 1 : 0, fields.helperPinged ? 1 : 0, now());
}

function getThread(threadTs) {
  return handle().query("SELECT * FROM threads WHERE thread_ts = ?").get(threadTs) || null;
}

function addThreadMessage(threadTs, role, content, userId = null) {
  const list = ephemeralThreadMessages.get(threadTs) || [];
  list.push({ role, content, user_id: userId, created_at: now() });
  if (list.length > MAX_THREAD_MESSAGES) list.splice(0, list.length - MAX_THREAD_MESSAGES);
  ephemeralThreadMessages.set(threadTs, list);
}

function getThreadMessages(threadTs) {
  const cutoff = now() - THREAD_TTL_MS;
  return (ephemeralThreadMessages.get(threadTs) || []).filter((row) => row.created_at > cutoff)
    .map(({ role, content, user_id }) => ({ role, content, user_id }));
}

/* ------------------------------------------------------ recent utterances -- */

// Transient in-memory buffer for intent context only — NEVER saved to SQLite disk.
const ephemeralUserMessages = new Map();

function recordUserMessage({ userId, channel = null, threadTs = null, text }) {
  const body = (text || "").trim();
  if (!userId || !body) return;

  const list = ephemeralUserMessages.get(userId) || [];
  list.push({ text: body, channel, threadTs, created_at: now() });
  if (list.length > MAX_USER_MESSAGES) {
    list.splice(0, list.length - MAX_USER_MESSAGES);
  }
  ephemeralUserMessages.set(userId, list);
}

function recentUserMessages(userId, { channel = null, limit = 3 } = {}) {
  if (!userId) return [];
  const cutoff = now() - USER_MESSAGE_WINDOW_MS;
  const list = (ephemeralUserMessages.get(userId) || [])
    .filter((m) => m.created_at > cutoff && (!channel || m.channel === channel));
  return list.slice(-limit);
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

function recordGap(question, userId = null, channel = null, messageTs = null, programId = null) {
  // Stored normalized so a rejected question's text matches a future rephrasing
  // (the two are compared as plain strings in the topGaps subquery). Without
  // this, "How do I submit" and "how do i submit" go to different rows.
  handle()
    .query("INSERT INTO doc_gaps (question, user_id, channel, message_ts, program_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(normalizeQuestion(question), userId, channel, messageTs, programId, now());
}

// Single source of truth for the question text. Lowercased, internal whitespace
// collapsed to single spaces, edges trimmed. Used on every write that names a
// question, so the rejection list and the miss log compare identically without
// any SQL-side normalization gymnastics.
function normalizeQuestion(question) {
  return String(question || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// A maintainer dropped a draft of this question. The strongest signal a
// question is not a real gap is a human's actual decision, so once recorded
// the question is hidden from the auto-ranked list (topGaps excludeRejected)
// for the same window the rank itself covers.
//
// Stored separately from doc_gaps so dropping one draft doesn't mutate the
// underlying miss log — the misses stay in case wording changes and the
// rejection is keyed on the same normalized question the gap is.
function recordGapRejection(question) {
  const normalized = normalizeQuestion(question);
  if (!normalized) return;
  handle()
    .query("INSERT OR REPLACE INTO gap_rejections (question, created_at) VALUES (?, ?)")
    .run(normalized, now());
}

function clearGapRejection(question) {
  const normalized = normalizeQuestion(question);
  if (!normalized) return;
  handle().query("DELETE FROM gap_rejections WHERE question = ?").run(normalized);
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
//
// `minAskers` is a count of distinct user_ids, not the row count. Without it a
// single asker spamming the same joke climbs above eight real people who each
// asked once, which is what put "does pixie have a girlfriend" in front of
// "how do i submit my project" before. A "person" here is a user_id; a troll
// can register many, but the unit is still real accounts.
//
// `excludeRejected` filters out questions a maintainer has explicitly dropped
// from a draft — human feedback is the strongest signal a question isn't a real
// gap, and once it's been heard it should stay out of the auto-reranked list
// until either the question wording changes or the rejection ages out.
function topGaps(limit = 20, sinceMs = 30 * 24 * 60 * 60 * 1000, {
  kind = null,
  untilMs = null,
  programId = null,
  minAskers = 2,
  excludeRejected = true,
} = {}) {
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
  if (programId !== null) {
    clauses.push("(program_id = ? OR program_id IS NULL)");
    params.push(programId);
  }
  // Both sides of the rejection lookup are pre-normalized at insert time
  // (recordGap, recordGapRejection), so a plain LOWER(TRIM()) here is enough
  // for grouping — anything more elaborate runs into SQLite's expression
  // depth limit for no benefit, and tries to do work that's already been
  // done.
  const normalizedQuestion = "LOWER(TRIM(question))";

  if (excludeRejected) {
    clauses.push(`${normalizedQuestion} NOT IN (SELECT question FROM gap_rejections WHERE created_at > ?)`);
    params.push(now() - sinceMs);
  }
  const sql = `SELECT MIN(id) AS id,
                      ${normalizedQuestion} AS question,
                      COUNT(*) AS ask_count,
                      COUNT(DISTINCT user_id) AS askers,
                      MAX(created_at) AS last_asked
               FROM doc_gaps WHERE ${clauses.join(" AND ")}
               GROUP BY ${normalizedQuestion}
               HAVING COUNT(DISTINCT user_id) >= ?
               ORDER BY askers DESC, ask_count DESC, last_asked DESC
               LIMIT ?`;
  params.push(minAskers, limit);

  return handle().query(sql).all(...params);
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
function gapCountsByKind(sinceMs = 7 * 24 * 60 * 60 * 1000, untilMs = null, programId = null) {
  const upper = untilMs === null ? now() : untilMs;
  const clauses = ["created_at > ?", "created_at <= ?"];
  const params = [now() - sinceMs, upper];
  if (programId) {
    clauses.push("(program_id = ? OR program_id IS NULL)");
    params.push(programId);
  }

  return Object.fromEntries(
    handle()
      .query(
        `SELECT COALESCE(kind, 'unjudged') AS kind, COUNT(DISTINCT LOWER(TRIM(question))) AS count
         FROM doc_gaps WHERE ${clauses.join(" AND ")}
         GROUP BY COALESCE(kind, 'unjudged')`,
      )
      .all(...params)
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
function addLearnedFact({ question, answer, authorId = null, status = "pending", sourceTs = null, channel = null, programId = null, category = null, ticketId = null, resolverId = null }) {
  const result = handle()
    .query(
      `INSERT OR IGNORE INTO learned_facts (question, answer, author_id, status, source_ts, channel, program_id, category, ticket_id, resolver_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(question, answer, authorId, status, sourceTs, channel, programId, category, ticketId, resolverId, now());
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

function listLearnedFacts(status, limit = 25, programId = null) {
  if (programId) {
    return handle()
      .query("SELECT * FROM learned_facts WHERE status = ? AND (program_id = ? OR program_id IS NULL) ORDER BY created_at ASC LIMIT ?")
      .all(status, programId, limit);
  }
  return handle()
    .query("SELECT * FROM learned_facts WHERE status = ? ORDER BY created_at ASC LIMIT ?")
    .all(status, limit);
}

// Single-row lookup by id, used by the home tab review action to know which
// question text a Drop button is for. The id is the action_id's suffix.
function getLearnedFactById(id) {
  return (
    handle()
      .query("SELECT * FROM learned_facts WHERE id = ?")
      .get(id) || null
  );
}

function approvedFacts(limit = 50, programId = null) {
  if (programId) {
    return handle()
      .query("SELECT question, answer FROM learned_facts WHERE status = 'approved' AND (program_id = ? OR program_id IS NULL) ORDER BY created_at DESC LIMIT ?")
      .all(programId, limit)
      .reverse();
  }
  return handle()
    .query("SELECT question, answer FROM learned_facts WHERE status = 'approved' ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .reverse();
}

function setLearnedStatus(id, status) {
  // Approving stamps verification time: the moment a human took responsibility
  // for this fact entering the corpus.
  const result = status === "approved"
    ? handle().query("UPDATE learned_facts SET status = ?, verified_at = ? WHERE id = ?").run(status, now(), id)
    : handle().query("UPDATE learned_facts SET status = ? WHERE id = ?").run(status, id);
  return result.changes > 0;
}

function updateLearnedFact(id, { question = null, answer = null, category = null } = {}) {
  return handle().query(
    `UPDATE learned_facts SET question = COALESCE(?, question), answer = COALESCE(?, answer), category = COALESCE(?, category) WHERE id = ?`,
  ).run(question, answer, category, id).changes > 0;
}

function candidateForTicket(ticketId) {
  return handle().query("SELECT * FROM learned_facts WHERE ticket_id = ? AND status = 'candidate' LIMIT 1").get(ticketId) || null;
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
  return (
    handle()
      .query("SELECT COUNT(*) AS count FROM learned_facts WHERE status = 'pending' AND LOWER(TRIM(question)) = LOWER(TRIM(?))")
      .get(question)?.count || 0
  );
}

function hasCapturedSource(sourceTs) {
  if (!sourceTs) return false;
  return Boolean(
    handle().query("SELECT 1 FROM learned_facts WHERE source_ts = ? LIMIT 1").get(sourceTs),
  );
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

/* -------------------------------------------------------- muted threads --- */

function muteThread(threadTs, channel = null) {
  handle()
    .query("INSERT OR REPLACE INTO muted_threads (thread_ts, channel, muted_at) VALUES (?, ?, ?)")
    .run(threadTs, channel, now());
}

function isThreadMuted(threadTs) {
  if (!threadTs) return false;
  const row = handle().query("SELECT 1 FROM muted_threads WHERE thread_ts = ? LIMIT 1").get(threadTs);
  return !!row;
}

function unmuteThread(threadTs) {
  if (!threadTs) return;
  handle().query("DELETE FROM muted_threads WHERE thread_ts = ?").run(threadTs);
}

// Human takeover: sticky public-silence for a thread. Set on explicit
// takeover cues, cleared only by direct Pixie reactivation ("come back",
// "help"). Copilot/internal reads are unaffected — this gates ambient
// event-driven speech only. Explicit slash commands (an addressed,
// deliberate user action) and scheduled reports are outside this gate.
function markTakeover(threadTs, channel = null, byUser = null) {
  if (!threadTs) return;
  handle()
    .query("INSERT OR REPLACE INTO thread_takeover (thread_ts, channel, by_user, created_at) VALUES (?, ?, ?, ?)")
    .run(threadTs, channel, byUser, now());
}

function isTakeover(threadTs) {
  if (!threadTs) return false;
  return !!handle().query("SELECT 1 FROM thread_takeover WHERE thread_ts = ? LIMIT 1").get(threadTs);
}

function clearTakeover(threadTs) {
  if (!threadTs) return;
  handle().query("DELETE FROM thread_takeover WHERE thread_ts = ?").run(threadTs);
}

/* ------------------------------------------------------ metrics & limits -- */

function recordMetric(kind, latencyMs = null, detail = null, programId = null) {
  handle().query("INSERT INTO metrics (kind, latency_ms, detail, program_id, created_at) VALUES (?, ?, ?, ?, ?)").run(kind, latencyMs, detail, programId, now());
}

function recordLlmUsage(entry = {}) {
  try {
    handle().query(
      `INSERT INTO llm_usage
       (operation, provider, program_id, channel, request_id, event_id, model, status, result, http_status, rate_limited, attempt, retry_count,
         prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.operation || "unknown", entry.provider || null, entry.programId || null, entry.channel || null,
      entry.requestId || null, entry.eventId || null, entry.model || null, entry.status || "error",
      entry.result || entry.status || "error", entry.httpStatus || null, entry.rateLimited ? 1 : 0, entry.attempt || 1, entry.retryCount || 0,
      entry.promptTokens ?? null, entry.cachedPromptTokens ?? null, entry.completionTokens ?? null, entry.totalTokens ?? null,
      entry.costUsd ?? null, entry.latencyMs ?? null, entry.errorKind || null, entry.createdAt || now(),
    );
  } catch (e) {
    log.debug("db", `llm telemetry write failed: ${e.message}`);
  }
}

function llmUsageSummary(sinceMs = 24 * 60 * 60 * 1000) {
  try {
    return handle().query(
      `SELECT operation, program_id, channel, model,
              COUNT(*) AS requests, SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN http_status = 429 THEN 1 ELSE 0 END) AS rate_limits,
              SUM(retry_count) AS retries, SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd
       FROM llm_usage WHERE created_at > ?
       GROUP BY operation, program_id, channel, model
       ORDER BY requests DESC`,
    ).all(now() - sinceMs);
  } catch (e) {
    log.debug("db", `llm telemetry read failed: ${e.message}`);
    return [];
  }
}

const USAGE_BUCKETS = new Set(["hour", "day"]);
const USAGE_OPERATIONS = new Set(["answer", "intent", "chat", "vision", "copilot", "llm"]);
function parseUsageTime(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (/^\d+$/.test(String(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function llmUsageReport({ programId, from, until, bucket = "day", operation = null, limit = 50, offset = 0 } = {}) {
  if (!programId) return { error: "programId required" };
  if (!USAGE_BUCKETS.has(bucket)) return { error: "bucket must be hour or day" };
  if (operation !== null && !USAGE_OPERATIONS.has(operation)) return { error: "invalid operation" };
  const end = parseUsageTime(until, now());
  const start = parseUsageTime(from, end - 30 * 86400000);
  if (start === null || end === null || start >= end) return { error: "invalid date range" };
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const clauses = ["program_id = ?", "created_at >= ?", "created_at < ?"];
  const params = [programId, start, end];
  if (operation) { clauses.push("operation = ?"); params.push(operation); }
  const where = clauses.join(" AND ");
  const d = bucket === "hour" ? "%Y-%m-%dT%H:00:00Z" : "%Y-%m-%dT00:00:00Z";
  const base = `FROM llm_usage WHERE ${where}`;
  const totals = handle().query(`SELECT COUNT(DISTINCT COALESCE(request_id, 'event:' || id)) requests,
    COALESCE(SUM(total_tokens),0) total_tokens, COALESCE(SUM(prompt_tokens),0) prompt_tokens,
    COALESCE(SUM(cached_prompt_tokens),0) cached_prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens,
    SUM(cost_usd) cost_usd, AVG(latency_ms) latency_ms,
    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,
    SUM(rate_limited) rate_limited, SUM(CASE WHEN result='grounded' THEN 1 ELSE 0 END) grounded_answers,
    SUM(CASE WHEN result='fallback' THEN 1 ELSE 0 END) fallbacks, SUM(CASE WHEN result='suppressed' THEN 1 ELSE 0 END) suppressed
    FROM llm_usage WHERE ${where}`).get(...params);
  const timeseries = handle().query(`SELECT strftime('${d}', created_at / 1000, 'unixepoch') bucket,
    COUNT(DISTINCT COALESCE(request_id, 'event:' || id)) requests, COALESCE(SUM(total_tokens),0) total_tokens,
    SUM(cost_usd) cost_usd FROM llm_usage WHERE ${where} GROUP BY bucket ORDER BY bucket`).all(...params);
  const grouped = (column) => handle().query(`SELECT ${column} value, MAX(provider) provider, COUNT(DISTINCT COALESCE(request_id, 'event:' || id)) requests,
     COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(cached_prompt_tokens),0) cached_prompt_tokens,
     COALESCE(SUM(completion_tokens),0) completion_tokens, COALESCE(SUM(total_tokens),0) total_tokens,
     SUM(cost_usd) cost_usd, AVG(latency_ms) latency_ms FROM llm_usage WHERE ${where} GROUP BY ${column} ORDER BY requests DESC LIMIT 100`).all(...params);
  const totalActivity = handle().query(`SELECT COUNT(*) n ${base}`).get(...params).n;
  const recent = handle().query(`SELECT created_at, operation, provider, model, channel, request_id, event_id, status, result, http_status, attempt, retry_count, latency_ms, rate_limited
    ${base} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, safeLimit, safeOffset);
  const metric = (row) => ({ requests: Number(row.requests || 0), inputTokens: Number(row.prompt_tokens || 0), outputTokens: Number(row.completion_tokens || 0), cachedInputTokens: Number(row.cached_prompt_tokens || 0), costCents: row.cost_usd == null ? null : Number((row.cost_usd * 100).toFixed(2)) });
  const rowsFor = (column) => grouped(column).map((row) => ({ ...metric(row), name: row.value || "unknown", ...(column === "model" ? { provider: row.provider || "unknown" } : {}) }));
  const summary = metric(totals);
  return { programId, from: new Date(start).toISOString(), to: new Date(end).toISOString(), bucket, operation,
    precision: totals.cost_usd == null ? "unavailable" : "exact", requests: summary.requests, inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens, cachedInputTokens: summary.cachedInputTokens, costCents: summary.costCents,
    summary: { ...summary, latencyMs: totals.latency_ms == null ? null : Number(totals.latency_ms), errors: Number(totals.errors || 0), rateLimited: Number(totals.rate_limited || 0), groundedAnswers: Number(totals.grounded_answers || 0), fallbacks: Number(totals.fallbacks || 0), suppressed: Number(totals.suppressed || 0), rate_limited: Number(totals.rate_limited || 0), cost_usd: totals.cost_usd },
    timeseries: timeseries.map((row) => ({ ...metric(row), at: `${row.bucket}` })), operation: rowsFor("operation"), provider: rowsFor("provider"), model: rowsFor("model"),
    topConsumers: rowsFor("channel").map((row) => ({ ...row, consumerId: row.name })),
    recent: recent.map(({ created_at, operation: op, provider, model, channel, request_id, status, latency_ms, rate_limited, retry_count }) => ({
      at: new Date(created_at).toISOString(),
      operation: op,
      provider: provider || "unknown",
      model: model || "unknown",
      consumerId: channel || null,
      requestId: request_id || null,
      status: status || "unknown",
      latencyMs: latency_ms == null ? null : Number(latency_ms),
      rateLimited: !!rate_limited,
      retryCount: Number(retry_count || 0),
    })),
    recentActivity: recent.map(({ created_at, operation: op, provider, model, request_id, event_id, status, result, http_status, attempt, retry_count, latency_ms, rate_limited }) => ({ createdAt: created_at, operation: op, provider, model, requestId: request_id, eventId: event_id, status, result, httpStatus: http_status, attempt, retryCount: retry_count, latencyMs: latency_ms, rateLimited: !!rate_limited })),
    pagination: { limit: safeLimit, offset: safeOffset, total: totalActivity, hasMore: safeOffset + recent.length < totalActivity } };
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
  d.query("DELETE FROM user_messages WHERE created_at < ?").run(t - USER_MESSAGE_TTL_MS);
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
  ephemeralThreadMessages.clear();
}

/* -------------------------------------------------------------- programs -- */

/* --------------------------------------------------------- source cache -- */

// The last successfully fetched text for one knowledge source, kept on the
// volume so a fetch failure at boot — a GitHub rate limit, usually — doesn't
// leave pixie with an empty corpus until the next refresh.
function saveSourceText(name, text) {
  const t = now();
  handle()
    .query(
      "INSERT INTO source_cache (name, text, fetched_at, fail_count, last_success_at, last_error) VALUES (?, ?, ?, 0, ?, NULL)" +
        " ON CONFLICT(name) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at," +
        " fail_count = 0, last_success_at = excluded.last_success_at, last_error = NULL",
    )
    .run(name, text, t, t);
}

function loadSourceText(name) {
  const row = handle().query("SELECT text, fetched_at FROM source_cache WHERE name = ?").get(name);
  if (!row) return null;
  return { text: row.text, fetchedAt: row.fetched_at };
}

// A refresh failure doesn't have a text body to upsert (saveSourceText is
// only called on success), so a failing source that has never once
// succeeded needs its own row to carry the count — the radar's
// SOURCE_FAILURE detector reads fail_count/last_error regardless of whether
// a good copy ever landed.
function recordSourceFailure(name, error) {
  const t = now();
  handle()
    .query(
      "INSERT INTO source_cache (name, text, fetched_at, fail_count, last_error) VALUES (?, '', ?, 1, ?)" +
        " ON CONFLICT(name) DO UPDATE SET fail_count = fail_count + 1, last_error = excluded.last_error",
    )
    .run(name, t, String(error || "").slice(0, 500));
}

function getSourceHealth(names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const placeholders = names.map(() => "?").join(",");
  return handle()
    .query(`SELECT name, fetched_at, fail_count, last_success_at, last_error FROM source_cache WHERE name IN (${placeholders})`)
    .all(...names);
}

function getDbPrograms() {
  const rows = handle().query("SELECT * FROM programs ORDER BY id ASC").all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    posture: r.posture,
    scope: r.scope || "any",
    workspaceId: r.workspace_id || null,
    deploymentMode: r.deployment_mode || "dedicated_legacy",
    supportName: r.support_name || null,
    iconUrl: r.icon_url || null,
    replySignature: r.reply_signature || null,
    aiAnswers: r.ai_answers === null || r.ai_answers === undefined ? true : !!r.ai_answers,
    ticketsEnabled: r.id === "pixl" || r.id === "twisted" ? false : (r.tickets_enabled === null || r.tickets_enabled === undefined ? true : !!r.tickets_enabled),
    autoEscalate: r.auto_escalate === null || r.auto_escalate === undefined ? true : !!r.auto_escalate,
    sensitiveCategories: r.sensitive_categories ? JSON.parse(r.sensitive_categories) : [],
    supportActive: r.support_active === null || r.support_active === undefined ? true : !!r.support_active,
    autoAssign: !!r.auto_assign,
    helperPing: !!r.helper_ping_enabled,
    shadowMode: r.id === "jame-gam" ? false : !!r.shadow_mode,
    incidentMode: r.incident_mode || "ANSWER_AND_TRACK",
    publicTicketsEnabled: r.public_tickets_enabled === null || r.public_tickets_enabled === undefined ? true : !!r.public_tickets_enabled,
    sharedSources: r.id === "ysws-global" ? true : false,
    sla: {
      unassignedMs: r.sla_unassigned_ms || null,
      assignedMs: r.sla_assigned_ms || null,
      waitingMs: r.sla_waiting_ms || null,
      targetMs: r.sla_target_ms || null,
      notifyChannel: r.sla_notify_channel || null,
    },
    retention: {
      contextDays: r.retention_context_days || null,
      ticketsDays: r.retention_tickets_days || null,
      notesDays: r.retention_notes_days || null,
      tracesDays: r.retention_traces_days || null,
      analyticsDays: r.retention_analytics_days || null,
      auditDays: r.retention_audit_days || null,
    },
    helpChannel: r.help_channel,
    channels: r.channels ? JSON.parse(r.channels) : [],
    helperGroup: r.helper_group,
    sources: r.sources ? JSON.parse(r.sources) : null,
    milestones: r.milestones ? JSON.parse(r.milestones) : null,
    guides: r.guides ? JSON.parse(r.guides) : null,
    links: r.links ? JSON.parse(r.links) : null,
    categories: r.categories ? JSON.parse(r.categories) : null,
    ticketVisibility: r.ticket_visibility || null,
    updatedAt: r.updated_at,
  }));
}

function saveProgram(p) {
  const existing = handle().query("SELECT 1 FROM programs WHERE id = ?").get(p.id);
  const nowTs = now();
  const channels = p.channels ? JSON.stringify(p.channels) : null;
  const sources = p.sources ? JSON.stringify(p.sources) : null;
  const milestones = p.milestones ? JSON.stringify(p.milestones) : null;
  const guides = p.guides ? JSON.stringify(p.guides) : null;
  const links = p.links ? JSON.stringify(p.links) : null;
  const categories = p.categories ? JSON.stringify(p.categories) : null;
  const ticketVisibility = p.ticketVisibility || null;
  const sensitive = p.sensitiveCategories ? JSON.stringify(p.sensitiveCategories) : null;
  const VALID_INCIDENT_MODES = ["ANSWER_ONLY", "ANSWER_AND_TRACK", "NORMAL_TICKET"];
  const incidentMode = VALID_INCIDENT_MODES.includes(p.incidentMode) ? p.incidentMode : "ANSWER_AND_TRACK";
  const values = [
    p.name,
    p.posture || "active",
    p.scope || "any",
    p.workspaceId || null,
    p.deploymentMode || "dedicated_legacy",
    p.supportName || null,
    p.iconUrl || null,
    p.replySignature || null,
    p.aiAnswers === false ? 0 : 1,
    p.ticketsEnabled === false ? 0 : 1,
    p.autoEscalate === false ? 0 : 1,
    sensitive,
    p.supportActive === false ? 0 : 1,
    p.autoAssign === true ? 1 : 0,
    p.helperPing === true ? 1 : 0,
    p.shadowMode === true ? 1 : 0,
    incidentMode,
    p.publicTicketsEnabled === false ? 0 : 1,
    p.sla?.unassignedMs || null,
    p.sla?.assignedMs || null,
    p.sla?.waitingMs || null,
    p.sla?.targetMs || null,
    p.sla?.notifyChannel || null,
    p.retention?.contextDays || null,
    p.retention?.ticketsDays || null,
    p.retention?.notesDays || null,
    p.retention?.tracesDays || null,
    p.retention?.analyticsDays || null,
    p.retention?.auditDays || null,
    p.helpChannel || null,
    channels,
    p.helperGroup || null,
    sources,
    milestones,
    guides,
    links,
    categories,
    ticketVisibility,
    nowTs,
  ];

  if (existing) {
    handle()
      .query(
        `UPDATE programs SET name = ?, posture = ?, scope = ?, workspace_id = ?,
         deployment_mode = ?, support_name = ?, icon_url = ?, reply_signature = ?,
         ai_answers = ?, tickets_enabled = ?, auto_escalate = ?,
         sensitive_categories = ?, support_active = ?, auto_assign = ?, helper_ping_enabled = ?, shadow_mode = ?, incident_mode = ?, public_tickets_enabled = ?,
         sla_unassigned_ms = ?, sla_assigned_ms = ?, sla_waiting_ms = ?, sla_target_ms = ?, sla_notify_channel = ?,
         retention_context_days = ?, retention_tickets_days = ?, retention_notes_days = ?, retention_traces_days = ?, retention_analytics_days = ?, retention_audit_days = ?,
         help_channel = ?, channels = ?, helper_group = ?,
         sources = ?, milestones = ?, guides = ?, links = ?, categories = ?, ticket_visibility = ?, updated_at = ? WHERE id = ?`,
      )
      .run(...values, p.id);
  } else {
    handle()
      .query(
        `INSERT INTO programs (id, name, posture, scope, workspace_id, deployment_mode, support_name, icon_url, reply_signature,
         ai_answers, tickets_enabled, auto_escalate, sensitive_categories, support_active, auto_assign, helper_ping_enabled, shadow_mode, incident_mode, public_tickets_enabled,
         sla_unassigned_ms, sla_assigned_ms, sla_waiting_ms, sla_target_ms, sla_notify_channel,
         retention_context_days, retention_tickets_days, retention_notes_days, retention_traces_days, retention_analytics_days, retention_audit_days,
         help_channel, channels, helper_group, sources, milestones, guides, links, categories, ticket_visibility, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, ...values, nowTs);
  }
}

function deleteProgram(id) {
  return handle().query("DELETE FROM programs WHERE id = ?").run(id).changes > 0;
}

/* --------------------------------------------------------------- tickets -- */

// WHY: one serializer for every JSON column so triage and timeline can never
// drift on null-vs-string handling.
function toJson(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function createTicket({ programId, workspaceId = null, channel, threadTs, requesterId, question, category = null, priority = null, summary = null }) {
  const t = now();
  try {
    const result = handle()
      .query(
        `INSERT OR IGNORE INTO tickets (program_id, workspace_id, channel, thread_ts, requester_id, question, category, priority, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(programId, workspaceId, channel, threadTs, requesterId, question, category, priority, summary, t, t);
    if (result.changes > 0) return Number(result.lastInsertRowid);
  } catch (_) {
    // WHY: UNIQUE means a concurrent caller won — fall through to re-read
    // instead of throwing, so getOrCreate stays idempotent under race.
  }
  const existing = getTicketByThreadTs(threadTs, workspaceId, programId);
  if (existing) return existing.id;
  return null;
}

function getTicket(id) {
  return handle().query("SELECT * FROM tickets WHERE id = ?").get(id) || null;
}

function getTicketByThreadTs(threadTs, workspaceId = null, programId = null) {
  if (workspaceId) {
    if (programId) {
      return handle().query("SELECT * FROM tickets WHERE thread_ts = ? AND workspace_id = ? AND program_id = ? LIMIT 1").get(threadTs, workspaceId, programId) || null;
    }
    return handle().query("SELECT * FROM tickets WHERE thread_ts = ? AND workspace_id = ? LIMIT 1").get(threadTs, workspaceId) || null;
  }
  if (programId) {
    return handle().query("SELECT * FROM tickets WHERE thread_ts = ? AND program_id = ? LIMIT 1").get(threadTs, programId) || null;
  }
  // WHY: null-workspace callers predate multi-tenancy and intentionally see
  // the first row for a thread regardless of tenant.
  return handle().query("SELECT * FROM tickets WHERE thread_ts = ? LIMIT 1").get(threadTs) || null;
}

// Guarded so a concurrent Slack-retry race can't attach a second card / ack
// message: only the first writer wins, the loser sees changes === 0.
function updateTicketCardTs(id, cardTs) {
  return handle().query("UPDATE tickets SET card_ts = ? WHERE id = ? AND card_ts IS NULL").run(cardTs, id).changes > 0;
}

function updatePublicAckTs(id, ackTs) {
  return handle().query("UPDATE tickets SET public_ack_ts = ? WHERE id = ? AND public_ack_ts IS NULL").run(ackTs, id).changes > 0;
}

function claimTicket(id, assigneeId) {
  return (
    handle()
      .query("UPDATE tickets SET status = 'claimed', assignee_id = ?, claimed_at = ?, assigned_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'waiting_for_helper')")
      .run(assigneeId, now(), now(), now(), id).changes > 0
  );
}

// Conditional assign wins the two-helpers-click-Claim race: exactly one
// UPDATE can move the row out of an assignable state. Claimed and assigned
// tickets stay assignable so a claim can be handed off without unclaiming.
function assignTicket(id, assigneeId) {
  const t = now();
  return (
    handle()
      .query("UPDATE tickets SET status = 'assigned', assignee_id = ?, assigned_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'claimed', 'assigned', 'waiting_for_helper', 'escalated', 'reopened')")
      .run(assigneeId, t, t, id).changes > 0
  );
}

function unclaimTicket(id) {
  return (
    handle()
      .query("UPDATE tickets SET status = 'open', assignee_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?")
      .run(now(), id).changes > 0
  );
}

// Guarded: a ticket already resolved/closed does not transition again, so a
// double-click or a Slack retry on the Resolve button is a silent no-op
// (changes === 0) rather than a second "resolved" transition.
function resolveTicket(id, resolution = "resolved", resolvedBy = null) {
  const t = now();
  return (
    handle()
      .query("UPDATE tickets SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ?, first_response_at = COALESCE(first_response_at, ?) WHERE id = ? AND status NOT IN ('resolved', 'closed')")
      .run(resolution, resolvedBy, t, t, t, id).changes > 0
  );
}

// Unconditional reopen — an organizer may reopen any ticket, so the count is
// the source of truth for how often a thread bounced.
function reopenTicket(id, reopenedBy = null) {
  const t = now();
  return (
    handle()
      .query("UPDATE tickets SET status = 'reopened', resolution = NULL, resolved_at = NULL, resolved_by = NULL, reopened_by = ?, reopened_at = ?, reopen_count = COALESCE(reopen_count, 0) + 1, updated_at = ? WHERE id = ?")
      .run(reopenedBy, t, t, id).changes > 0
  );
}

// Guarded reopen for the public thread button: only a resolved/closed ticket
// moves, so a double-click can't bump reopen_count twice or post a second
// "reopened" line.
function reopenResolvedTicket(id, reopenedBy = null) {
  const t = now();
  return (
    handle()
      .query("UPDATE tickets SET status = 'reopened', resolution = NULL, resolved_at = NULL, resolved_by = NULL, reopened_by = ?, reopened_at = ?, reopen_count = COALESCE(reopen_count, 0) + 1, updated_at = ? WHERE id = ? AND status IN ('resolved', 'closed')")
      .run(reopenedBy, t, t, id).changes > 0
  );
}

function closeTicket(id) {
  const t = now();
  return handle().query("UPDATE tickets SET status = 'closed', resolved_at = ?, updated_at = ? WHERE id = ?").run(t, t, id).changes > 0;
}

function snoozeTicket(id, untilMs) {
  return handle().query("UPDATE tickets SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?").run(untilMs, now(), id).changes > 0;
}

function markDuplicateTicket(id, canonicalId) {
  return handle().query("UPDATE tickets SET status = 'duplicate', duplicate_of = ?, updated_at = ? WHERE id = ?").run(canonicalId, now(), id).changes > 0;
}

function escalateTicketStatus(id) {
  return handle().query("UPDATE tickets SET status = 'escalated', updated_at = ? WHERE id = ?").run(now(), id).changes > 0;
}

// Promote a not-yet-worked ticket to waiting_for_helper. A conditional UPDATE
// so a message that arrives after the ticket already moved on (claimed,
// assigned, resolved) is a no-op, never a downgrade.
function markTicketWaitingForHelper(id) {
  return handle()
    .query("UPDATE tickets SET status = 'waiting_for_helper', updated_at = ? WHERE id = ? AND status IN ('open', 'reopened', 'escalated')")
    .run(now(), id).changes > 0;
}

function setTicketTriage(id, { category = null, priority = null, summary = null, aiConfidence = null, aiDecision = null } = {}) {
  const decision = toJson(aiDecision);
  return handle().query(
    `UPDATE tickets SET category = COALESCE(?, category), priority = COALESCE(?, priority), summary = COALESCE(?, summary),
     ai_confidence = COALESCE(?, ai_confidence), ai_decision = COALESCE(?, ai_decision), updated_at = ? WHERE id = ?`,
  ).run(category, priority, summary, aiConfidence, decision, now(), id).changes > 0;
}

function recordFirstResponse(id, human = false) {
  const t = now();
  if (human) {
    return handle().query(
      "UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?), first_human_response_at = COALESCE(first_human_response_at, ?), updated_at = ? WHERE id = ?",
    ).run(t, t, t, id).changes > 0;
  }
  // WHY: a second bot touch must not bump updated_at — otherwise SLA and
  // sort order churn on every no-op.
  return handle().query(
    "UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ? AND first_response_at IS NULL",
  ).run(t, t, id).changes > 0;
}

function getTicketsForProgram(programId, status = null) {
  if (status) {
    return handle()
      .query("SELECT * FROM tickets WHERE program_id = ? AND status = ? ORDER BY created_at DESC")
      .all(programId, status);
  }
  return handle()
    .query("SELECT * FROM tickets WHERE program_id = ? ORDER BY created_at DESC")
    .all(programId);
}

// Server-side ticket search for the dashboard. Every filter is tenant-scoped
// and paginated — the client never downloads the whole table.
function searchTickets({ programId, status = null, assigneeId = null, requesterId = null, category = null, priority = null, q = null, sinceMs = null, untilMs = null, limit = 50, offset = 0 } = {}) {
  const clauses = ["program_id = ?"];
  const params = [programId];
  if (status) { clauses.push("status = ?"); params.push(status); }
  if (assigneeId) { clauses.push("assignee_id = ?"); params.push(assigneeId); }
  if (requesterId) { clauses.push("requester_id = ?"); params.push(requesterId); }
  if (category) { clauses.push("category = ?"); params.push(category); }
  if (priority) { clauses.push("priority = ?"); params.push(priority); }
  if (sinceMs !== null && sinceMs !== undefined) { clauses.push("created_at > ?"); params.push(sinceMs); }
  if (untilMs !== null && untilMs !== undefined) { clauses.push("created_at <= ?"); params.push(untilMs); }
  if (q) { clauses.push("(question LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')"); params.push(`%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`, `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const total = handle().query(`SELECT COUNT(*) AS n FROM tickets WHERE ${clauses.join(" AND ")}`).get(...params)?.n || 0;
  const rows = handle().query(
    `SELECT * FROM tickets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, safeLimit, safeOffset);
  return { total, rows };
}

/* ----------------------------------------------------- ticket timeline -- */

// Attempts the channel claim atomically. The PRIMARY KEY(workspace_id,
// channel_id) is the guard: a concurrent second claim fails the insert and
// reads back the winner instead of creating a duplicate.
function claimProgramChannel({ workspaceId = null, channelId, programId, kind = "help", claimedBy = null }) {
  const ws = workspaceId || "default";
  const res = handle()
    .query("INSERT OR IGNORE INTO program_channels (workspace_id, channel_id, program_id, kind, claimed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ws, channelId, programId, kind, claimedBy, now());
  if (res.changes > 0) return { ok: true, programId };
  const owner = handle().query("SELECT program_id, kind FROM program_channels WHERE workspace_id = ? AND channel_id = ?").get(ws, channelId);
  if (owner && owner.program_id === programId) {
    if (owner.kind !== kind) {
      handle().query("UPDATE program_channels SET kind = ? WHERE workspace_id = ? AND channel_id = ?").run(kind, ws, channelId);
    }
    return { ok: true, programId };
  }
  return { ok: false, ownerProgramId: owner ? owner.program_id : null };
}

function releaseProgramChannel({ workspaceId = null, channelId, programId = null }) {
  const ws = workspaceId || "default";
  if (programId) {
    return handle().query("DELETE FROM program_channels WHERE workspace_id = ? AND channel_id = ? AND program_id = ?").run(ws, channelId, programId).changes > 0;
  }
  return handle().query("DELETE FROM program_channels WHERE workspace_id = ? AND channel_id = ?").run(ws, channelId).changes > 0;
}

function getChannelOwner(workspaceId = null, channelId) {
  return handle().query("SELECT * FROM program_channels WHERE workspace_id = ? AND channel_id = ?").get(workspaceId || "default", channelId) || null;
}

function listProgramChannels(programId) {
  return handle().query("SELECT * FROM program_channels WHERE program_id = ? ORDER BY created_at ASC").all(programId);
}

function addTicketEvent({ ticketId, programId, actorId = null, eventType, detail = null }) {
  const d = detail === null || detail === undefined ? null : (typeof detail === "string" ? detail : JSON.stringify(detail));
  const res = handle()
    .query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ticketId, programId, actorId, eventType, d, now());
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

function listTicketEvents(ticketId, limit = 100) {
  return handle().query("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC LIMIT ?").all(ticketId, limit);
}

function addTicketNote({ ticketId, programId, authorId, body }) {
  const clean = String(body || "").trim();
  if (!clean) return null;
  const res = handle()
    .query("INSERT INTO ticket_notes (ticket_id, program_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(ticketId, programId, authorId, clean, now());
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

function listTicketNotes(ticketId, limit = 100) {
  return handle().query("SELECT id, ticket_id, program_id, author_id, body, created_at FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at ASC LIMIT ?").all(ticketId, limit);
}

function recordAuditEvent({ programId = null, actorId = null, action, entityType = null, entityId = null, metadata = null }) {
  const res = handle()
    .query("INSERT INTO audit_events (program_id, actor_id, action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(programId, actorId, action, entityType, entityId, metadata, now());
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

function listAuditEvents({ programId = null, limit = 100 } = {}) {
  if (programId) {
    return handle().query("SELECT * FROM audit_events WHERE program_id = ? ORDER BY created_at DESC LIMIT ?").all(programId, limit);
  }
  return handle().query("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(limit);
}

// Helper membership is explicit so reconciliation removes as well as adds:
// active=0 with removed_at marks a departure without deleting history.
function syncHelper({ programId, userId, source = "manual", role = "helper" }) {
  handle()
    .query(
      `INSERT INTO program_helpers (program_id, user_id, helper_source, role, active, added_at, removed_at)
       VALUES (?, ?, ?, ?, 1, ?, NULL)
       ON CONFLICT(program_id, user_id) DO UPDATE SET helper_source = excluded.helper_source, role = excluded.role, active = 1, removed_at = NULL`,
    )
    .run(programId, userId, source, role, now());
}

function removeHelper({ programId, userId }) {
  return handle().query("UPDATE program_helpers SET active = 0, removed_at = ? WHERE program_id = ? AND user_id = ? AND active = 1").run(now(), programId, userId).changes > 0;
}

function listHelpers(programId, activeOnly = true) {
  if (activeOnly) {
    return handle().query("SELECT * FROM program_helpers WHERE program_id = ? AND active = 1 ORDER BY added_at ASC").all(programId);
  }
  return handle().query("SELECT * FROM program_helpers WHERE program_id = ? ORDER BY added_at ASC").all(programId);
}

function isHelper(programId, userId) {
  if (!programId || !userId) return false;
  return !!handle().query("SELECT 1 FROM program_helpers WHERE program_id = ? AND user_id = ? AND active = 1").get(programId, userId);
}

function recordAnsweredThread({ question, channel, threadTs }) {
  if (!question || !channel || !threadTs) return;
  const cleanQ = String(question).trim();
  if (!cleanQ) return;
  try {
    handle()
      .query(
        "INSERT INTO answered_threads (question, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(cleanQ, channel, threadTs, now());
  } catch (err) {
    log.debug("db", `recordAnsweredThread failed: ${err.message}`);
  }
}

function getRecentAnsweredThreads(limit = 100) {
  try {
    return handle()
      .query(
        "SELECT id, question, channel, thread_ts, created_at FROM answered_threads ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit);
  } catch (err) {
    log.debug("db", `getRecentAnsweredThreads failed: ${err.message}`);
    return [];
  }
}

function getLearnedFactsWithThreads(limit = 100) {
  try {
    return handle()
      .query(
        "SELECT id, question, channel, source_ts FROM learned_facts WHERE source_ts IS NOT NULL AND channel IS NOT NULL ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit);
  } catch (err) {
    log.debug("db", `getLearnedFactsWithThreads failed: ${err.message}`);
    return [];
  }
}

module.exports = {
  open,
  close,
  ensureSchema,
  // The moved answer-cache SQL in lib/cache.js writes through these.
  now,
  // Exposed for tests that need to backdate rows to exercise retention — there
  // is no other way to age a record without waiting days for it.
  handle,
  sweep,
  recordAnsweredThread,
  getRecentAnsweredThreads,
  getLearnedFactsWithThreads,
  startSweeper,
  claimMessage,
  wasAnswered,
  touchThread,
  getThread,
  addThreadMessage,
  getThreadMessages,
  recordUserMessage,
  recentUserMessages,
  recordTopic,
  getTopics,
  recordGap,
  recordGapRejection,
  clearGapRejection,
  topGaps,
  unclassifiedGaps,
  setGapKind,
  gapCountsByKind,
  gapForThread,
  gapThreads,
  addLearnedFact,
  listLearnedFacts,
  getLearnedFactById,
  approvedFacts,
  setLearnedStatus,
  updateLearnedFact,
  candidateForTicket,
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
  muteThread,
  isThreadMuted,
  unmuteThread,
  markTakeover,
  isTakeover,
  clearTakeover,
  recordMetric,
  recordLlmUsage,
  llmUsageSummary,
  llmUsageReport,
  metricCounts,
  lastMetricAt,
  metricDetails,
  medianLatency,
  countRecentRequests,
  recordRequest,
  getDbPrograms,
  saveSourceText,
  loadSourceText,
  recordSourceFailure,
  getSourceHealth,
  saveProgram,
  deleteProgram,
  createTicket,
  getTicket,
  getTicketByThreadTs,
  updateTicketCardTs,
  updatePublicAckTs,
  claimTicket,
  assignTicket,
  unclaimTicket,
  resolveTicket,
  reopenTicket,
  reopenResolvedTicket,
  closeTicket,
  snoozeTicket,
  markDuplicateTicket,
  escalateTicketStatus,
  markTicketWaitingForHelper,
  setTicketTriage,
  recordFirstResponse,
  getTicketsForProgram,
  searchTickets,
  claimProgramChannel,
  releaseProgramChannel,
  getChannelOwner,
  listProgramChannels,
  addTicketEvent,
  listTicketEvents,
  addTicketNote,
  listTicketNotes,
  recordAuditEvent,
  listAuditEvents,
  syncHelper,
  removeHelper,
  listHelpers,
  isHelper,
  MAX_THREAD_MESSAGES,
  MAX_USER_TOPICS,
  MAX_USER_MESSAGES,
  GUIDE_TTL_MS,
  CACHE_FRESH_MS,
  CACHE_IDLE_MS,
};
