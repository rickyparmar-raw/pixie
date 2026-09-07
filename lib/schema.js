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

-- The last handful of things each person said, verbatim. The intent gate reads
-- these: "it still doesnt work" is chat after a joke and a cry for help after
-- twenty minutes of debugging, and the message alone cannot tell you which.
-- Swept aggressively — this is short-term context, not history.
CREATE TABLE IF NOT EXISTS user_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  channel    TEXT,
  thread_ts  TEXT,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_messages_user ON user_messages(user_id, id DESC);

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

CREATE TABLE IF NOT EXISTS muted_threads (
  thread_ts    TEXT PRIMARY KEY,
  channel      TEXT,
  muted_at     INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS source_cache (
  name       TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  posture      TEXT DEFAULT 'active',
  scope        TEXT DEFAULT 'any',
  help_channel TEXT,
  channels     TEXT,
  helper_group TEXT,
  sources      TEXT,
  milestones   TEXT,
  guides       TEXT,
  links        TEXT,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  thread_ts    TEXT NOT NULL,
  card_ts      TEXT,
  requester_id TEXT NOT NULL,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  assignee_id  TEXT,
  resolution   TEXT,
  created_at   INTEGER NOT NULL,
  claimed_at   INTEGER,
  resolved_at  INTEGER
);

CREATE TABLE IF NOT EXISTS answered_threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  channel     TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
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
  // Whether an unaddressed message has to be ABOUT this program for pixie to
  // answer it. 'any' keeps the original behaviour (general coding and tooling
  // questions get answered too); 'program' means she stays out of everything
  // else unless someone addresses her. See lib/intent.js.
  ["programs", "scope", "ALTER TABLE programs ADD COLUMN scope TEXT DEFAULT 'any'"],
  ["learned_facts", "program_id", "ALTER TABLE learned_facts ADD COLUMN program_id TEXT"],
  ["doc_gaps", "program_id", "ALTER TABLE doc_gaps ADD COLUMN program_id TEXT"],
  // Human-rejected questions. topGaps excludes these for the same window the
  // rank itself covers; a maintainer re-approving one (rare, manual) clears it.
  // Keyed on the normalized question so phrasing variations collapse onto one row.
  ["gap_rejections", "table", "CREATE TABLE IF NOT EXISTS gap_rejections (question TEXT NOT NULL PRIMARY KEY, created_at INTEGER NOT NULL)"],
  ["answered_threads", "table", "CREATE TABLE IF NOT EXISTS answered_threads (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, channel TEXT NOT NULL, thread_ts TEXT NOT NULL, created_at INTEGER NOT NULL)"],
  // Unified hosted platform: every tenant boundary carries the Slack workspace
  // identity, since channel IDs alone are only unique within one workspace.
  ["programs", "workspace_id", "ALTER TABLE programs ADD COLUMN workspace_id TEXT"],
  ["programs", "deployment_mode", "ALTER TABLE programs ADD COLUMN deployment_mode TEXT DEFAULT 'dedicated_legacy'"],
  ["programs", "support_name", "ALTER TABLE programs ADD COLUMN support_name TEXT"],
  ["programs", "icon_url", "ALTER TABLE programs ADD COLUMN icon_url TEXT"],
  ["programs", "ai_answers", "ALTER TABLE programs ADD COLUMN ai_answers INTEGER NOT NULL DEFAULT 1"],
  ["programs", "tickets_enabled", "ALTER TABLE programs ADD COLUMN tickets_enabled INTEGER NOT NULL DEFAULT 1"],
  ["programs", "auto_escalate", "ALTER TABLE programs ADD COLUMN auto_escalate INTEGER NOT NULL DEFAULT 1"],
  ["programs", "sensitive_categories", "ALTER TABLE programs ADD COLUMN sensitive_categories TEXT"],
  ["programs", "support_active", "ALTER TABLE programs ADD COLUMN support_active INTEGER NOT NULL DEFAULT 1"],
  ["programs", "created_at", "ALTER TABLE programs ADD COLUMN created_at INTEGER"],
  // Explicit channel claims. The UNIQUE(workspace_id, channel_id) constraint is
  // the atomic guard behind program activation: two programs can never own the
  // same channel, and double-submit Activate collapses onto one row.
  ["program_channels", "table", "CREATE TABLE IF NOT EXISTS program_channels (workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, program_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'help', claimed_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, channel_id))"],
  ["tickets", "workspace_id", "ALTER TABLE tickets ADD COLUMN workspace_id TEXT"],
  ["tickets", "category", "ALTER TABLE tickets ADD COLUMN category TEXT"],
  ["tickets", "priority", "ALTER TABLE tickets ADD COLUMN priority TEXT"],
  ["tickets", "summary", "ALTER TABLE tickets ADD COLUMN summary TEXT"],
  ["tickets", "ai_confidence", "ALTER TABLE tickets ADD COLUMN ai_confidence REAL"],
  ["tickets", "ai_decision", "ALTER TABLE tickets ADD COLUMN ai_decision TEXT"],
  ["tickets", "duplicate_of", "ALTER TABLE tickets ADD COLUMN duplicate_of INTEGER"],
  ["tickets", "first_response_at", "ALTER TABLE tickets ADD COLUMN first_response_at INTEGER"],
  ["tickets", "first_human_response_at", "ALTER TABLE tickets ADD COLUMN first_human_response_at INTEGER"],
  ["tickets", "assigned_at", "ALTER TABLE tickets ADD COLUMN assigned_at INTEGER"],
  ["tickets", "reopened_at", "ALTER TABLE tickets ADD COLUMN reopened_at INTEGER"],
  ["tickets", "reopen_count", "ALTER TABLE tickets ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0"],
  ["tickets", "snoozed_until", "ALTER TABLE tickets ADD COLUMN snoozed_until INTEGER"],
  ["tickets", "updated_at", "ALTER TABLE tickets ADD COLUMN updated_at INTEGER"],
  // Per-ticket timeline (status changes, replies, notes refs) and helper-only
  // internal notes. Notes never enter the requester thread.
  ["ticket_events", "table", "CREATE TABLE IF NOT EXISTS ticket_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, program_id TEXT NOT NULL, actor_id TEXT, event_type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)"],
  ["ticket_notes", "table", "CREATE TABLE IF NOT EXISTS ticket_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, program_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)"],
  // Append-only platform audit. Rows are never updated or deleted by app code;
  // retention sweeps may archive them but must not rewrite history.
  ["audit_events", "table", "CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT, actor_id TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, metadata TEXT, created_at INTEGER NOT NULL)"],
  // Helper membership with provenance so reconciliation can add AND remove.
  ["program_helpers", "table", "CREATE TABLE IF NOT EXISTS program_helpers (program_id TEXT NOT NULL, user_id TEXT NOT NULL, helper_source TEXT NOT NULL DEFAULT 'manual', role TEXT NOT NULL DEFAULT 'helper', active INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL, removed_at INTEGER, PRIMARY KEY (program_id, user_id))"],
  // Verified resolution memory reuses learned_facts: which category the
  // resolution belongs to, which ticket it came from, who verified it, when.
  ["learned_facts", "category", "ALTER TABLE learned_facts ADD COLUMN category TEXT"],
  ["learned_facts", "ticket_id", "ALTER TABLE learned_facts ADD COLUMN ticket_id INTEGER"],
  ["learned_facts", "resolver_id", "ALTER TABLE learned_facts ADD COLUMN resolver_id TEXT"],
  ["learned_facts", "verified_at", "ALTER TABLE learned_facts ADD COLUMN verified_at INTEGER"],
  // Program-scoped support macros (?shipping). Templates interpolate a fixed
  // safe value set only — no expression evaluation, no nested lookups.
  ["program_macros", "table", "CREATE TABLE IF NOT EXISTS program_macros (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, trigger TEXT NOT NULL, name TEXT NOT NULL, description TEXT, content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, allowed_roles TEXT, on_send_transition TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (program_id, trigger))"],
  // Helper routing: declared expertise tags plus auto-counted resolutions.
  ["helper_expertise", "table", "CREATE TABLE IF NOT EXISTS helper_expertise (program_id TEXT NOT NULL, user_id TEXT NOT NULL, tag TEXT NOT NULL, solved_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (program_id, user_id, tag))"],
  ["programs", "auto_assign", "ALTER TABLE programs ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0"],
  ["programs", "shadow_mode", "ALTER TABLE programs ADD COLUMN shadow_mode INTEGER NOT NULL DEFAULT 0"],
  // Incident candidates from burst detection. Announcements are drafts only.
  ["program_incidents", "table", "CREATE TABLE IF NOT EXISTS program_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate', reason TEXT, confidence REAL, started_at INTEGER NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER, resolved_at INTEGER)"],
  ["incident_tickets", "table", "CREATE TABLE IF NOT EXISTS incident_tickets (incident_id INTEGER NOT NULL, ticket_id INTEGER NOT NULL, program_id TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY (incident_id, ticket_id))"],
  // Per-program SLA thresholds (ms) and notification channel. Unset (NULL)
  // means the rule is off for that program — the checker is a no-op then.
  ["programs", "sla_unassigned_ms", "ALTER TABLE programs ADD COLUMN sla_unassigned_ms INTEGER"],
  ["programs", "sla_assigned_ms", "ALTER TABLE programs ADD COLUMN sla_assigned_ms INTEGER"],
  ["programs", "sla_waiting_ms", "ALTER TABLE programs ADD COLUMN sla_waiting_ms INTEGER"],
  ["programs", "sla_target_ms", "ALTER TABLE programs ADD COLUMN sla_target_ms INTEGER"],
  ["programs", "sla_notify_channel", "ALTER TABLE programs ADD COLUMN sla_notify_channel TEXT"],
  // Per-program retention windows (days). Audit has a platform floor enforced
  // in code; knowledge defaults to keep (approved facts survive ticket deletion).
  ["programs", "retention_context_days", "ALTER TABLE programs ADD COLUMN retention_context_days INTEGER"],
  ["programs", "retention_tickets_days", "ALTER TABLE programs ADD COLUMN retention_tickets_days INTEGER"],
  ["programs", "retention_notes_days", "ALTER TABLE programs ADD COLUMN retention_notes_days INTEGER"],
  ["programs", "retention_traces_days", "ALTER TABLE programs ADD COLUMN retention_traces_days INTEGER"],
  ["programs", "retention_analytics_days", "ALTER TABLE programs ADD COLUMN retention_analytics_days INTEGER"],
  ["programs", "retention_audit_days", "ALTER TABLE programs ADD COLUMN retention_audit_days INTEGER"],
  // Metrics gain tenant scope so analytics and retention can attribute them.
  ["metrics", "program_id", "ALTER TABLE metrics ADD COLUMN program_id TEXT"],
  // Single-flight leases so periodic jobs never run twice across replicas.
  ["job_leases", "table", "CREATE TABLE IF NOT EXISTS job_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)"],
  ["sla_notifications", "table", "CREATE TABLE IF NOT EXISTS sla_notifications (program_id TEXT NOT NULL, ticket_id INTEGER NOT NULL, rule TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (program_id, ticket_id, rule))"],
];

// Anything that references a column a migration may have just added.
const POST_MIGRATION_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_doc_gaps_ts ON doc_gaps(message_ts);
CREATE INDEX IF NOT EXISTS idx_doc_gaps_kind ON doc_gaps(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_cache_idle ON answer_cache(last_asked_at);
CREATE INDEX IF NOT EXISTS idx_cache_popular ON answer_cache(ask_count DESC, refreshed_at);
CREATE INDEX IF NOT EXISTS idx_active_guides_message_ts ON active_guides(message_ts);
CREATE INDEX IF NOT EXISTS idx_learned_program ON learned_facts(program_id);
CREATE INDEX IF NOT EXISTS idx_doc_gaps_program ON doc_gaps(program_id);
CREATE INDEX IF NOT EXISTS idx_tickets_thread ON tickets(thread_ts);
CREATE INDEX IF NOT EXISTS idx_tickets_program_status ON tickets(program_id, status);
CREATE INDEX IF NOT EXISTS idx_answered_threads_ts ON answered_threads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answered_threads_channel ON answered_threads(channel, thread_ts);
CREATE INDEX IF NOT EXISTS idx_programs_workspace ON programs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_program_channels_program ON program_channels(program_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_workspace_thread ON tickets(workspace_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_tickets_program_assignee_status ON tickets(program_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_program_created ON tickets(program_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_program_created ON audit_events(program_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_helpers_program_active ON program_helpers(program_id, active);
CREATE INDEX IF NOT EXISTS idx_learned_ticket ON learned_facts(ticket_id);
CREATE INDEX IF NOT EXISTS idx_learned_category ON learned_facts(program_id, status, category);
CREATE INDEX IF NOT EXISTS idx_macros_program ON program_macros(program_id, enabled);
CREATE INDEX IF NOT EXISTS idx_expertise_program ON helper_expertise(program_id, tag);
CREATE INDEX IF NOT EXISTS idx_incidents_program_status ON program_incidents(program_id, status);
CREATE INDEX IF NOT EXISTS idx_incident_tickets_ticket ON incident_tickets(ticket_id);
CREATE INDEX IF NOT EXISTS idx_metrics_program ON metrics(program_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sla_notifications_program ON sla_notifications(program_id, sent_at);
`;

module.exports = { SCHEMA, MIGRATIONS, POST_MIGRATION_SCHEMA };

