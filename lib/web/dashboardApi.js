// Dashboard ops endpoints for the organizer dashboard (pixie-wizard).
// Pure assembly like web/api.js: every write maps to an existing lib/
// function, every read is a DB query. No business logic lives here.
//
// Coverage for what the legacy routes lack: sortable ticket search, an ops
// metrics rollup, knowledge source status + refresh, and a helper roster
// with an availability toggle. Every function takes programId first and
// returns { error } on denial — unknown programs and cross-program ticket
// access both surface as { error: "unknown program" } /
// { error: "ticket not found" } so serve.js maps them to 404, never 403
// (a 403 would confirm the row exists to a caller scoped to another
// program).
const db = require("../db");
const programs = require("../programs");
const log = require("../log");
const ticketMetrics = require("../ticketMetrics");

function needProgram(programId) {
  if (!programId || !programs.get(programId)) return { error: "unknown program" };
  return null;
}

function ticketActorAllowed(programId, actorId) {
  // Same fail-closed membership check as web/api.js: an empty roster denies,
  // and the ticket's own program is the tenant (never client claims).
  try {
    return require("../tickets").isActorAllowed(programId, actorId, false);
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------- ticket search -- */

// Status groups for the dashboard filter row. "open" is the working set an
// operator triages (narrower than every non-resolved state: snoozed,
// duplicate and closed tickets are out of the queue, not in it).
const OPEN_GROUP = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
const RESOLVED_GROUP = ["resolved"];

// Sort whitelist — column + default direction. "waiting" is longest-waiting
// first (oldest creation), which for open tickets is the triage order.
const SORTS = {
  created: { column: "created_at", dir: "DESC" },
  updated: { column: "updated_at", dir: "DESC" },
  waiting: { column: "created_at", dir: "ASC" },
};

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function ticketSearchScoped(programId, params = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const sort = SORTS[params.sort] ? params.sort : "created";
  const dir = params.dir === "asc" || params.dir === "desc"
    ? params.dir.toUpperCase()
    : SORTS[sort].dir;
  const clauses = ["program_id = ?"];
  const values = [programId];
  if (params.status) {
    clauses.push("status = ?");
    values.push(params.status);
  } else if (params.statusGroup === "open") {
    clauses.push(`status IN (${OPEN_GROUP.map(() => "?").join(",")})`);
    values.push(...OPEN_GROUP);
  } else if (params.statusGroup === "resolved") {
    clauses.push(`status IN (${RESOLVED_GROUP.map(() => "?").join(",")})`);
    values.push(...RESOLVED_GROUP);
  }
  if (params.assigneeId) { clauses.push("assignee_id = ?"); values.push(params.assigneeId); }
  if (params.requesterId) { clauses.push("requester_id = ?"); values.push(params.requesterId); }
  if (params.category) { clauses.push("category = ?"); values.push(params.category); }
  if (params.priority) { clauses.push("priority = ?"); values.push(params.priority); }
  if (params.since) { clauses.push("created_at > ?"); values.push(Number(params.since)); }
  if (params.until) { clauses.push("created_at <= ?"); values.push(Number(params.until)); }
  if (params.q) {
    clauses.push("(question LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    values.push(`%${escapeLike(params.q)}%`, `%${escapeLike(params.q)}%`);
  }
  const where = clauses.join(" AND ");
  const safeLimit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(params.offset) || 0, 0);
  const total = db.handle().query(`SELECT COUNT(*) AS n FROM tickets WHERE ${where}`).get(...values)?.n || 0;
  const rows = db.handle().query(
    `SELECT * FROM tickets WHERE ${where} ORDER BY ${SORTS[sort].column} ${dir} LIMIT ? OFFSET ?`,
  ).all(...values, safeLimit, safeOffset);
  if (rows.length === 0) return { total, rows };
  // Responder attribution + note counts in two batched queries, not N+1.
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const firstReplies = db.handle().query(
    `SELECT ticket_id, actor_id, MIN(created_at) AS at FROM ticket_events
     WHERE ticket_id IN (${placeholders}) AND event_type = 'helper_reply' GROUP BY ticket_id`,
  ).all(...ids);
  const noteCounts = db.handle().query(
    `SELECT ticket_id, COUNT(*) AS n FROM ticket_notes WHERE ticket_id IN (${placeholders}) GROUP BY ticket_id`,
  ).all(...ids);
  const firstByTicket = new Map(firstReplies.map((r) => [r.ticket_id, r.actor_id]));
  const notesByTicket = new Map(noteCounts.map((r) => [r.ticket_id, r.n]));
  for (const row of rows) {
    row.first_responder_id = firstByTicket.get(row.id) || null;
    row.notes_count = notesByTicket.get(row.id) || 0;
  }
  return { total, rows };
}

function ticketDetailScoped(programId, ticketId) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const ticket = db.getTicket(Number(ticketId));
  // Cross-program access degrades to not-found: the row exists, but not in
  // this tenant, so for this caller it does not exist.
  if (!ticket || ticket.program_id !== programId) return { error: "ticket not found" };
  const resolutionSummary = ticket.resolution_summary || null;
  return {
    ticket: { ...ticket, resolutionSummary },
    resolutionSummary,
    events: db.listTicketEvents(ticket.id),
    notes: db.listTicketNotes(ticket.id),
  };
}

/* ------------------------------------------------------------- metrics -- */

function median(values) {
  const sorted = [...values].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function average(values) {
  const clean = [...values].filter((n) => Number.isFinite(n) && n >= 0);
  if (clean.length === 0) return null;
  return Math.round(clean.reduce((sum, n) => sum + n, 0) / clean.length);
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function volumeByDay(rows, cutoff, now) {
  const days = new Map();
  for (let t = Date.parse(`${utcDay(cutoff)}T00:00:00Z`); t <= now; t += 86400000) {
    const date = utcDay(t);
    days.set(date, { date, questions: 0, aiOnly: 0, human: 0 });
  }
  for (const row of rows) {
    const day = days.get(utcDay(row.created_at));
    if (!day) continue;
    day.questions += 1;
    if (row.first_human_response_at) day.human += 1;
    else if (row.first_response_at) day.aiOnly += 1;
  }
  return [...days.values()];
}

// Metrics rows that mean "Pixie could not answer from the docs". Silent rows
// carry the respond.js gap/grounding reasons as detail; jev_downstream_block
// rows are Jev-permitted generations the grounding gate rejected (detail is
// the downstream reason: require_grounded, gap_escalated, ...).
const BLOCKED_DETAILS = new Set(["ungrounded", "gap_escalated", "unclear_escalated"]);
const ANSWERED_KINDS = new Set(["answer_docs", "answer_chat", "answer_link"]);

// Program-scoped ops rollup for the analytics page. Every figure is counted
// from stored tickets/ticket_events/metrics rows — no estimates, no model.
function metricsOverview(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  const now = Date.now();
  const cutoff = now - days * 86400000;

  const totals = ticketMetrics.programTotals(programId, { since: cutoff });

  const rows = db.handle().query(
    `SELECT created_at, first_response_at, first_human_response_at, resolved_at, resolved_by, assignee_id, status
     FROM tickets WHERE program_id = ? AND created_at > ?`,
  ).all(programId, cutoff);

  const firstLags = rows
    .filter((r) => r.first_response_at)
    .map((r) => r.first_response_at - r.created_at);
  const resolveLags = rows
    .filter((r) => r.status === "resolved" && r.resolved_at)
    .map((r) => r.resolved_at - r.created_at);
  const pixieAnswered = rows.filter((r) => r.first_response_at && !r.first_human_response_at).length;
  const humanHandled = rows.filter((r) => r.first_human_response_at).length;

  const metricRows = db.handle().query(
    "SELECT kind, detail FROM metrics WHERE program_id = ? AND created_at > ?",
  ).all(programId, cutoff);
  const byReason = {};
  let blocked = 0;
  let answered = 0;
  for (const row of metricRows) {
    if (row.kind === "jev_downstream_block") {
      blocked += 1;
      const reason = `jev_downstream_block:${row.detail || "unknown"}`;
      byReason[reason] = (byReason[reason] || 0) + 1;
    } else if (row.kind === "silent" && BLOCKED_DETAILS.has(row.detail)) {
      blocked += 1;
      byReason[row.detail] = (byReason[row.detail] || 0) + 1;
    } else if (ANSWERED_KINDS.has(row.kind)) {
      answered += 1;
    }
  }

  const openLoad = db.handle().query(
    `SELECT assignee_id AS userId, COUNT(*) AS openAssigned FROM tickets
     WHERE program_id = ? AND assignee_id IS NOT NULL
     AND created_at > ? AND status IN (${OPEN_GROUP.map(() => "?").join(",")}) GROUP BY assignee_id`,
  ).all(programId, cutoff, ...OPEN_GROUP);
  const resolvedBy = ticketMetrics.leaderboard(programId, { since: cutoff })
    .filter((row) => row.resolved > 0)
    .map((row) => ({ userId: row.userId, resolved: row.resolved }));
  const resolvedMap = new Map(resolvedBy.map((r) => [r.userId, r.resolved]));
  const helpers = openLoad.map((r) => ({
    userId: r.userId,
    openAssigned: r.openAssigned,
    resolved: resolvedMap.get(r.userId) || 0,
  }));
  for (const r of resolvedBy) {
    if (!helpers.some((h) => h.userId === r.userId)) {
      helpers.push({ userId: r.userId, openAssigned: 0, resolved: r.resolved });
    }
  }
  helpers.sort((a, b) => (b.openAssigned + b.resolved) - (a.openAssigned + a.resolved));

  return {
    programId,
    windowDays: days,
    created: totals.created,
    openTickets: totals.open,
    waitingForHelper: totals.waiting,
    resolved: totals.resolvedInWindow,
    firstResponse: { medianMs: totals.medianFirstResponseMs, averageMs: average(firstLags), n: firstLags.length },
    resolution: { medianMs: totals.medianResolveMs, averageMs: average(resolveLags), n: resolveLags.length },
    volumeByDay: volumeByDay(rows, cutoff, now),
    answers: { pixieAnswered, humanHandled },
    grounding: { blocked, byReason, answered, blockRate: rate(blocked, blocked + answered) },
    helpers,
  };
}

/* ------------------------------------------------------------ knowledge -- */

// Scrub credentials out of a source URL before it leaves Core. Mirrors the
// web/api.js publicSourceUrl contract: userinfo, query and fragment never
// render on the dashboard.
function publicSourceUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_) {
    return String(value).split(/[?#]/, 1)[0];
  }
}

const SOURCE_STATUSES = new Set(["Pending", "Fetching", "Processing", "Ready", "Error", "Stale"]);

// lib/knowledge.js reports lowercase states (pending|fetching|ready|error|
// stale); the dashboard renders capitalized labels. Anything unknown is
// Pending rather than a made-up state.
function normalizeSourceStatus(value) {
  const raw = String(value || "");
  const cap = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return SOURCE_STATUSES.has(cap) ? cap : "Pending";
}

function sanitizeSourceRow(row) {
  return {
    name: row.name || "source",
    type: row.type || null,
    url: publicSourceUrl(row.url),
    status: normalizeSourceStatus(row.status),
    lastSyncedAt: Number.isFinite(Number(row.lastSyncedAt)) ? Number(row.lastSyncedAt) : null,
    lastSuccessAt: Number.isFinite(Number(row.lastSuccessAt)) ? Number(row.lastSuccessAt) : null,
    error: typeof row.error === "string" && row.error ? row.error.slice(0, 500) : null,
    chunks: Number.isInteger(row.chunks) && row.chunks >= 0 ? row.chunks : null,
  };
}

// Per-source sync status for the knowledge page. Delegates to knowledge.js
// when it provides sourceStatus(programId) (owned by another worker);
// otherwise degrades to the same freshness signals the corpus gate reads,
// with chunk counts unavailable.
function knowledgeStatus(programId) {
  const missing = needProgram(programId);
  if (missing) return missing;
  let knowledge = null;
  try {
    knowledge = require("../knowledge");
  } catch (_) {
    knowledge = null;
  }
  if (knowledge && typeof knowledge.sourceStatus === "function") {
    try {
      const rows = knowledge.sourceStatus(programId);
      const list = Array.isArray(rows) ? rows : [];
      return { programId, sources: list.map(sanitizeSourceRow) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "knowledge status failed" };
    }
  }
  // Graceful fallback: program-declared sources plus source_cache health.
  const program = programs.get(programId);
  const declared = Array.isArray(program.sources) ? program.sources : [];
  const sources = declared.map((source) => {
    let key = null;
    try {
      key = knowledge && typeof knowledge.sourceCacheKey === "function"
        ? knowledge.sourceCacheKey(source)
        : source.name;
    } catch (_) {
      key = source.name;
    }
    let health = null;
    try {
      health = key ? db.getSourceHealth([key])[0] || null : null;
    } catch (_) {
      health = null;
    }
    const failCount = Number(health?.fail_count || 0);
    const hasLastGood = Boolean(health?.last_success_at);
    const status = !hasLastGood && failCount === 0 ? "Pending"
      : failCount > 0 && !hasLastGood ? "Error"
      : failCount > 0 ? "Stale"
      : "Ready";
    return sanitizeSourceRow({
      name: source.name || source.label,
      type: source.type,
      url: source.url,
      status,
      lastSyncedAt: Number(health?.fetched_at) || null,
      lastSuccessAt: Number(health?.last_success_at) || null,
      error: failCount > 0 ? health?.last_error : null,
      chunks: null,
    });
  });
  return { programId, sources };
}

// Fire-and-forget refresh: the fetch fan-out must not hold the HTTP call.
// Returns { started: true } once the job is kicked off, never its result.
function knowledgeRefresh(programId) {
  const missing = needProgram(programId);
  if (missing) return missing;
  let knowledge = null;
  try {
    knowledge = require("../knowledge");
  } catch (_) {
    knowledge = null;
  }
  if (!knowledge || typeof knowledge.refreshProgramSources !== "function") {
    return { error: "knowledge refresh is not available" };
  }
  try {
    const res = knowledge.refreshProgramSources(programId, { force: true });
    if (res && typeof res.catch === "function") {
      res.catch((e) => log.warn("web/dashboardApi", `program source refresh failed (${programId}): ${e instanceof Error ? e.message : e}`));
    }
    return { started: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "knowledge refresh failed" };
  }
}

/* -------------------------------------------------------------- helpers -- */

// Single-call roster for the helpers page: role, availability (active —
// inactive helpers take no pings and no assignments), declared expertise,
// workload and solved counts, plus the program's own categories so the
// expertise editor can suggest from them.
function helperRoster(programId) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const program = programs.get(programId);
  let stats = [];
  try {
    stats = require("../helperStats").listHelperStats(programId, { recentLimit: 1, since: Date.now() - 30 * 86400000 });
  } catch (_) {
    stats = [];
  }
  const byId = new Map(stats.map((s) => [s.userId, s]));
  const helpers = db.listHelpers(programId, false).map((h) => {
    const s = byId.get(h.user_id);
    return {
      userId: h.user_id,
      role: h.role,
      active: Boolean(h.active),
      pingEligible: h.ping_eligible !== 0,
      source: h.helper_source,
      expertise: s ? s.expertise : [],
      categoryResolved: s ? s.categoryResolved : [],
      openAssigned: s ? s.totals.open : 0,
      resolved: s ? s.totals.resolved : 0,
      helpfulPercentage: s ? s.helpfulPercentage : null,
      lastActivity: s ? s.lastActivity : null,
    };
  });
  helpers.sort((a, b) => (b.openAssigned + b.resolved) - (a.openAssigned + a.resolved));
  return { programId, categories: program.categories || null, helpers };
}

// Availability toggle: active helpers are eligible for pings and routing,
// inactive ones keep their history but take nothing new. Same membership bar
// as every other dashboard write — the actor must be a helper of the
// program (the wizard page additionally restricts the switch to
// owners/admins; Core re-checks membership here regardless).
function helperSetActive(programId, body = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(programId, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!userId) return { error: "userId required" };
  const row = db.listHelpers(programId, false).find((h) => h.user_id === userId);
  if (!row) return { error: "helper not found" };
  // Pausing pings keeps the helper on the roster (commands, manual
  // assignment); only automatic offers and pings skip them.
  if (typeof body.pingEligible === "boolean") {
    db.setHelperPingEligible({ programId, userId, eligible: body.pingEligible });
  } else if (body.active === false) {
    db.removeHelper({ programId, userId });
  } else {
    db.syncHelper({ programId, userId, source: row.helper_source || "manual", role: row.role || "helper" });
  }
  try {
    require("../audit").record({
      programId,
      actorId,
      action: typeof body.pingEligible === "boolean"
        ? (body.pingEligible ? "helper.pings_resumed" : "helper.pings_paused")
        : body.active === false ? "helper.deactivated" : "helper.activated",
      entityType: "helper",
      entityId: userId,
    });
  } catch (e) {
    log.warn("web/dashboardApi", `helper availability audit failed: ${e.message}`);
  }
  const updated = db.listHelpers(programId, false).find((h) => h.user_id === userId);
  return { ok: true, helper: updated ? { userId: updated.user_id, active: Boolean(updated.active), pingEligible: updated.ping_eligible !== 0, role: updated.role } : null };
}

module.exports = {
  OPEN_GROUP,
  RESOLVED_GROUP,
  ticketSearchScoped,
  ticketDetailScoped,
  metricsOverview,
  knowledgeStatus,
  knowledgeRefresh,
  helperRoster,
  helperSetActive,
};
