const crypto = require("crypto");
const db = require("./db");
const log = require("./log");
const programs = require("./programs");
const programModel = require("./programModel");
const resolutionJudge = require("./resolutionJudge");
const jobLease = require("./jobLease");
const { config } = require("./config");

const RESOLUTION_CONFIDENCE = 0.8;
const DEBOUNCE_MS = 2 * 60 * 1000;
const STALE_QUIET_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const RECENT_CLAIM_MS = 10 * 60 * 1000;
// Jev's free lane is shared with live message classification, so the
// watcher must never starve it: a sweep judges only a few tickets, spaced
// out, and any rate limit pauses judging entirely for a while.
const SWEEP_MAX_JUDGEMENTS = 5;
const SWEEP_SPACING_MS = 20 * 1000;
const STARTUP_SWEEP_DELAY_MS = 10 * 60 * 1000;
const JEV_BACKOFF_MS = 15 * 60 * 1000;
const BACKOFF_ERRORS = new Set(["rate_limit", "quota"]);
const timers = new Map();
const backlog = [];
const backlogIds = new Set();
let backlogTimer = null;
let backlogRunning = false;
let backlogLastCallAt = 0;
const inFlight = new Map();
let sweepTimer = null;
let startupTimer = null;
let backoffUntil = 0;

function openStatus(status) {
  return ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened", "ai_answered"].includes(status);
}

function autoResolveEnabled(ticket, program) {
  return !!program && programModel.behaviorFor(program).help.autoResolve === true;
}

function parseDetail(event) {
  try { return JSON.parse(event.detail || "{}"); } catch (_) { return {}; }
}

function eventRoleMap(ticket) {
  const map = new Map();
  for (const event of db.listTicketEvents(ticket.id)) {
    if (event.event_type !== "helper_reply") continue;
    const detail = parseDetail(event);
    if (detail.ts) map.set(String(detail.ts), { role: "helper", userId: event.actor_id });
  }
  return map;
}

function slackRole(message, ticket, helperReplies) {
  const override = helperReplies.get(String(message.ts || ""));
  if (override) return override;
  const botId = config?.slack?.botUserId;
  if (message.bot_id || (botId && message.user === botId)) return { role: "pixie", userId: message.user || botId };
  if (message.user === ticket.requester_id) return { role: "requester", userId: message.user };
  if (message.user && db.isHelper(ticket.program_id, message.user)) return { role: "helper", userId: message.user };
  return { role: "other", userId: message.user || null };
}

function normalizeSlackMessages(messages, ticket) {
  const helperReplies = eventRoleMap(ticket);
  return (messages || [])
    .map((message) => {
      const who = slackRole(message, ticket, helperReplies);
      return { ts: message.ts || null, role: who.role, userId: who.userId, text: String(message.text || "").trim() };
    })
    .filter((message) => message.text);
}

function fallbackTranscript(ticket) {
  const rows = [{ ts: ticket.created_at, role: "requester", userId: ticket.requester_id, text: ticket.question }];
  for (const row of db.listTicketEvents(ticket.id)) {
    const detail = parseDetail(row);
    if (row.event_type === "helper_reply") rows.push({ ts: row.created_at, role: "helper", userId: row.actor_id, text: detail.text || "A helper replied in the thread." });
    if (row.event_type === "requester_followup") rows.push({ ts: row.created_at, role: "requester", userId: row.actor_id, text: detail.text || "The requester followed up." });
  }
  try {
    const context = require("./context").getThreadMessages(ticket.thread_ts, 40);
    for (const row of context) rows.push({ role: row.speaker === "pixie" ? "pixie" : "requester", text: row.text });
  } catch (_) {}
  return rows;
}

async function fetchTranscript(ticket, client) {
  if (client?.conversations?.replies) {
    try {
      const result = await client.conversations.replies({ channel: ticket.channel, ts: ticket.thread_ts, limit: 100 });
      return normalizeSlackMessages(result.messages, ticket);
    } catch (error) {
      log.debug("resolution", `thread fetch failed for #${ticket.id}: ${error.message}`);
    }
  }
  return fallbackTranscript(ticket);
}

function lastMessageKey(transcript) {
  const last = transcript.at(-1);
  if (!last) return "empty";
  return crypto.createHash("sha256").update(JSON.stringify([last.ts || null, last.role, last.text])).digest("hex");
}

function wasJudged(ticketId, messageKey) {
  return db.listTicketEvents(ticketId).some((event) => event.event_type === "resolution_judged" && parseDetail(event).messageKey === messageKey);
}

function recordJudgement(ticket, messageKey, decision) {
  db.addTicketEvent({
    ticketId: ticket.id,
    programId: ticket.program_id,
    eventType: "resolution_judged",
    detail: { messageKey, verdict: decision.verdict, confidence: decision.confidence ?? null },
  });
}

function hasAnswer(transcript) {
  let pixieAnswered = false;
  for (const message of transcript) {
    if (message.role === "helper") return true;
    if (message.role === "pixie") pixieAnswered = true;
    if (pixieAnswered && message.role === "requester") return true;
  }
  return false;
}

function recentClaimWithoutReply(ticket, now) {
  if (!ticket.claimed_at || now - ticket.claimed_at >= RECENT_CLAIM_MS) return false;
  return !db.listTicketEvents(ticket.id).some((event) => event.event_type === "helper_reply" && event.created_at >= ticket.claimed_at);
}

async function judgeTicketOnce(ticketId, { client = null, program = null, now = Date.now(), judge = resolutionJudge.judgeResolution } = {}) {
  let ticket = db.getTicket(ticketId);
  const prog = program || (ticket && programs.get(ticket.program_id));
  if (!ticket || !openStatus(ticket.status) || !autoResolveEnabled(ticket, prog)) return { skipped: true };
  if (Date.now() < backoffUntil) return { skipped: true, reason: "backoff" };
  const transcript = await fetchTranscript(ticket, client);
  const messageKey = lastMessageKey(transcript);
  if (wasJudged(ticket.id, messageKey)) return { skipped: true, reason: "already_judged" };
  if (!hasAnswer(transcript)) {
    recordJudgement(ticket, messageKey, { verdict: "no_answer" });
    return { skipped: true, reason: "no_answer" };
  }
  if (recentClaimWithoutReply(ticket, now)) {
    recordJudgement(ticket, messageKey, { verdict: "recent_claim" });
    return { skipped: true, reason: "recent_claim" };
  }
  let decision;
  try {
    decision = await judge({ ticket, transcript });
  } catch (_) {
    decision = { verdict: "unknown" };
  }
  if (decision.verdict === "unknown" && BACKOFF_ERRORS.has(decision.errorKind)) {
    // Not recorded as judged, so a later sweep retries this ticket.
    backoffUntil = Date.now() + JEV_BACKOFF_MS;
    log.warn("resolution", `jev ${decision.errorKind}; pausing auto-resolve judgements for ${JEV_BACKOFF_MS / 60000} min`);
    return { decision, skipped: true, reason: "backoff" };
  }
  recordJudgement(ticket, messageKey, decision);
  if (decision.verdict !== "resolved" || decision.confidence < RESOLUTION_CONFIDENCE) return { decision };
  ticket = db.getTicket(ticket.id);
  if (!ticket || !openStatus(ticket.status) || recentClaimWithoutReply(ticket, now)) return { skipped: true, reason: "ticket_changed" };
  const tickets = require("./tickets");
  const workerId = tickets.resolveTicketWorker(ticket, null);
  const reason = String(decision.reason || "Jev found clear evidence that the issue was solved.").replace(/\s+/g, " ").trim().slice(0, 160);
  const result = tickets.resolveTicket({
    ticketId: ticket.id,
    actorId: workerId || null,
    resolution: `auto-resolved: ${reason}`,
    source: "auto",
    resolutionMeta: { verdict: decision.verdict, confidence: decision.confidence, reason },
    programId: ticket.program_id,
    workspaceId: ticket.workspace_id,
    client,
    program: prog,
  });
  return { decision, result };
}

function judgeTicket(ticketId, options = {}) {
  const key = String(ticketId);
  if (inFlight.has(key)) return inFlight.get(key);
  const run = judgeTicketOnce(ticketId, options).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

function schedule({ ticketId, client = null, program = null, delayMs = DEBOUNCE_MS, judge = resolutionJudge.judgeResolution } = {}) {
  if (!ticketId) return null;
  const prior = timers.get(String(ticketId));
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    timers.delete(String(ticketId));
    void judgeTicket(ticketId, { client, program, judge }).catch((error) => log.warn("resolution", `judgement failed for #${ticketId}: ${error.message}`));
  }, delayMs);
  if (timer.unref) timer.unref();
  timers.set(String(ticketId), timer);
  return timer;
}

function enqueueForJudge({ ticketId, client = null, program = null, judge = resolutionJudge.judgeResolution, autoStart = true } = {}) {
  const key = String(ticketId || "");
  if (!key || backlogIds.has(key)) return false;
  backlogIds.add(key);
  backlog.push({ ticketId, client, program, judge });
  if (autoStart) void drainBacklog();
  return true;
}

async function drainBacklog({ now = Date.now(), spacingMs = SWEEP_SPACING_MS } = {}) {
  if (backlogRunning || backlog.length === 0) return { judged: 0, queued: backlog.length };
  if (now < backoffUntil) {
    if (!backlogTimer) {
      backlogTimer = setTimeout(() => {
        backlogTimer = null;
        void drainBacklog({ spacingMs }).catch((error) => log.warn("resolution", `backlog drain failed: ${error.message}`));
      }, Math.max(1, backoffUntil - now));
      if (backlogTimer.unref) backlogTimer.unref();
    }
    return { judged: 0, queued: backlog.length, reason: "backoff" };
  }
  const elapsed = now - backlogLastCallAt;
  if (backlogLastCallAt && elapsed < spacingMs) {
    if (!backlogTimer) {
      backlogTimer = setTimeout(() => {
        backlogTimer = null;
        void drainBacklog({ spacingMs }).catch((error) => log.warn("resolution", `backlog drain failed: ${error.message}`));
      }, spacingMs - elapsed);
      if (backlogTimer.unref) backlogTimer.unref();
    }
    return { judged: 0, queued: backlog.length, reason: "spacing" };
  }
  const item = backlog.shift();
  backlogIds.delete(String(item.ticketId));
  backlogRunning = true;
  backlogLastCallAt = now;
  try {
    const result = await judgeTicket(item.ticketId, { client: item.client, program: item.program, judge: item.judge });
    return { judged: result?.decision ? 1 : 0, queued: backlog.length, result };
  } finally {
    backlogRunning = false;
    if (backlog.length > 0 && !backlogTimer) {
      backlogTimer = setTimeout(() => {
        backlogTimer = null;
        void drainBacklog({ spacingMs }).catch((error) => log.warn("resolution", `backlog drain failed: ${error.message}`));
      }, spacingMs);
      if (backlogTimer.unref) backlogTimer.unref();
    }
  }
}

function ticketActivityAt(ticket) {
  const events = db.listTicketEvents(ticket.id);
  return Math.max(Number(ticket.updated_at) || 0, ...events.map((event) => Number(event.created_at) || 0));
}

async function sweepStale({
  client = null,
  now = Date.now(),
  quietMs = STALE_QUIET_MS,
  useLease = true,
  judge = resolutionJudge.judgeResolution,
  maxJudgements = SWEEP_MAX_JUDGEMENTS,
  spacingMs = SWEEP_SPACING_MS,
} = {}) {
  const run = async () => {
    const seen = new Set();
    let judged = 0;
    let jevCalls = 0;
    for (const program of programs.all()) {
      for (const ticket of db.getTicketsForProgram(program.id)) {
        if (jevCalls >= maxJudgements || Date.now() < backoffUntil) return { judged };
        if (seen.has(ticket.id) || !openStatus(ticket.status) || now - ticketActivityAt(ticket) < quietMs) continue;
        seen.add(ticket.id);
        if (jevCalls > 0 && spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
        const result = await judgeTicket(ticket.id, { client, program, now, judge });
        if (result.decision) jevCalls += 1;
        if (!result.skipped || result.reason === "no_answer" || result.reason === "recent_claim") judged += 1;
      }
    }
    return { judged };
  };
  if (!useLease) return run();
  return (await jobLease.runOnce("ticket-resolution-sweep", 25 * 60 * 1000, run)).result || { judged: 0 };
}

function start(client, { intervalMs = SWEEP_INTERVAL_MS } = {}) {
  if (sweepTimer) return sweepTimer;
  // Delayed so a deploy never bursts Jev while Slack traffic is catching up.
  startupTimer = setTimeout(() => {
    void sweepStale({ client }).catch((error) => log.warn("resolution", `startup sweep failed: ${error.message}`));
  }, STARTUP_SWEEP_DELAY_MS);
  if (startupTimer.unref) startupTimer.unref();
  sweepTimer = setInterval(() => {
    void sweepStale({ client }).catch((error) => log.warn("resolution", `stale sweep failed: ${error.message}`));
  }, intervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function stop() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (startupTimer) clearTimeout(startupTimer);
  sweepTimer = null;
  startupTimer = null;
  backoffUntil = 0;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  inFlight.clear();
  if (backlogTimer) clearTimeout(backlogTimer);
  backlogTimer = null;
  backlogRunning = false;
  backlog.length = 0;
  backlogIds.clear();
  backlogLastCallAt = 0;
}

module.exports = { schedule, judgeTicket, sweepStale, start, stop, hasAnswer, enqueueForJudge, drainBacklog, RESOLUTION_CONFIDENCE, DEBOUNCE_MS, STALE_QUIET_MS, SWEEP_SPACING_MS, JEV_BACKOFF_MS };
