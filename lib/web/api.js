// Web API handlers. Pure assembly: every write maps to an existing lib/
// function, every read is a DB query. No business logic lives here.
const db = require("../db");
const cache = require("../cache");
const learn = require("../learn");
const knowledge = require("../knowledge");
const report = require("../report");
const programs = require("../programs");
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
  learn.forget(id);
  learn.teach({ question, answer, authorId: null });
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
    url: s.url,
  }));

  const corpus = knowledge.getCorpus();
  const index = knowledge.getIndex();

  return {
    sources,
    corpusLength: corpus.length,
    chunkCount: index.docs.length,
    lastBuilt: knowledge.lastBuiltAt?.toISOString() || null,
    lastBuiltRelative: relativeTime(knowledge.lastBuiltAt?.getTime()),
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
  await knowledge.refreshCorpus(true);
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

function handleTeach(question, answer, authorId) {
  if (!question || !answer) return false;
  return learn.teach({ question, answer, authorId });
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

function ticketUpdate(id, status, assigneeId = null) {
  if (status === "claimed") {
    db.claimTicket(id, assigneeId || "admin");
  } else if (status === "unclaim") {
    db.unclaimTicket(id);
  } else if (status === "resolved") {
    db.resolveTicket(id, "resolved via admin dashboard");
  } else if (status === "reopen") {
    db.reopenTicket(id);
  } else if (status === "closed") {
    db.closeTicket(id);
  }
  return { ok: true, ticket: db.getTicket(id) };
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
    } catch (_) {}
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
  const { isAdmin } = require("../config");
  if (actorId && isAdmin(actorId)) return true;
  if (programId && actorId && db.isHelper(programId, actorId)) return true;
  return false;
}

function ticketDetail(id) {
  const ticket = db.getTicket(id);
  if (!ticket) return null;
  return {
    ticket,
    events: db.listTicketEvents(id),
    notes: db.listTicketNotes(id),
  };
}

// Upsert from the control plane. Channel claims go through the atomic claim
// path: a conflicting help channel fails the whole sync rather than stealing
// the channel, and double-submit Activate collapses onto the existing row.
function internalProgramSync(id, body = {}) {
  if (!id || !/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(id)) {
    return { error: "invalid program id (lowercase slug, 3-62 chars)" };
  }
  const { programChannels = [], ...fields } = body;
  if (!fields.name) return { error: "name is required" };

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
  programs.saveProgram(merged);

  if (channels.length > 0) {
    const claim = routing.claimChannelsForProgram({
      workspaceId,
      programId: id,
      channels,
      claimedBy: body.claimedBy || null,
    });
    if (!claim.ok) {
      return { error: `channel ${claim.conflictChannel} is already owned by program ${claim.ownerProgramId}` };
    }
  }

  // Bootstrap authorization (amendment 4): the verified creator becomes the
  // first organizer helper at claim time, so later actor checks have a
  // membership to consult instead of an empty table that fails open.
  if (body.claimedBy) {
    try {
      db.syncHelper({ programId: id, userId: body.claimedBy, source: "creator", role: "organizer" });
    } catch (_) {}
  }

  try {
    require("../audit").record({
      programId: id,
      actorId: body.claimedBy || null,
      action: existing ? "program.updated" : "program.created",
      entityType: "program",
      entityId: id,
    });
  } catch (_) {}
  try { require("../knowledge").invalidate(); } catch (_) {}
  return { ok: true, program: programs.get(id) };
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

// All mutations verify tenant match + actor membership before touching state.
function internalTicketAction(id, action, body = {}) {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }

  const tickets = require("../tickets");
  const detail = { actor: actorId };
  switch (action) {
    case "claim":
      if (!db.claimTicket(id, actorId)) return { error: "ticket is not open" };
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "claimed" });
      break;
    case "assign":
      if (!body.assigneeId) return { error: "assigneeId required" };
      if (!db.assignTicket(id, body.assigneeId)) return { error: "ticket is not assignable" };
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "assigned", detail: { to: body.assigneeId } });
      break;
    case "unclaim":
      db.unclaimTicket(id);
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "unclaimed" });
      break;
    case "resolve":
      db.resolveTicket(id, body.resolution || `resolved by <@${actorId}>`, actorId);
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "resolved" });
      break;
    case "reopen":
      db.reopenTicket(id);
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "reopened" });
      break;
    case "close":
      db.closeTicket(id);
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "closed" });
      break;
    case "snooze":
      if (!body.until) return { error: "until required" };
      db.snoozeTicket(id, Number(body.until));
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "snoozed", detail: { until: body.until } });
      break;
    case "duplicate":
      if (!body.canonicalId) return { error: "canonicalId required" };
      db.markDuplicateTicket(id, Number(body.canonicalId));
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "duplicate", detail: { of: body.canonicalId } });
      break;
    case "escalate":
      db.escalateTicketStatus(id);
      db.addTicketEvent({ ticketId: id, programId: ticket.program_id, actorId, eventType: "escalated" });
      break;
    default:
      return { error: `unknown action ${action}` };
  }
  try {
    require("../audit").record({
      programId: ticket.program_id, actorId, action: `ticket.${action}`, entityType: "ticket", entityId: id, metadata: detail,
    });
  } catch (_) {}
  return { ok: true, ticket: ticketDetail(id) };
}

async function internalTicketReply(id, body = {}) {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  if (!slackClient) return { error: "slack client unavailable" };
  const tickets = require("../tickets");
  return tickets.replyToTicket({ ticketId: id, authorId: actorId, text: body.text, client: slackClient });
}

function internalTicketNote(id, body = {}) {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const tickets = require("../tickets");
  return tickets.addInternalNote({ ticketId: id, authorId: actorId, body: body.body });
}

// Helper reconciliation from the control plane: the provided set becomes the
// non-manual membership, so removals propagate instead of going stale.
function internalHelpersSync(programId, body = {}) {
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
  if (body.reconcile) {
    for (const row of db.listHelpers(programId)) {
      if (row.helper_source === source && !seen.has(row.user_id)) {
        db.removeHelper({ programId, userId: row.user_id });
      }
    }
  }
  return { ok: true, helpers: db.listHelpers(programId) };
}

/* -------------------------------------------------------- slack lookup -- */

let slackChannelsCache = { at: 0, channels: [] };

async function slackChannels() {
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
  internalAuth,
  ticketDetail,
  internalProgramSync,
  internalTicketSearch,
  internalTicketAction,
  internalTicketReply,
  internalTicketNote,
  internalHelpersSync,
};
