import crypto = require("crypto");
import db = require("./db");
import log = require("./log");
import programs = require("./programs");
import programModel = require("./programModel");
import resolutionJudge = require("./resolutionJudge");
import jobLease = require("./jobLease");
import lastWord = require("./lastWord");
import configModule = require("./config");

type Row = Record<string, any>;
const { config } = configModule;

interface TranscriptRow {
  ts?: string | number | null;
  role: string;
  userId?: string | null;
  text: string;
}

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
// Each ticket a sweep examines costs one conversations.replies call, shared
// with live Pixie: pace them and cap how many one sweep looks at.
const SWEEP_MAX_EXAMINED = 40;
const SWEEP_EXAMINE_SPACING_MS = 3000;
const BACKOFF_ERRORS = new Set(["rate_limit", "quota"]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const backlog: Array<{ ticketId: number; client: Row | null; program: Row | null; judge: (args: Row) => Promise<Row> }> = [];
const backlogIds = new Set<string>();
let backlogTimer: ReturnType<typeof setTimeout> | null = null;
let backlogRunning = false;
let backlogLastCallAt = 0;
const inFlight = new Map<string, Promise<Row>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let backoffUntil = 0;

function openStatus(status: unknown): boolean {
  return typeof status === "string" && ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened", "ai_answered"].includes(status);
}

function autoResolveEnabled(ticket: Row, program: Row | null): boolean {
  const behavior = program ? programModel.behaviorFor(program) as unknown as Row : null;
  return !!behavior && behavior.help?.autoResolve === true;
}

function parseDetail(event: Row): Row {
  try { return JSON.parse(event.detail || "{}"); } catch (_) { return {}; }
}

function eventRoleMap(ticket: Row): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const event of db.listTicketEvents(ticket.id) as Row[]) {
    if (event.event_type !== "helper_reply") continue;
    const detail = parseDetail(event);
    if (detail.ts) map.set(String(detail.ts), { role: "helper", userId: event.actor_id });
  }
  return map;
}

function slackRole(message: Row, ticket: Row, helperReplies: Map<string, Row>): Row {
  const override = helperReplies.get(String(message.ts || ""));
  if (override) return override;
  const botId = config?.slack?.botUserId;
  if (message.bot_id || (botId && message.user === botId)) return { role: "pixie", userId: message.user || botId };
  if (message.user === ticket.requester_id) return { role: "requester", userId: message.user };
  if (message.user && db.isHelper(ticket.program_id, message.user)) return { role: "helper", userId: message.user };
  return { role: "other", userId: message.user || null };
}

function normalizeSlackMessages(messages: Row[], ticket: Row): TranscriptRow[] {
  const helperReplies = eventRoleMap(ticket);
  return (messages || [])
    .map((message: Row): TranscriptRow => {
      const who = slackRole(message, ticket, helperReplies);
      return { ts: message.ts || null, role: who.role, userId: who.userId, text: String(message.text || "").trim() };
    })
    .filter((message) => Boolean(message.text));
}

function fallbackTranscript(ticket: Row): TranscriptRow[] {
  const rows: TranscriptRow[] = [{ ts: ticket.created_at, role: "requester", userId: ticket.requester_id, text: ticket.question }];
  for (const row of db.listTicketEvents(ticket.id) as Row[]) {
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

async function fetchTranscript(ticket: Row, client: Row | null): Promise<TranscriptRow[]> {
  if (client?.conversations?.replies) {
    try {
      const result = await client.conversations.replies({ channel: ticket.channel, ts: ticket.thread_ts, limit: 100 });
      return normalizeSlackMessages(result.messages, ticket);
    } catch (error: any) {
      log.debug("resolution", `thread fetch failed for #${ticket.id}: ${error.message}`);
    }
  }
  return fallbackTranscript(ticket);
}

function lastMessageKey(transcript: TranscriptRow[]): string {
  const last = transcript.at(-1);
  if (!last) return "empty";
  return crypto.createHash("sha256").update(JSON.stringify([last.ts || null, last.role, last.text])).digest("hex");
}

function wasJudged(ticketId: number, messageKey: string): boolean {
  return (db.listTicketEvents(ticketId) as Row[]).some((event: Row) => event.event_type === "resolution_judged" && parseDetail(event).messageKey === messageKey);
}

function recordJudgement(ticket: Row, messageKey: string, decision: Row): void {
  const addTicketEvent = db.addTicketEvent as unknown as (event: Record<string, unknown>) => unknown;
  addTicketEvent({
    ticketId: ticket.id,
    programId: ticket.program_id,
    eventType: "resolution_judged",
    detail: { messageKey, verdict: decision.verdict, confidence: decision.confidence ?? null },
  });
}

function hasAnswer(transcript: TranscriptRow[]): boolean {
  let pixieAnswered = false;
  for (const message of transcript) {
    if (message.role === "helper") return true;
    if (message.role === "pixie") pixieAnswered = true;
    if (pixieAnswered && message.role === "requester") return true;
  }
  return false;
}

function recentClaimWithoutReply(ticket: Row, now: number): boolean {
  if (!ticket.claimed_at || now - ticket.claimed_at >= RECENT_CLAIM_MS) return false;
  return !(db.listTicketEvents(ticket.id) as Row[]).some((event: Row) => event.event_type === "helper_reply" && event.created_at >= ticket.claimed_at);
}

// When the conversation actually ended: Slack ts strings are seconds, stored
// event fallbacks are already ms.
function lastMessageAt(transcript: TranscriptRow[]): number | null {
  let latest = null;
  for (const row of transcript) {
    const raw = Number(row?.ts);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const ms = raw < 1e11 ? Math.round(raw * 1000) : raw;
    latest = latest === null ? ms : Math.max(latest, ms);
  }
  return latest;
}

// `historical` marks the backlog lane (old tickets from the history import or
// the stale backlog): the resolve is dated to the thread's last message and
// skips the Slack card update and the summary/learning pipeline, exactly like
// a backfill resolve.
async function judgeTicketOnce(ticketId: number, { client = null, program = null, now = Date.now(), judge = resolutionJudge.judgeResolution, historical = false }: { client?: Row | null; program?: Row | null; now?: number; judge?: (args: Row) => Promise<Row>; historical?: boolean } = {}): Promise<Row> {
  let ticket = db.getTicket(ticketId);
  const prog = program || (ticket && programs.get(ticket.program_id));
  if (!ticket || !openStatus(ticket.status) || !autoResolveEnabled(ticket, prog)) return { skipped: true };
  if (Date.now() < backoffUntil) return { skipped: true, reason: "backoff" };
  const transcript = await fetchTranscript(ticket, client);
  // The owner's rule comes first and needs no Jev call: a helper had the
  // last word and the requester stayed quiet for 2+ days.
  const helperLast = lastWord.helperLastWord({
    programId: ticket.program_id,
    requesterId: ticket.requester_id,
    threadTs: ticket.thread_ts,
    rows: transcript.map((row) => ({ ts: row.ts, userId: row.userId, isBot: row.role === "pixie" })),
    now,
  });
  if (helperLast) {
    const tickets = require("./tickets");
    const result = tickets.resolveTicket({
      ticketId: ticket.id,
      actorId: null,
      creditId: helperLast.helperId,
      resolution: "resolved: a helper had the last word and the requester didn't come back",
      source: historical ? "backfill" : "auto",
      resolutionMeta: { rule: "last_word", helper: helperLast.helperId },
      resolvedAt: helperLast.at,
      programId: ticket.program_id,
      workspaceId: ticket.workspace_id,
      client,
      program: prog,
    });
    return { lastWord: helperLast, result };
  }
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
  let decision: Row;
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
  const reason = String(decision.reason || "Jev found clear evidence that the issue was solved.").replace(/\s+/g, " ").trim().slice(0, 160);
  const result = tickets.resolveTicket({
    ticketId: ticket.id,
    // A system resolve: Pixie is the actor, and finishResolve credits the
    // helper who did the work (former helpers included). Passing that helper
    // as the actor would fail authorization once they're no longer active.
    actorId: null,
    resolution: `auto-resolved: ${reason}`,
    source: historical ? "backfill" : "auto",
    resolutionMeta: { verdict: decision.verdict, confidence: decision.confidence, reason, ...(historical ? { lane: "backlog" } : {}) },
    resolvedAt: lastMessageAt(transcript),
    programId: ticket.program_id,
    workspaceId: ticket.workspace_id,
    client,
    program: prog,
  });
  return { decision, result };
}

function judgeTicket(ticketId: number, options: Row = {}): Promise<Row> {
  const key = String(ticketId);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = judgeTicketOnce(ticketId, options).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

function schedule({ ticketId, client = null, program = null, delayMs = DEBOUNCE_MS, judge = resolutionJudge.judgeResolution }: { ticketId?: number; client?: Row | null; program?: Row | null; delayMs?: number; judge?: (args: Row) => Promise<Row> } = {}): ReturnType<typeof setTimeout> | null {
  if (!ticketId) return null;
  const prior = timers.get(String(ticketId));
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    timers.delete(String(ticketId));
    void judgeTicket(ticketId, { client, program, judge }).catch((error: any) => log.warn("resolution", `judgement failed for #${ticketId}: ${error.message}`));
  }, delayMs);
  if (timer.unref) timer.unref();
  timers.set(String(ticketId), timer);
  return timer;
}

function enqueueForJudge({ ticketId, client = null, program = null, judge = resolutionJudge.judgeResolution, autoStart = true }: { ticketId: number; client?: Row | null; program?: Row | null; judge?: (args: Row) => Promise<Row>; autoStart?: boolean }): boolean {
  const key = String(ticketId || "");
  if (!key || backlogIds.has(key)) return false;
  backlogIds.add(key);
  backlog.push({ ticketId, client, program, judge });
  if (autoStart) void drainBacklog();
  return true;
}

async function drainBacklog({ now = Date.now(), spacingMs = SWEEP_SPACING_MS }: { now?: number; spacingMs?: number } = {}): Promise<Row> {
  if (backlogRunning || backlog.length === 0) return { judged: 0, queued: backlog.length };
  if (now < backoffUntil) {
    if (!backlogTimer) {
      backlogTimer = setTimeout(() => {
        backlogTimer = null;
        void drainBacklog({ spacingMs }).catch((error: any) => log.warn("resolution", `backlog drain failed: ${error.message}`));
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
        void drainBacklog({ spacingMs }).catch((error: any) => log.warn("resolution", `backlog drain failed: ${error.message}`));
      }, spacingMs - elapsed);
      if (backlogTimer.unref) backlogTimer.unref();
    }
    return { judged: 0, queued: backlog.length, reason: "spacing" };
  }
  const item = backlog.shift();
  if (!item) return { judged: 0, queued: 0 };
  backlogIds.delete(String(item.ticketId));
  backlogRunning = true;
  backlogLastCallAt = now;
  try {
    const result = await judgeTicket(item.ticketId, { client: item.client, program: item.program, judge: item.judge, historical: true });
    return { judged: result?.decision ? 1 : 0, queued: backlog.length, result };
  } finally {
    backlogRunning = false;
    if (backlog.length > 0 && !backlogTimer) {
      backlogTimer = setTimeout(() => {
        backlogTimer = null;
      void drainBacklog({ spacingMs }).catch((error: any) => log.warn("resolution", `backlog drain failed: ${error.message}`));
      }, spacingMs);
      if (backlogTimer.unref) backlogTimer.unref();
    }
  }
}

function ticketActivityAt(ticket: Row): number {
  const events = db.listTicketEvents(ticket.id) as Row[];
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
  maxExamined = SWEEP_MAX_EXAMINED,
  examineSpacingMs = SWEEP_EXAMINE_SPACING_MS,
}: { client?: Row | null; now?: number; quietMs?: number; useLease?: boolean; judge?: (args: Row) => Promise<Row>; maxJudgements?: number; spacingMs?: number; maxExamined?: number; examineSpacingMs?: number } = {}): Promise<Row> {
  const run = async () => {
    const seen = new Set();
    let judged = 0;
    let jevCalls = 0;
    let examined = 0;
    for (const program of programs.all()) {
      for (const ticket of db.getTicketsForProgram(program.id)) {
        if (jevCalls >= maxJudgements || Date.now() < backoffUntil) return { judged };
        if (seen.has(ticket.id) || !openStatus(ticket.status) || now - ticketActivityAt(ticket) < quietMs) continue;
        seen.add(ticket.id);
        if (examined >= maxExamined) return { judged };
        if (examined > 0 && examineSpacingMs > 0) await new Promise((resolve) => setTimeout(resolve, examineSpacingMs));
        if (jevCalls > 0 && spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
        examined += 1;
        const result = await judgeTicket(ticket.id, { client, program, now, judge });
        if (result.lastWord) judged += 1;
        if (result.decision) jevCalls += 1;
        if (!result.skipped || result.reason === "no_answer" || result.reason === "recent_claim") judged += 1;
      }
    }
    return { judged };
  };
  if (!useLease) return run();
  return (await jobLease.runOnce("ticket-resolution-sweep", 25 * 60 * 1000, run)).result || { judged: 0 };
}

function start(client: Row, { intervalMs = SWEEP_INTERVAL_MS }: { intervalMs?: number } = {}): ReturnType<typeof setInterval> {
  if (sweepTimer) return sweepTimer;
  // Delayed so a deploy never bursts Jev while Slack traffic is catching up.
  startupTimer = setTimeout(() => {
    void sweepStale({ client }).catch((error: any) => log.warn("resolution", `startup sweep failed: ${error.message}`));
  }, STARTUP_SWEEP_DELAY_MS);
  if (startupTimer.unref) startupTimer.unref();
  sweepTimer = setInterval(() => {
    void sweepStale({ client }).catch((error: any) => log.warn("resolution", `stale sweep failed: ${error.message}`));
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

export = { schedule, judgeTicket, sweepStale, start, stop, hasAnswer, enqueueForJudge, drainBacklog, RESOLUTION_CONFIDENCE, DEBOUNCE_MS, STALE_QUIET_MS, SWEEP_SPACING_MS, JEV_BACKOFF_MS };
