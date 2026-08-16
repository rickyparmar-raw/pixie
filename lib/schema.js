// Table definitions and migrations, split out of db.js to keep that file about
// queries rather than DDL.
//
// Ordering matters: SCHEMA runs first, then MIGRATIONS adds columns that
// predate nothing, then POST_MIGRATION_SCHEMA creates anything that references
// a just-added column. Indexing a column before its migration lands aborts the
// whole schema on an existing database.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS answered_messages (
  ts          TEXT PRIMARY KEY,
  channel     TEXT,
  answered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_ts  TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  user_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_ts, id);

-- Marks a thread as one pixie has spoken in, so thread replies can be gated
-- without an intent call. Also carries the "seeded real Slack history" flag.
CREATE TABLE IF NOT EXISTS threads (
  thread_ts   TEXT PRIMARY KEY,
  channel     TEXT,
  seeded      INTEGER NOT NULL DEFAULT 0,
  pixie_spoke INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_topics (
  user_id    TEXT NOT NULL,
  topic      TEXT NOT NULL,
  was_helpful INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic)
);

CREATE TABLE IF NOT EXISTS answer_cache (
  question_hash TEXT PRIMARY KEY,
  question      TEXT NOT NULL,
  source        TEXT,
  answer        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  message_ts TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  vote       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_ts, user_id)
);

-- Questions that got no grounded answer. This is the docs to-do list, and the
-- anchor for auto-capture: message_ts lets a later human reply in the same
-- thread be matched back to the question pixie missed.
CREATE TABLE IF NOT EXISTS doc_gaps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  user_id    TEXT,
  channel    TEXT,
  message_ts TEXT,
  created_at INTEGER NOT NULL
);
-- NOTE: the index on message_ts lives in POST_MIGRATION_SCHEMA, not here — on a
-- database created before that column existed, this block runs before the
-- migration adds it, and indexing a missing column aborts the whole schema.

-- Answers pixie was taught, or captured from a helper replying to a question
-- it missed. Approved rows are appended to the corpus, so this is the one
-- table whose contents change what pixie says.
CREATE TABLE IF NOT EXISTS learned_facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  author_id  TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  source_ts  TEXT,
  channel    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learned_status ON learned_facts(status, created_at);
-- One capture per source message, so a chatty thread can't queue five
-- near-identical pending rows off the same question.
CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_source ON learned_facts(source_ts) WHERE source_ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS active_guides (
  thread_ts    TEXT PRIMARY KEY,
  guide_id     TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  user_id      TEXT,
  started_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_kind ON metrics(kind, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_user ON rate_limits(user_id, created_at);
`;
// CREATE TABLE IF NOT EXISTS can't add a column to a table that already
// exists, so columns introduced after a database is in the wild need this.
// Each entry is idempotent — a duplicate-column error just means it's applied.
const MIGRATIONS = [
  ["doc_gaps", "message_ts", "ALTER TABLE doc_gaps ADD COLUMN message_ts TEXT"],
  // What pixie has learned about which questions matter. The cache used to be
  // swept wholesale on a 6h clock, so an answer worked out forty times was
  // discarded on the same schedule as one worked out once and the table never
  // accumulated anything. Retention is by popularity now, which needs to know
  // how often and how recently each entry was actually wanted.
  ["answer_cache", "ask_count", "ALTER TABLE answer_cache ADD COLUMN ask_count INTEGER NOT NULL DEFAULT 1"],
  ["answer_cache", "last_asked_at", "ALTER TABLE answer_cache ADD COLUMN last_asked_at INTEGER"],
  ["answer_cache", "refreshed_at", "ALTER TABLE answer_cache ADD COLUMN refreshed_at INTEGER"],
  // Whether a missed question is actually a hole in the documentation. A gap
  // row only ever meant "pixie couldn't answer this", which is a much weaker
  // claim: an outage, someone's broken laptop and a half-typed fragment all
  // landed in the same to-do list as the real gaps. NULL means not yet judged —
  // see lib/report.js.
  ["doc_gaps", "kind", "ALTER TABLE doc_gaps ADD COLUMN kind TEXT"],
  ["metrics", "detail", "ALTER TABLE metrics ADD COLUMN detail TEXT"],
  // The Slack ts of the most recently posted step for this guide, so a
  // :upvote: reaction on that specific message can be matched back to the
  // guide it belongs to (see db.getGuideByMessageTs, lib/handlers.js).
  ["active_guides", "message_ts", "ALTER TABLE active_guides ADD COLUMN message_ts TEXT"],
];

// Anything that references a column a migration may have just added.
const POST_MIGRATION_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_doc_gaps_ts ON doc_gaps(message_ts);
CREATE INDEX IF NOT EXISTS idx_doc_gaps_kind ON doc_gaps(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_cache_idle ON answer_cache(last_asked_at);
CREATE INDEX IF NOT EXISTS idx_cache_popular ON answer_cache(ask_count DESC, refreshed_at);
CREATE INDEX IF NOT EXISTS idx_active_guides_message_ts ON active_guides(message_ts);
`;

module.exports = { SCHEMA, MIGRATIONS, POST_MIGRATION_SCHEMA };
