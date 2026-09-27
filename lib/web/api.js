// Web API handlers. Pure assembly: every write maps to an existing lib/
// function, every read is a DB query. No business logic lives here.
const db = require("../db");
const cache = require("../cache");
const learn = require("../learn");
const knowledge = require("../knowledge");
const report = require("../report");
const programs = require("../programs");
const log = require("../log");
const config = require("../config").config;
const { probe } = require("../probe");
const { coverageStats, relativeTime } = require("../stats");

/* --------------------------------------------------------------- pulse -- */

function buildPulse() {
  const stats = coverageStats();
  const now = Date.now();

  // Previous week for delta.
  const prev = report.collect(1);
  const curr = report.collect(0);

  const delta = curr.answered.total > 0 && prev.answered.total > 0
    ? curr.coverage - prev.coverage
    : 0;

  const pendingCount = learn.pending().length;
  const knownCount = cache.cachedCount();
  const instant = stats.instant;

  return {
    coverage: stats.rate,
    coverageDelta: delta,
    answered: stats.docs + stats.chat + stats.link,
    silent: stats.silent,
    knownCold: knownCount,
    instantPercent: instant,
    queue: pendingCount,
    corpusRefreshedAt: knowledge.lastBuiltAt?.toISOString() || null,
    corpusRefreshedRelative: relativeTime(knowledge.lastBuiltAt?.getTime()),
    time: now,
  };
}

/* ---------------------------------------------------------------- ask -- */

async function handleAsk(question) {
  if (!question) return { error: "empty question" };
  return probe(question);
}

/* -------------------------------------------------------------- queue -- */

function queueList() {
  const pending = learn.pending(100);
  return pending.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    authorId: row.author_id,
    channel: row.channel,
    sourceTs: row.source_ts,
    created: row.created_at,
    createdRelative: relativeTime(row.created_at),
  }));
}

function queueApprove(id) {
  learn.approve(id);
}

function queueDrop(id) {
  learn.forget(id);
}

function queueEdit(id, question, answer) {
  if (!question || !answer) return;
  // Re-teach under the original fact's program and provenance; an edit must
  // never move a fact to another tenant or orphan it.
  const original = db.getLearnedFactById(id);
  if (!original) return;
  learn.forget(id);
  learn.teach({
    question,
    answer,
    authorId: original.author_id || null,
    threadTs: original.source_ts || null,
    channel: original.channel || null,
    programId: original.program_id || null,
  });
}

/* --------------------------------------------------------------- gaps -- */

function gapsList() {
  const counts = db.gapCountsByKind();
  const docs = db.topGaps(50, 30 * 24 * 60 * 60 * 1000, { kind: report.DOCS });
  const transient = db.topGaps(50, 30 * 24 * 60 * 60 * 1000, { kind: report.TRANSIENT });
  const noise = db.topGaps(50, 30 * 24 * 60 * 60 * 1000, { kind: report.NOISE });

  // Unjudged: raw rows, not grouped.
  const unjudged = db.handle()
    .query("SELECT id, question, user_id, channel, message_ts, created_at FROM doc_gaps WHERE kind IS NULL ORDER BY created_at DESC LIMIT 100")
    .all()
    .map((r) => ({
      id: r.id,
      question: r.question,
      userId: r.user_id,
      channel: r.channel,
      messageTs: r.message_ts,
      created: r.created_at,
    }));

  return {
    counts: {
      docs: counts[report.DOCS] || 0,
      transient: counts[report.TRANSIENT] || 0,
      noise: counts[report.NOISE] || 0,
      unjudged: counts.unjudged || 0,
    },
    columns: {
      docs: docs.map((g) => ({ id: g.id, question: g.question, count: g.count, lastAsked: g.last_asked })),
      transient: transient.map((g) => ({ id: g.id, question: g.question, count: g.count, lastAsked: g.last_asked })),
      noise: noise.map((g) => ({ id: g.id, question: g.question, count: g.count, lastAsked: g.last_asked })),
      unjudged,
    },
  };
}

function gapsMove(id, kind) {
  if ([report.DOCS, report.TRANSIENT, report.NOISE].includes(kind)) {
    db.setGapKind(id, kind);
  }
}

async function gapsRejudge(id) {
  const row = db.handle().query("SELECT question FROM doc_gaps WHERE id = ?").get(id);
  if (!row) return { error: "not found" };
  const kind = await report.judgeGap(row.question);
  if (kind) db.setGapKind(id, kind);
  return { id, kind: kind || "unknown" };
}

/* ------------------------------------------------------------ silence -- */

function silenceList() {
  const details = db.metricDetails("silent");
  return {
    breakdown: details.map((d) => ({ reason: d.detail, count: d.count })),
    total: details.reduce((sum, d) => sum + d.count, 0),
  };
}

/* --------------------------------------------------------- knowledge -- */

function knowledgeInfo() {
  const sources = knowledge.loadSources().map((s) => ({
    name: s.name,
    type: s.type,
    url: publicSourceUrl(s.url),
    ...sourceHealthShape(s),
  }));

  const corpus = knowledge.getCorpus();
  const index = knowledge.getIndex();

  return {
    sources,
    metrics: sourceHealthMetrics(),
    corpusLength: corpus.length,
    chunkCount: index.docs.length,
    lastBuilt: knowledge.lastBuiltAt?.toISOString() || null,
    lastBuiltRelative: relativeTime(knowledge.lastBuiltAt?.getTime()),
  };
}

function sourceHealthMetrics() {
  const counts = Object.fromEntries(db.metricCounts().map((row) => [row.kind, row.count]));
  return {
    sourceRefreshFailure: counts.source_refresh_failure || 0,
    staleDynamicSourceUsed: counts.stale_dynamic_source_used || 0,
  };
}

// Keep the health response deliberately smaller than knowledge's internal
// source-cache row. In particular, cache keys and fetch errors can contain
// tenant URLs or credentials. The source key itself remains inside knowledge,
// where freshness is resolved against the namespaced cache row.
function sourceHealthShape(source) {
  const health = knowledge.sourceEligibility(source);
  return {
    authority: health.authority,
    freshness: health.freshness,
    lastSuccessAt: health.lastSuccessAt,
    failCount: health.failCount,
    hasLastGood: health.hasLastGood,
    exactClaimsAllowed: health.exactClaimsAllowed,
    eligible: health.eligible,
  };
}

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

function scopedSources(programId) {
  const program = programs.get(programId);
  if (!program) return null;
  const shared = program.sharedSources === false ? [] : (programs.shared().sources || []);
  const seen = new Set();
  return [...(program.sources || []), ...shared].filter((source) => {
    const key = knowledge.sourceCacheKey(source);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Program-scoped counterpart used by internal consumers. Do not derive this
// from loadSources(): that intentionally returns the refresh set for every
// hosted program and would cross tenant boundaries in a health response.
function internalKnowledgeHealth(programId) {
  const sources = scopedSources(programId);
  if (!sources) return { error: "unknown program" };
  return {
    programId,
    sources: sources.map((source) => ({
      name: source.name,
      type: source.type,
      url: publicSourceUrl(source.url),
      ...sourceHealthShape(source),
    })),
    metrics: sourceHealthMetrics(),
  };
}

function knowledgeCorpus() {
  const index = knowledge.getIndex();
  return {
    corpus: knowledge.getCorpus().slice(0, 50000),
    chunks: index.docs.map((d) => ({
      source: d.chunk.source,
      heading: d.chunk.heading || null,
      text: d.chunk.text.slice(0, 300),
      length: d.chunk.text.length,
      termCount: d.length,
    })),
  };
}

async function knowledgeRefresh() {
  // force=true — someone in the web console explicitly hit refresh, same
  // reasoning as the /pixie-reload slash command.
  const before = new Map(knowledge.loadSources().map((source) => [
    knowledge.sourceCacheKey(source), knowledge.sourceFreshness(source).failCount,
  ]));
  await knowledge.refreshCorpus(true);
  for (const source of knowledge.loadSources()) {
    const key = knowledge.sourceCacheKey(source);
    const beforeFailures = before.get(key) || 0;
    const health = knowledge.sourceFreshness(source);
    for (let i = beforeFailures; i < health.failCount; i += 1) {
      db.recordMetric("source_refresh_failure", null, source.name);
    }
    if (health.authority === "dynamic" && health.freshness === "stale" && health.hasLastGood) {
      db.recordMetric("stale_dynamic_source_used", null, source.name);
    }
  }
}

/* ------------------------------------------------------------- cache -- */

function cacheList() {
  const stale = cache.staleCacheEntries(db.CACHE_FRESH_MS, 20);
  const top = cache.topCached(20);

  return {
    known: cache.cachedCount(),
    stale: stale.map((r) => ({
      hash: r.question_hash,
      question: r.question,
      askCount: r.ask_count,
    })),
    top: top.map((r) => ({
      hash: r.question_hash,
      question: r.question,
      askCount: r.ask_count,
      source: r.source,
      ageMs: Date.now() - r.written_at,
      stale: Date.now() - r.written_at > db.CACHE_FRESH_MS,
    })),
  };
}

function cacheBust(hash) {
  cache.forget(hash);
}

/* ------------------------------------------------------------- teach -- */

// A taught fact always belongs to one program — a program-less fact would be
// served to nobody (or, historically, to everybody).
function handleTeach(question, answer, authorId, programId = null) {
  if (!question || !answer) return false;
  if (!programId || !programs.get(programId)) return { error: "programId required (an existing program)" };
  return learn.teach({ question, answer, authorId, programId });
}

/* ------------------------------------------------------------ report -- */

function reportText(week = 0) {
  return { text: report.reportText(week) };
}

let slackClient = null;

function setSlackClient(client) {
  slackClient = client;
}

async function reportPost() {
  if (!slackClient) return false;
  return report.postWeekly(slackClient);
}

/* ------------------------------------------------------------- health -- */

function healthCheck() {
  const missing = [];
  if (!config.slack.botToken) missing.push("SLACK_BOT_TOKEN");
  return {
    models: {
      answer: config.answer.model,
      answerUrl: config.answer.baseUrl,
      intent: config.intent.model,
      vision: config.vision.model,
    },
    channels: {
      help: config.slack.helpChannel || "not set",
      faq: config.slack.faqChannels,
      autoReply: config.slack.autoReplyChannel || "not set",
      report: config.reportChannel || "not set",
    },
    admins: config.slack.adminUserIds,
    missing,
    dbPath: process.env.PIXIE_DB_PATH || "default (pixie.db)",
  };
}
function programsList() {
  return programs.all();
}

function programSave(prog) {
  if (!prog || !prog.id || !prog.name) return { error: "id and name are required" };
  programs.saveProgram(prog);
  return { ok: true, program: programs.get(prog.id) };
}

function programRemove(id) {
  if (!id) return { error: "id required" };
  programs.removeProgram(id);
  return { ok: true };
}

function programSetPosture(id, posture) {
  const existing = programs.get(id);
  if (!existing) return { error: "program not found" };
  programs.saveProgram({ ...existing, posture });
  return { ok: true, posture };
}

function ticketsList(programId = null, status = null) {
  if (programId) {
    return db.getTicketsForProgram(programId, status);
  }
  const queryStr = status
    ? "SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC LIMIT 100"
    : "SELECT * FROM tickets ORDER BY created_at DESC LIMIT 100";
  return status ? db.handle().query(queryStr).all(status) : db.handle().query(queryStr).all();
}

function ticketUpdate(id, status, assigneeId = null, actorId = null) {
  const map = { claimed: "claim", unclaim: "unclaim", resolved: "resolve", reopen: "reopen", closed: "close" };
  const action = map[status];
  if (!action) return { error: `unknown status ${status}` };
  const body = { actorId, assigneeId };
  if (action === "claim") body.assigneeId = assigneeId || "admin";
  if (action === "resolve") body.resolution = "resolved via admin dashboard";
  const res = internalTicketAction(id, action, body);
  if (res.error) return res;
  return res;
}

/* ------------------------------------------------------------- channels -- */

function channelsList() {
  const list = programs.getChannelsList();
  return list.map((ch) => {
    let msgCount = 0;
    let ticketCount = 0;
    try {
      msgCount = db.handle().query("SELECT COUNT(*) as count FROM user_messages WHERE channel = ?").get(ch.channelId)?.count || 0;
      ticketCount = db.handle().query("SELECT COUNT(*) as count FROM tickets WHERE channel = ?").get(ch.channelId)?.count || 0;
    } catch (e) {
      log.debug("web/api", `channel counts query failed for ${ch.channelId}: ${e.message}`);
    }
    return {
      ...ch,
      msgCount,
      ticketCount,
    };
  });
}

function channelToggle(body = {}) {
  const { channelId, programId, field, value } = body;
  if (!channelId) return { error: "channelId required" };

  const prog = programs.get(programId) || (programs.all()[0] || null);
  if (!prog) return { error: "program not found" };

  if (field === "posture") {
    programs.saveProgram({ ...prog, posture: value });
  } else if (field === "ticketDestination") {
    programs.setChannelTicketDestination(prog.id, channelId);
  } else if (field === "helpChannel") {
    programs.saveProgram({ ...prog, helpChannel: value ? channelId : null });
  } else if (field === "replyEnabled") {
    programs.saveProgram({ ...prog, posture: value ? "active" : "muted" });
  }

  return { ok: true, channels: channelsList() };
}

function channelAdd(body = {}) {
  const { programId, channelId, isHelp } = body;
  if (!channelId) return { error: "channelId required" };
  const targetProgId = programId || "pixl";
  const ok = programs.addChannelToProgram(targetProgId, channelId.trim(), !!isHelp);
  return { ok, channels: channelsList() };
}

function channelRemove(programId, channelId) {
  if (!channelId) return { error: "channelId required" };
  const targetProgId = programId || "pixl";
  const ok = programs.removeChannelFromProgram(targetProgId, channelId);
  return { ok, channels: channelsList() };
}

/* ------------------------------------------------- control-plane API -- */

// Machine-to-machine boundary between Pixie Core (this process, the Slack
// connection, the runtime state) and Pixie Wizard (the Next.js control
// plane). Authenticated by PIXIE_INTERNAL_TOKEN, never by browser sessions.
//
// Tenant rule: every write names its program explicitly and the ticket's
// stored program must match — a helper in Program A cannot mutate Program B
// even with a valid token. Actor rule: the acting Slack user must be a Pixie
// admin or an active helper of that program. Wizard verifies session-level
// eligibility (allowlist, ownership); Core re-verifies tenant + actor here.

function internalAuth(req) {
  const token = process.env.PIXIE_INTERNAL_TOKEN;
  if (!token) return { ok: false, status: 404, body: { error: "internal api disabled" } };
  const header = req.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length !== token.length) return { ok: false, status: 401, body: { error: "unauthorized" } };
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
  if (diff !== 0) return { ok: false, status: 401, body: { error: "unauthorized" } };
  return { ok: true };
}

function ticketActorAllowed(programId, actorId) {
  // WHY: Wizard fails closed on an empty roster — same check as Slack, opposite empty policy.
  try {
    return require("../tickets").isActorAllowed(programId, actorId, false);
  } catch (_) {
    return false;
  }
}

// Shared internal guards: every control-plane write re-resolves tenant from
// stored rows (never trusts client-supplied program/helper IDs for auth) and
// fails closed on missing membership. Error strings are part of the
// serve.js status-mapping contract — keep them byte-identical.
function needProgram(programId) {
  if (!programs.get(programId)) return { error: "unknown program" };
  return null;
}

function needProgramActor(programId, actorId) {
  if (!programs.get(programId)) return { error: "unknown program" };
  if (!ticketActorAllowed(programId, actorId)) return { error: "actor is not a helper of this program" };
  return null;
}

function ticketTenantError(ticket, body = {}) {
  if (body.programId && body.programId !== ticket.program_id) return "program mismatch";
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) return "workspace mismatch";
  return null;
}

function ticketDetail(id) {
  const ticket = db.getTicket(id);
  if (!ticket) return null;
  const resolutionSummary = ticket.resolution_summary || null;
  return {
    ticket: { ...ticket, resolutionSummary },
    resolutionSummary,
    events: db.listTicketEvents(id),
    notes: db.listTicketNotes(id),
  };
}

// Upsert from the control plane. Channel claims go through the atomic claim
// path: a conflicting help channel fails the whole sync rather than stealing
// the channel, and double-submit Activate collapses onto the existing row.
const CHANNEL_KINDS = new Set(["help", "organizer", "discussion", "announcement"]);

function internalProgramSync(id, body = {}) {
  if (!id || !/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(id)) {
    return { error: "invalid program id (lowercase slug, 3-62 chars)" };
  }
  const { programChannels = [], behavior: behaviorPatch, status: statusValue, ...fields } = body;
  if (!fields.name || String(fields.name).length > 80) return { error: "name is required (max 80 chars)" };

  const programModel = require("../programModel");
  // Runtime status is a closed enum — reject anything else at the boundary
  // rather than letting db.saveProgram silently null it.
  if (statusValue !== undefined && statusValue !== null && !programModel.STATUSES.includes(statusValue)) {
    return { error: `invalid status ${statusValue} (sandbox|live|paused)` };
  }

  const routing = require("../routing");
  const channels = Array.isArray(programChannels) ? programChannels : [];
  const workspaceId = fields.workspaceId || null;

  const existing = programs.get(id);
  const merged = {
    ...(existing || { id, guides: ["submit-ysws-guidelines"], links: {} }),
    ...fields,
    id,
    deploymentMode: "hosted_shared",
    supportActive: fields.supportActive === false ? false : true,
  };
  // Behavior patches merge onto the stored value (unknown keys dropped by the
  // sanitizer), so a settings save that only touches one toggle never wipes
  // the rest. Untouched when the caller sent no behavior key at all.
  if (Object.hasOwn(body, "behavior")) {
    merged.behavior = programModel.mergeBehavior(existing?.behavior || null, behaviorPatch);
  }
  if (statusValue !== undefined && statusValue !== null) merged.status = statusValue;

  // Pre-save channel-role validation: the candidate program (this sync
  // applied) is checked against every other program plus the hosted claim
  // table, so a conflicting help/main assignment fails the whole sync with a
  // 409 before a single row is written — never a partial save plus a claim
  // error afterward.
  const roleCheck = validateSyncChannelRoles(id, merged, channels, workspaceId);
  if (roleCheck) return roleCheck;
  programs.saveProgram(merged);

  if (channels.length > 0) {
    for (const ch of channels) {
      const kind = typeof ch === "object" ? ch.kind || "help" : "help";
      if (!CHANNEL_KINDS.has(kind) && kind !== "release") return { error: `invalid channel kind ${kind}` };
    }
    // Releases first so a help-channel move never double-owns mid-flight;
    // claims then run atomically with rollback as usual. Ticket history keeps
    // old channel IDs untouched — only live routing moves.
    for (const ch of channels) {
      if (typeof ch === "object" && ch.kind === "release" && ch.id) {
        try {
          db.releaseProgramChannel({ workspaceId, channelId: ch.id, programId: id });
        } catch (e) {
          log.warn("web/api", `channel release failed (${ch.id}): ${e.message}`);
        }
      }
    }
    const toClaim = channels.filter((ch) => !(typeof ch === "object" && ch.kind === "release"));
    const claim = routing.claimChannelsForProgram({
      workspaceId,
      programId: id,
      channels: toClaim,
      claimedBy: body.claimedBy || null,
    });
    if (!claim.ok) {
      return {
        error: `channel ${claim.conflictChannel} is already owned by program ${claim.ownerProgramId}`,
        status: 409,
        conflictChannel: claim.conflictChannel,
      };
    }
  }

  // Bootstrap authorization (amendment 4): the verified creator becomes the
  // first organizer helper at claim time, so later actor checks have a
  // membership to consult instead of an empty table that fails open.
  if (body.claimedBy) {
    try {
      db.syncHelper({ programId: id, userId: body.claimedBy, source: "creator", role: "organizer" });
    } catch (e) {
      log.warn("web/api", `creator helper sync failed (${body.claimedBy}): ${e.message}`);
    }
  }

  try {
    require("../audit").record({
      programId: id,
      actorId: body.claimedBy || null,
      action: existing ? "program.updated" : "program.created",
      entityType: "program",
      entityId: id,
    });
  } catch (error) {
    log.warn("web/api", `program audit write failed: ${error.message}`);
  }
  try {
    require("../knowledge").invalidate();
  } catch (error) {
    log.warn("web/api", `knowledge invalidation failed: ${error.message}`);
  }
  return { ok: true, program: programs.get(id) };
}

// Candidate channel-role check for internalProgramSync. Derives the help/main
// assignment this sync intends (explicit programChannels claims win; fields
// carry the rest) and validates it against all other stored programs plus the
// hosted claim table. Returns a 409-shaped error naming the channel, or null
// when there is no conflict. Pure read — saves nothing.
function validateSyncChannelRoles(id, merged, channels, workspaceId) {
  const programModel = require("../programModel");
  const releases = new Set();
  const toClaim = [];
  for (const ch of channels) {
    const channelId = typeof ch === "string" ? ch : ch?.id;
    const kind = typeof ch === "object" ? ch.kind || "help" : "help";
    if (!channelId) continue;
    if (kind === "release") releases.add(channelId);
    else toClaim.push({ id: channelId, kind });
  }
  let helpChannel = merged.helpChannel || null;
  let organizerChannel = merged.organizerChannel || null;
  let mainChannels = new Set(merged.channels || []);
  if (toClaim.length > 0) {
    const helpEntry = toClaim.find((c) => c.kind === "help");
    if (helpEntry) helpChannel = helpEntry.id;
    const orgEntry = toClaim.find((c) => c.kind === "organizer");
    if (orgEntry) organizerChannel = orgEntry.id;
    mainChannels = new Set(toClaim.filter((c) => c.kind !== "help" && c.kind !== "organizer").map((c) => c.id));
  }
  for (const released of releases) mainChannels.delete(released);
  if (helpChannel) mainChannels.delete(helpChannel);
  if (organizerChannel) mainChannels.delete(organizerChannel);

  const candidate = { id, workspaceId: merged.workspaceId || workspaceId || null, helpChannel, organizerChannel, channels: [...mainChannels] };
  const rest = programs.all().filter((p) => p && p.id !== id && p.id !== "ysws-global");
  let claims = [];
  try {
    // This program's own claims are rewritten by the sync itself; only other
    // programs' claims can conflict with the candidate.
    claims = (db.listChannelClaims?.() || []).filter((c) => c.program_id !== id);
  } catch (_) {
    claims = [];
  }
  const { config: liveConfig } = require("../config");
  const check = programModel.validateChannelRoles({
    programs: [...rest, candidate],
    legacyHelp: liveConfig?.slack?.helpChannel || null,
    legacyMain: liveConfig?.slack?.faqChannels || [],
    claims,
  });
  if (check.ok) return null;
  const first = check.errors[0];
  return {
    error: `channel ${first.channelId} conflicts with another program: ${first.message}`,
    status: 409,
    conflictChannel: first.channelId,
  };
}

// Retrieved source names from a corpus context blob (`### name` sections).
function sourceNamesFromContext(context) {
  const names = [];
  for (const line of String(context || "").split("\n")) {
    const match = line.match(/^###\s+(.+?)\s*$/);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

// Expected action for the sandbox test panel, decided by the same functions
// respond() uses (lib/pipeline/messagePolicy.js planEngagement → finalAction)
// plus the ticket policy that decides whether an escalation actually files a
// ticket or pages anyone. No second copy of the rules lives here.
//   "reply"          grounded answer (or addressed general chat)
//   "uncertain"      addressed, not verifiable: transparent "can't verify"
//   "ticket+helper"  handed to a human
//   "silence"
function testQuestionExpectedAction({ program, role, settings, addressed = false, engagement, grounded, hasAnswer = false }) {
  const messagePolicy = require("../pipeline/messagePolicy");
  const plan = messagePolicy.planEngagement({ role, settings, addressed, engagement });
  if (!plan.proceed) return { expectedAction: "silence", reason: plan.reason };
  const aiOff = program?.aiAnswers === false || (role === "help" && settings?.aiReplies === false);
  let action = aiOff && plan.kind === "program"
    ? (role === "help" && settings?.escalateUnknown !== false ? "escalate" : addressed ? "uncertain" : "silence")
    : messagePolicy.finalAction({ role, settings, addressed, kind: plan.kind, grounded, hasAnswer, unclear: false });
  if (action.startsWith("escalate")) {
    const policy = require("../tickets/policy").ticketPolicy({ program, role });
    const human = policy.recordTicket || policy.pingHelpers;
    action = human ? "escalate" : addressed ? "uncertain" : "silence";
  }
  const map = { reply: "reply", reply_chat: "reply", uncertain: "uncertain", escalate: "ticket+helper", silence: "silence" };
  return { expectedAction: map[action] || "silence", reason: plan.reason };
}

// Retrieved source names from a corpus context blob (`### name` sections).
function sourceNamesFromContext(context) {
  const names = [];
  for (const line of String(context || "").split("\n")) {
    const match = line.match(/^###\s+(.+?)\s*$/);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

// Sandbox test-question probe for onboarding: the real engagement classifier,
// real retrieval and a grounded-answer attempt, with zero Slack or ticket side
// effects (lookupAnswer reads the corpus and the model only). Returns what
// Pixie would do in the chosen channel role, and why.
async function internalTestQuestion(programId, body = {}) {
  const program = programs.get(programId);
  if (!program) return { error: "unknown program" };
  const question = String(body.question || "").trim();
  if (!question) return { error: "question required" };
  if (question.length > 1000) return { error: "question too long (max 1000 chars)" };

  let role = ["main", "help", "organizer"].includes(body.role) ? body.role : "help";
  if (body.channelId) {
    try {
      const resolved = require("../channelPolicy").resolve(body.channelId, body.workspaceId || program.workspaceId || null, {});
      if (resolved && ["help", "main", "organizer"].includes(resolved.role)) role = resolved.role;
    } catch (_) {
      // Fall through with the caller-supplied role.
    }
  }
  const addressed = body.addressed === true;
  const behavior = require("../programModel").behaviorFor(program);
  const settings = role === "help" ? behavior.help : role === "organizer"
    ? { ...behavior.main, ambientProgramReplies: false, ticketsEnabled: false, helperEscalationEnabled: false }
    : behavior.main;

  let engagement = { engage: false, intent: null, error: "unavailable", source: null };
  try {
    engagement = await require("../pipeline/engagement").classify({ message: question, program, role, addressed });
  } catch (_) {
    // Probe reports the classifier as unavailable.
  }

  let context = "";
  try {
    context = require("../knowledge").getContext(question, programId) || "";
  } catch (_) {
    context = "";
  }
  const sources = sourceNamesFromContext(context);

  let result = null;
  try {
    result = await require("../lookup").lookupAnswer(question, "", program, null, { skipCache: true });
  } catch (error) {
    log.warn("web/api", "test-question lookup failed");
    result = null;
  }
  let grounded = false;
  try {
    grounded = require("../respond").isGroundedAnswer(result);
  } catch (_) {
    grounded = false;
  }

  const decided = testQuestionExpectedAction({ program, role, settings, addressed, engagement, grounded, hasAnswer: Boolean(result?.answer) });
  return {
    ok: true,
    programId,
    role,
    addressed,
    intent: engagement.intent || null,
    engaged: Boolean(engagement.engage),
    classifierError: engagement.error || null,
    sources,
    grounded,
    expectedAction: decided.expectedAction,
    reason: decided.reason,
    // Only text Pixie would actually post is previewed.
    answerPreview: decided.expectedAction === "reply" && result && result.answer ? String(result.answer).slice(0, 500) : null,
  };
}

function internalTicketSearch(params) {
  if (!params.programId) return { error: "programId required" };
  return db.searchTickets({
    programId: params.programId,
    status: params.status || null,
    assigneeId: params.assigneeId || null,
    requesterId: params.requesterId || null,
    category: params.category || null,
    priority: params.priority || null,
    q: params.q || null,
    sinceMs: params.since ? Number(params.since) : null,
    untilMs: params.until ? Number(params.until) : null,
    limit: params.limit || 50,
    offset: params.offset || 0,
  });
}

// WHY: dashboard mutations share the Slack canonicals so cards, timelines
// and audit stay in sync — no raw db writes here.
function internalTicketAction(id, action, body = {}) {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) {
    return { error: "workspace mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }

  const tickets = require("../tickets");
  const base = { programId: body.programId || null, workspaceId: body.workspaceId || null, client: slackClient || null };
  // The one thing that separates this from a Slack-side action: it came from
  // the dashboard. Lands in audit metadata only — domain state is identical.
  const source = body.source || "dashboard";
  let res = null;
  switch (action) {
    case "claim":
      res = tickets.claimTicket({ ticketId: id, actorId, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    case "assign":
      if (!body.assigneeId) return { error: "assigneeId required" };
      res = tickets.assignTicket({ ticketId: id, actorId, assigneeId: body.assigneeId, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    case "unclaim":
      res = tickets.unclaimTicket({ ticketId: id, actorId, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    case "resolve":
      res = tickets.resolveTicket({ ticketId: id, actorId, resolution: body.resolution || null, source, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    case "reopen":
      res = tickets.reopenTicket({ ticketId: id, actorId, source, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    case "close":
      res = tickets.closeTicket({ ticketId: id, actorId, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    case "snooze":
      res = tickets.snoozeTicket({ ticketId: id, actorId, until: body.until, programId: base.programId, workspaceId: base.workspaceId });
      break;
    case "duplicate":
      res = tickets.duplicateTicket({ ticketId: id, actorId, canonicalId: body.canonicalId, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    case "escalate":
      res = tickets.escalateStatusTicket({ ticketId: id, actorId, programId: base.programId, workspaceId: base.workspaceId, client: base.client });
      break;
    default:
      return { error: `unknown action ${action}` };
  }
  if (res.error) return res;
  return { ok: true, ticket: ticketDetail(id) };
}

async function internalTicketReply(id, body = {}) {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) {
    return { error: "workspace mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  if (!slackClient) return { error: "slack client unavailable" };
  const tickets = require("../tickets");
  return tickets.replyToTicket({ ticketId: id, authorId: actorId, text: body.text, client: slackClient, programId: body.programId, workspaceId: body.workspaceId, source: "dashboard" });
}

function internalTicketNote(id, body = {}) {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) {
    return { error: "workspace mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const tickets = require("../tickets");
  return tickets.addInternalNote({ ticketId: id, authorId: actorId, body: body.body, programId: body.programId, workspaceId: body.workspaceId });
}

// Helper reconciliation from the control plane: the provided set becomes the
// non-manual membership, so removals propagate instead of going stale.
function internalHelpersSync(programId, body = {}) {
  // Tenant first: never create orphan membership for an unknown program.
  if (!programs.get(programId)) return { error: "unknown program" };
  const actorId = body.actorId || null;
  const { isAdmin } = require("../config");
  if (!(actorId && (isAdmin(actorId) || db.isHelper(programId, actorId)))) {
    return { error: "actor is not a helper of this program" };
  }
  const source = body.source || "organizer_channel";
  const members = Array.isArray(body.members) ? body.members : [];
  const seen = new Set();
  for (const userId of members) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    db.syncHelper({ programId, userId, source, role: "helper" });
  }
  // Ping eligibility travels with the roster sync (dashboard onboarding step
  // "eligible for pings"); absent means unchanged.
  const notPinged = new Set(Array.isArray(body.pingIneligible) ? body.pingIneligible : []);
  if (Array.isArray(body.pingIneligible)) {
    for (const userId of seen) db.setHelperPingEligible({ programId, userId, eligible: !notPinged.has(userId) });
  }
  if (body.reconcile) {
    for (const row of db.listHelpers(programId)) {
      if (row.helper_source === source && !seen.has(row.user_id)) {
        db.removeHelper({ programId, userId: row.user_id });
      }
    }
  }
  return { ok: true, helpers: db.listHelpers(programId) };
}

/* ------------------------------------------------------------- copilot -- */

// Helper copilot actions for the ticket workspace. Reads are program-scoped;
// model-spending actions (draft/improve/ask) are rate-limited per actor and
// audited. Nothing here sends to Slack — drafts return for human review.
async function internalCopilot(action, body = {}) {
  const copilot = require("../copilot");
  const programId = body.programId || null;
  const actorId = body.actorId || null;
  const denied = needProgramActor(programId, actorId);
  if (denied) return denied;
  const program = programs.get(programId);
  const budget = copilot.checkBudget(actorId || "unknown");
  if (budget) return budget;

  try {
    switch (action) {
      case "draft": {
        if (!body.question) return { error: "question required" };
        const res = await copilot.draftReply({ program, question: body.question, threadTs: body.threadTs || null });
        copilot.auditCopilot(programId, actorId, "draft", { grounded: res.grounded });
        return res;
      }
      case "improve": {
        const res = await copilot.improveReply({ text: body.text });
        if (res.error) return res;
        copilot.auditCopilot(programId, actorId, "improve", { changed: res.changed });
        return res;
      }
      case "summarize": {
        const ticket = body.ticketId ? db.getTicket(Number(body.ticketId)) : null;
        if (body.ticketId && (!ticket || ticket.program_id !== programId)) return { error: "ticket not found in this program" };
        return copilot.summarizeThread({ program, ticket, threadTs: body.threadTs || (ticket && ticket.thread_ts) || null });
      }
      case "factcheck": {
        if (!body.text) return { error: "text required" };
        return copilot.factCheck({ program, text: body.text });
      }
      case "similar": {
        if (!body.question) return { error: "question required" };
        return copilot.findSimilar({ programId, question: body.question, limit: body.limit });
      }
      case "ask": {
        if (!body.question) return { error: "question required" };
        const res = await copilot.ask({ program, question: body.question, threadTs: body.threadTs || null });
        copilot.auditCopilot(programId, actorId, "ask", { grounded: res.grounded });
        return res;
      }
      default:
        return { error: `unknown copilot action ${action}` };
    }
  } catch (e) {
    log.warn("api", `copilot ${action} failed: ${e.message}`);
    return { error: "copilot unavailable right now" };
  }
}

/* ---------------------------------------------- resolution memory API -- */

// Resolved tickets become corpus knowledge only through explicit approval.
// Proposals carry the ticket link; approval stamps verification and
// invalidates caches via learn.approve(); rejection excludes permanently.
function internalKnowledgeCandidates(programId, status = null) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const memory = require("../resolutionMemory");
  return memory.listCandidates(programId, status || memory.CANDIDATE, 50);
}

async function internalKnowledgePropose(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const memory = require("../resolutionMemory");
  const ticket = body.ticketId ? db.getTicket(Number(body.ticketId)) : null;
  if (!ticket || ticket.program_id !== programId) return { error: "ticket not found in this program" };
  return memory.proposeFromTicket({ ticketId: ticket.id, actorId: body.actorId || null });
}

function internalKnowledgeCandidateAction(id, body = {}) {
  const memory = require("../resolutionMemory");
  const actorId = body.actorId || null;
  const row = db.getLearnedFactById(Number(id));
  if (!row) return { error: "candidate not found" };
  const programId = row.program_id;
  if (!programId || !ticketActorAllowed(programId, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  if (body.action === "approve") return memory.approveCandidate({ id: Number(id), actorId, edits: body.edits || {} });
  if (body.action === "reject") return memory.rejectCandidate({ id: Number(id), actorId });
  return { error: `unknown action ${body.action}` };
}

function internalGapClusters(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const clusters = require("../gapClusters");
  return clusters.clusterGaps({
    programId,
    sinceMs: query.sinceMs ? Number(query.sinceMs) : undefined,
    minAskers: query.minAskers ? Number(query.minAskers) : undefined,
  });
}

async function internalFaqPropose(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const clusters = require("../gapClusters");
  return clusters.proposeFaq({ programId, actorId: body.actorId || null, question: body.question });
}

function macroScope(id, actorId) {
  const macros = require("../macros");
  const macro = macros.get(Number(id));
  if (!macro) return { error: "macro not found" };
  if (!ticketActorAllowed(macro.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  return { macro };
}

function internalMacrosList(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const macros = require("../macros");
  return macros.list(programId, { enabledOnly: query.enabledOnly === "1", q: query.q || null });
}

function internalMacroCreate(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const macros = require("../macros");
  const { onSendTransition, on_send_transition, ...fields } = body;
  const transition = onSendTransition !== undefined ? onSendTransition : on_send_transition;
  return macros.create({
    programId,
    ...fields,
    onSendTransition: transition === undefined ? null : transition,
    createdBy: body.actorId || null,
  });
}

function internalMacroUpdate(id, body = {}) {
  const scoped = macroScope(id, body.actorId || null);
  if (scoped.error) return scoped;
  const { actorId, onSendTransition, on_send_transition, ...patch } = body;
  if (onSendTransition !== undefined || on_send_transition !== undefined) {
    patch.on_send_transition = onSendTransition !== undefined ? onSendTransition : on_send_transition;
  }
  return require("../macros").update(Number(id), patch, actorId || null);
}

function internalMacroDelete(id, body = {}) {
  const scoped = macroScope(id, body.actorId || null);
  if (scoped.error) return scoped;
  return require("../macros").remove(Number(id), body.actorId || null);
}

async function internalMacroSend(id, body = {}) {
  const scoped = macroScope(id, body.actorId || null);
  if (scoped.error) return scoped;
  if (!body.ticketId) return { error: "ticketId required" };
  if (!slackClient) return { error: "slack client unavailable" };
  return require("../macros").send({ id: Number(id), ticketId: Number(body.ticketId), actorId: body.actorId || null, client: slackClient });
}

async function internalMacroBulkSend(id, body = {}) {
  const scoped = macroScope(id, body.actorId || null);
  if (scoped.error) return scoped;
  if (!slackClient) return { error: "slack client unavailable" };
  let ticketIds = body.ticketIds;
  if (!Array.isArray(ticketIds) && body.selector === "waiting_for_helper") {
    ticketIds = require("../macros").waitingTicketIds({
      programId: scoped.macro.program_id,
      category: body.category || null,
    });
  }
  if (!Array.isArray(ticketIds)) return { error: "ticketIds must be an array" };
  return require("../macros").sendBulk({
    macroId: Number(id),
    ticketIds,
    actorId: body.actorId || null,
    client: slackClient,
  });
}

function internalMacroTemplates(programId, query = {}) {
  const missing = needProgramActor(programId, query.actorId || null);
  if (missing) return missing;
  const macros = require("../macros");
  return { templates: macros.suggestedTemplates(), placeholders: macros.placeholderDocs() };
}

function internalMacroWaiting(programId, query = {}) {
  const missing = needProgramActor(programId, query.actorId || null);
  if (missing) return missing;
  const ticketIds = require("../macros").waitingTicketIds({ programId, category: query.category || null });
  return { programId, category: query.category || null, ticketIds, count: ticketIds.length };
}

function internalMacroSuggest(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../macros").suggestFor({ programId, question: query.q || "", limit: query.limit ? Number(query.limit) : 3 });
}

function internalRoutingRecommend(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../helperRoute").recommend({ programId, category: query.category || null, limit: query.limit ? Number(query.limit) : 3 });
}

function internalHelperStats(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const stats = require("../helperStats").listHelperStats(programId, {
    recentLimit: Math.min(Math.max(Number(query.recentLimit) || 20, 1), 100),
    since: query.since ? Number(query.since) : Date.now() - 30 * 86400000,
  });
  const program = require("../assignmentLifecycle").programAcceptStats(programId);
  return {
    programId,
    acceptRate: program.acceptRate,
    acceptedAssignments: program.acceptedAssignments,
    completedOffers: program.completedOffers,
    assignmentLifecycle: program.assignmentLifecycle,
    helpers: stats,
  };
}

function internalLeaderboard(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  return { programId, days, leaderboard: require("../ticketMetrics").leaderboard(programId, { since: Date.now() - days * 86400000 }) };
}

function internalShadowRouting(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return { programId, mode: "shadow", decisions: require("../shadowRouting").list(programId, query.limit) };
}

async function internalDraftSync(programId, body = {}) {
  const draft = body.draft || {};
  if (programId !== draft.id) return { error: "draft id mismatch" };
  if (draft.status !== "suspended" || draft.privateSandboxOnly !== true) return { error: "only private suspended drafts may sync" };
  if (draft.autoAssign === true || draft.ticketsEnabled === true) return { error: "draft safety flags invalid" };
  const bindings = Array.isArray(draft.sandboxBindings) ? draft.sandboxBindings : [];
  for (const binding of bindings) {
    if (binding.sandboxOnly !== true || binding.enabled !== true || !["help", "ticket"].includes(binding.role)) return { error: "invalid sandbox binding" };
    if (db.getChannelOwner(draft.workspaceId || "default", binding.channelId)) return { error: `sandbox channel ${binding.channelId} has a production claim` };
  }
  try {
    const result = await require("../knowledge").ingestDraftSources(draft);
    return { ok: true, programId, ...result, bindings: require("../draftSandbox").bindingRows().filter((row) => row.program_id === programId) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "draft ingestion failed" };
  }
}

function internalRoutingExpertise(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const actorId = body.actorId || null;
  if (!body.userId) return { error: "userId required" };
  const tags = require("../helperRoute").setExpertise({ programId, userId: body.userId, tags: body.tags || [] });
  try {
    require("../audit").record({ programId, actorId, action: "routing.expertise_updated", entityType: "helper", entityId: body.userId });
  } catch (error) {
    log.warn("web/api", `routing audit write failed: ${error.message}`);
  }
  return { ok: true, tags };
}

function internalDuplicates(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../incidents").suggestDuplicates({
    programId,
    ticketId: query.ticketId ? Number(query.ticketId) : null,
    question: query.q || "",
    limit: query.limit ? Number(query.limit) : 5,
  });
}

function internalIncidents(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../incidents").listIncidents(programId, query.status || null, query.limit ? Math.min(Number(query.limit) || 50, 200) : 50);
}

function internalIncidentDetail(incidentId) {
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId));
  if (!inc) return { error: "incident not found" };
  return { incident: inc, tickets: incidents.incidentTickets(Number(incidentId)) };
}

function internalIncidentDetect(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  return require("../incidents").detectBursts({ programId });
}

function internalIncidentCreate(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  return require("../incidents").createIncident({
    programId,
    title: body.title,
    description: body.description || null,
    publicMessage: body.publicMessage || null,
    actorId: body.actorId || null,
  });
}

function internalIncidentAction(incidentId, body = {}) {
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId));
  if (!inc) return { error: "incident not found" };
  if (!ticketActorAllowed(inc.program_id, body.actorId || null)) {
    return { error: "actor is not a helper of this program" };
  }
  if (body.action === "link") return incidents.linkTicket({ incidentId: Number(incidentId), ticketId: Number(body.ticketId), actorId: body.actorId || null });
  if (body.action === "unlink") return incidents.unlinkTicket({ incidentId: Number(incidentId), ticketId: Number(body.ticketId) });
  if (body.action === "announcement") return incidents.draftAnnouncement({ incidentId: Number(incidentId) });
  if (body.action === "declare") {
    return incidents.declareIncident({
      incidentId: Number(incidentId),
      actorId: body.actorId || null,
      description: body.description || null,
      publicMessage: body.publicMessage || null,
    });
  }
  return incidents.setIncidentStatus({ incidentId: Number(incidentId), status: body.action, actorId: body.actorId || null });
}

// Affected-user notification is deliberately its own route rather than a
// generic incident action: it needs the live Slack client, sends real
// messages, and must never be reachable through the same code path as a
// status change.
async function internalIncidentNotify(incidentId, body = {}) {
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId));
  if (!inc) return { error: "incident not found" };
  if (!ticketActorAllowed(inc.program_id, body.actorId || null)) {
    return { error: "actor is not a helper of this program" };
  }
  if (!slackClient) return { error: "slack client unavailable" };
  return incidents.notifyAffectedUsers({
    incidentId: Number(incidentId),
    actorId: body.actorId || null,
    client: slackClient,
    resolutionMessage: body.resolutionMessage || null,
  });
}

function internalIncidentAffected(incidentId, query = {}) {
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId));
  if (!inc) return { error: "incident not found" };
  const reports = incidents.affectedReports(Number(incidentId), query.onlyUnnotified === "1");
  return { total: reports.length, unnotified: reports.filter((r) => !r.notified_at).length, reports };
}

/* -------------------------------------------------------- support radar -- */

function internalRadarList(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return { signals: require("../radar").listSignals(programId, { status: query.status || null, severity: query.severity || null, limit: query.limit }) };
}

function internalRadarEvaluate(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  return require("../radar").evaluateProgram(programId);
}

function internalRadarAction(signalId, body = {}) {
  const radar = require("../radar");
  const requireHelper = (programId, actorId) => ticketActorAllowed(programId, actorId);
  const actorId = body.actorId || null;
  if (body.action === "acknowledge") return radar.acknowledgeSignal({ id: Number(signalId), actorId, requireHelper });
  if (body.action === "resolve") return radar.resolveSignal({ id: Number(signalId), actorId, requireHelper });
  if (body.action === "suppress") return radar.suppressSignal({ id: Number(signalId), actorId, duration: body.duration, requireHelper });
  return { error: `unknown action ${body.action}` };
}

function internalHealthScore(programId) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../programHealth").computeHealthScore(programId);
}

function internalWaitEstimate(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../waitTime").estimate({ programId, category: query.category || null, ticketId: query.ticketId ? Number(query.ticketId) : null });
}

function internalAnalytics(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  return require("../supportAnalytics").overview(programId, days * 86400000);
}

function internalUsage(query = {}) {
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  return { days, rows: db.llmUsageSummary(days * 86400000) };
}

function internalProgramUsage(programId, query = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return db.llmUsageReport({
    programId,
    from: query.from,
    until: query.until,
    bucket: query.bucket || "day",
    operation: query.operation || null,
    limit: query.limit,
    offset: query.offset,
  });
}

function internalSlaCheck(programId) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../sla").checkProgram({ programId });
}

function internalRetentionPreview(programId) {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../retention").preview(programId);
}

function internalRetentionSweep(programId, body = {}) {
  const actorId = body.actorId || null;
  if (!programs.get(programId)) return { error: "unknown program" };
  const { isAdmin } = require("../config");
  // Destructive by design: Pixie admins always, otherwise only the program's
  // organizers/owners — never a plain helper, never cross-program.
  const organizer = db.listHelpers(programId).find((h) => h.user_id === actorId && (h.role === "organizer" || h.role === "owner"));
  if (!(actorId && (isAdmin(actorId) || organizer))) {
    return { error: "retention sweeps require a program organizer" };
  }
  if (!body.confirm) return { error: "confirm required" };
  return require("../retention").sweepProgram(programId, { dryRun: false });
}

function internalRetentionPolicy(programId, body = {}) {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const problem = require("../retention").validatePolicy(body.policy || {});
  if (problem) return { error: problem };
  const p = body.policy || {};
  const map = {
    contextDays: "retention_context_days",
    ticketsDays: "retention_tickets_days",
    notesDays: "retention_notes_days",
    tracesDays: "retention_traces_days",
    analyticsDays: "retention_analytics_days",
    auditDays: "retention_audit_days",
  };
  const row = {};
  for (const [key, col] of Object.entries(map)) {
    if (p[key] !== undefined) row[col] = Number(p[key]);
  }
  const cols = Object.entries(row);
  if (cols.length > 0) {
    db.handle().query(`UPDATE programs SET ${cols.map(([c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...cols.map(([, v]) => v), Date.now(), programId);
    programs.invalidate();
  }
  try {
    require("../audit").record({ programId, actorId: body.actorId || null, action: "retention.policy_updated", entityType: "program", entityId: programId });
  } catch (error) {
    log.warn("web/api", `retention audit write failed: ${error.message}`);
  }
  return { ok: true, policy: require("../retention").policyFor(programId) };
}

/* -------------------------------------------------------- slack lookup -- */

let slackChannelsCache = { at: 0, channels: [] };

// Slack identity resolution for the dashboard. Returns the public name
// variants and the avatar — display name, real name, username — plus the
// Slack id echoed back so a caller can key a map on it. Never email, never
// any other profile field. Cached per user for an hour (names change rarely
// and Slack's own rate limits matter far more than staleness); failures are
// cached briefly so a deleted/bot user is not re-looked-up on every render.
const userInfoCache = new Map(); // userId -> { at, ok, displayName, realName, username, avatarUrl }
const USER_INFO_TTL_MS = 60 * 60 * 1000;
const USER_INFO_MISS_TTL_MS = 5 * 60 * 1000;

function cachedUserInfo(userId) {
  const hit = userInfoCache.get(userId);
  if (!hit) return null;
  const ttl = hit.ok ? USER_INFO_TTL_MS : USER_INFO_MISS_TTL_MS;
  if (Date.now() - hit.at >= ttl) return null;
  return hit;
}

async function internalUserInfo(userId) {
  if (!userId) return { ok: false, reason: "user id required" };
  const cached = cachedUserInfo(userId);
  if (cached) {
    return cached.ok
      ? { ok: true, slackId: userId, displayName: cached.displayName, realName: cached.realName, username: cached.username, avatarUrl: cached.avatarUrl }
      : { ok: false, slackId: userId, reason: cached.reason };
  }
  const token = config.slack.botToken;
  if (!token && !slackClient) return { ok: false, slackId: userId, reason: "slack not connected" };
  try {
    const client = slackClient || new (require("@slack/web-api").WebClient)(token);
    const res = await client.users.info({ user: userId });
    const u = res.user || {};
    const profile = u.profile || {};
    const displayName = profile.display_name || profile.real_name || u.name || null;
    const realName = profile.real_name || u.real_name || null;
    const username = u.name || null;
    const avatarUrl = profile.image_192 || profile.image_72 || null;
    userInfoCache.set(userId, { at: Date.now(), ok: true, displayName, realName, username, avatarUrl });
    return { ok: true, slackId: userId, displayName, realName, username, avatarUrl };
  } catch (e) {
    // Deleted user, bot user with no profile, transient API failure — any
    // of these mean "show the id", never a thrown error the caller has to
    // handle specially. Cached briefly so a page full of a deleted user's
    // rows costs one failed lookup, not one per row.
    const reason = (e && e.message) || "lookup failed";
    userInfoCache.set(userId, { at: Date.now(), ok: false, reason });
    return { ok: false, slackId: userId, reason };
  }
}

// One round trip for a whole page's worth of ids. Dedupes, caps the fan-out,
// and leans on the per-user cache above — a warm dashboard resolves entirely
// from cache and never touches Slack. Returns a { [id]: {...}|null } map so a
// caller renders a name where there is one and the id where there is not.
const USER_INFO_BATCH_CAP = 200;

async function internalUserInfoBatch(userIds) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter((id) => typeof id === "string" && id))].slice(0, USER_INFO_BATCH_CAP);
  const users = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const info = await internalUserInfo(id);
        users[id] = info.ok
          ? { slackId: id, displayName: info.displayName, realName: info.realName, username: info.username, avatarUrl: info.avatarUrl }
          : null;
      } catch (_) {
        users[id] = null;
      }
    }),
  );
  return { users };
}

// One listing at a time: concurrent dashboard loads share the in-flight
// crawl instead of each paging the whole workspace into Slack's rate limit.
let slackChannelsInFlight = null;

function slackChannels() {
  if (!slackChannelsInFlight) {
    slackChannelsInFlight = fetchSlackChannels().finally(() => {
      slackChannelsInFlight = null;
    });
  }
  return slackChannelsInFlight;
}

async function fetchSlackChannels() {
  if (!config.slack.botToken) {
    return { ok: false, reason: "no SLACK_BOT_TOKEN in this environment", channels: [] };
  }

  // Cache for 5 minutes so opening the modal never hammers Slack.
  if (slackChannelsCache.channels.length && Date.now() - slackChannelsCache.at < 5 * 60 * 1000) {
    return { ok: true, channels: slackChannelsCache.channels };
  }

  try {
    const { WebClient } = require("@slack/web-api");
    const client = new WebClient(config.slack.botToken);
    const channels = [];
    let cursor;
    do {
      const res = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const ch of res.channels || []) {
        channels.push({ id: ch.id, name: ch.name, isMember: !!ch.is_member });
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    channels.sort((a, b) => a.name.localeCompare(b.name));
    slackChannelsCache = { at: Date.now(), channels };
    return { ok: true, channels };
  } catch (e) {
    return { ok: false, reason: e.message, channels: [] };
  }
}

// Whether the shared @Pixie can actually operate in a channel, for the
// hosted onboarding picker. Uses conversations.info (is_member reflects the
// caller) and falls back to a join attempt for public channels.
async function internalSlackMembership(channelId) {
  if (!channelId) return { ok: false, hasAccess: false, reason: "channel required" };
  const token = config.slack.botToken;
  if (!token && !slackClient) return { ok: false, hasAccess: false, reason: "slack not connected" };
  try {
    const client = slackClient || new (require("@slack/web-api").WebClient)(token);
    const info = await client.conversations.info({ channel: channelId });
    const ch = info.channel || {};
    return {
      ok: true,
      hasAccess: !!ch.is_member,
      name: ch.name || null,
      isPrivate: !!ch.is_private,
      isArchived: !!ch.is_archived,
    };
  } catch (e) {
    const code = e && (e.code || (e.data && e.data.error));
    if (code === "channel_not_found") return { ok: true, hasAccess: false, reason: "channel_not_found" };
    return { ok: false, hasAccess: false, reason: (e && e.message) || "lookup failed" };
  }
}

module.exports = {
  buildPulse,
  handleAsk,
  queueList,
  queueApprove,
  queueDrop,
  queueEdit,
  gapsList,
  gapsMove,
  gapsRejudge,
  silenceList,
  knowledgeInfo,
  knowledgeCorpus,
  knowledgeRefresh,
  cacheList,
  cacheBust,
  handleTeach,
  reportText,
  reportPost,
  setSlackClient,
  healthCheck,
  programsList,
  programSave,
  programRemove,
  programSetPosture,
  ticketsList,
  ticketUpdate,
  channelsList,
  channelToggle,
  channelAdd,
  channelRemove,
  slackChannels,
  internalSlackMembership,
  internalUserInfo,
  internalUserInfoBatch,
  internalAuth,
  ticketDetail,
  internalProgramSync,
  internalTestQuestion,
  testQuestionExpectedAction,
  sourceNamesFromContext,
  internalTicketSearch,
  internalTicketAction,
  internalTicketReply,
  internalTicketNote,
  internalHelpersSync,
  internalCopilot,
  internalKnowledgeCandidates,
  internalKnowledgeHealth,
  internalKnowledgePropose,
  internalKnowledgeCandidateAction,
  internalGapClusters,
  internalFaqPropose,
  internalMacrosList,
  internalMacroTemplates,
  internalMacroWaiting,
  internalMacroCreate,
  internalMacroUpdate,
  internalMacroDelete,
  internalMacroSend,
  internalMacroBulkSend,
  internalMacroSuggest,
  internalRoutingRecommend,
  internalHelperStats,
  internalLeaderboard,
  internalShadowRouting,
  internalDraftSync,
  internalRoutingExpertise,
  internalDuplicates,
  internalIncidents,
  internalIncidentDetail,
  internalIncidentDetect,
  internalIncidentCreate,
  internalIncidentAction,
  internalIncidentNotify,
  internalIncidentAffected,
  internalRadarList,
  internalRadarEvaluate,
  internalRadarAction,
  internalHealthScore,
  internalWaitEstimate,
  internalAnalytics,
  internalUsage,
  internalProgramUsage,
  internalSlaCheck,
  internalRetentionPreview,
  internalRetentionSweep,
  internalRetentionPolicy,
};
