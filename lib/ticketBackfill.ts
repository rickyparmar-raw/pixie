import db = require("./db");
import log = require("./log");
import programs = require("./programs");
import tickets = require("./tickets");
import jobLease = require("./jobLease");
import resolutionWatcher = require("./resolutionWatcher");
import lastWord = require("./lastWord");
import configModule = require("./config");
import type { Program } from "./types";

interface AnyRow {
  id?: number;
  program_id?: string;
  workspace_id?: string | null;
  workspaceId?: string | null;
  status?: string;
  cursor?: string | null;
  newest_ts_done?: string | null;
  rulesVersion?: number;
  messagesScanned?: number;
  ticketsCreated?: number;
  ticketsEnriched?: number;
  resolved?: number;
  closed?: number;
  queuedForJudge?: number;
  messages_scanned?: number;
  tickets_created?: number;
  tickets_enriched?: number;
  queued_for_judge?: number;
  completedAt?: number | null;
  last_error?: string | null;
  detail?: unknown;
  ts?: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  bot_id?: string;
  reactions?: Array<{ name?: string; users?: string[] }>;
  event_type?: string;
  category?: string | null;
  supportActive?: boolean;
  helpChannel?: string | null;
  channels?: unknown[];
  user_id?: string;
  channelId?: string;
  channel_id?: string;
  kind?: string;
  retryAfter?: number;
  retry_after?: number;
  headers?: Record<string, unknown>;
  code?: string | number;
  error?: string;
  data?: { retryAfter?: number; retry_after?: number; error?: string };
  ok?: boolean;
  response_metadata?: { next_cursor?: string };
  metadata?: { next_cursor?: string };
  messages?: AnyRow[];
  visibility?: unknown;
  question?: string;
  requester_id?: string;
  assigned_at?: number;
  started_at?: number;
  rules_version?: number;
  newestTsDone?: string | null;
  sleepFn?: (ms: number) => Promise<void>;
  spacingMs?: number;
  now?: () => number;
  throttle?: SlackThrottle;
  client?: SlackClientLike;
  judge?: (args: Record<string, unknown>) => Promise<unknown>;
  autoStartJudge?: boolean;
  [key: string]: unknown;
}

interface SlackClientLike {
  conversations: {
    history: (args: Record<string, unknown>) => Promise<AnyRow>;
    replies: (args: Record<string, unknown>) => Promise<AnyRow>;
  };
}

interface ImportOptions extends AnyRow {
  now?: () => number;
  throttle?: SlackThrottle;
  client?: SlackClientLike;
  judge?: (args: Record<string, unknown>) => Promise<unknown>;
  autoStartJudge?: boolean;
}

interface ProgressRow extends AnyRow {
  program_id: string;
  channel_id: string;
  status: string;
}
const { config } = configModule;

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
  return String(error);
}

function errorRow(error: unknown): AnyRow {
  return error && typeof error === "object" ? error as AnyRow : {};
}
const upsertProgress = db.upsertHistoryImportProgress as unknown as (programId: string, channelId: string, patch: AnyRow) => AnyRow;
const ensureSupportTicket = tickets.ensureSupportTicket as unknown as (options: AnyRow) => Promise<AnyRow | null>;
const getImportProgress = db.getHistoryImportProgress as unknown as (programId: string, channelId: string) => AnyRow | null;

const RULES_VERSION = 3;

const MIN_INTERVAL_MS = Number(process.env.PIXIE_HISTORY_IMPORT_SPACING_MS) || 1200;
const BACKOFF_INTERVAL_MS = 3000;
const QUIET_CLOSE_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const LEASE_TTL_MS = 30 * 60 * 1000;
const CHECKMARKS = new Set(["white_check_mark", "heavy_check_mark", "✅"]);
const CONFIRMATION = /\b(?:thanks?(?:\s+so\s+much)?[,.!]?\s+(?:that|it)\s+worked|that\s+worked|solved|fixed|got\s+it|nvm\s+figured\s+it\s+out|never\s*mind\s*,?\s+i\s+figured\s+it\s+out)\b/i;
const inFlight = new Map();
let startupTimer: ReturnType<typeof setTimeout> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tsMs(ts: unknown, fallback = Date.now()): number {
  const value = Number(ts);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : fallback;
}

function retryAfterMs(error: AnyRow): number | null {
  const data = error?.data || {};
  const raw = error?.retryAfter ?? error?.retry_after ?? data.retryAfter ?? data.retry_after
    ?? error?.headers?.["retry-after"] ?? error?.headers?.["Retry-After"];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

function isRateLimited(error: AnyRow): boolean {
  const code = error?.code || error?.data?.error || error?.error;
  return code === "ratelimited" || code === "rate_limited" || code === "rate_limit" || code === 429;
}

class SlackThrottle {
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private spacingMs: number;
  private lastCallAt: number | null;

  constructor({ sleepFn = sleep, now = Date.now, spacingMs = MIN_INTERVAL_MS }: { sleepFn?: (ms: number) => Promise<void>; now?: () => number; spacingMs?: number } = {}) {
    this.sleep = sleepFn;
    this.now = now;
    this.spacingMs = spacingMs;
    this.lastCallAt = null;
  }

  async call(fn: () => Promise<AnyRow>): Promise<AnyRow> {
    while (true) {
      if (this.lastCallAt !== null) {
        const wait = this.spacingMs - (this.now() - this.lastCallAt);
        if (wait > 0) await this.sleep(wait);
      }
      this.lastCallAt = this.now();
      try {
        const result = await fn();
        if (result && result.ok === false && isRateLimited(result)) throw result;
        return result;
      } catch (error: unknown) {
        if (!isRateLimited(errorRow(error))) throw error;
        if (this.spacingMs > 0) this.spacingMs = Math.max(this.spacingMs, BACKOFF_INTERVAL_MS);
        const retry = retryAfterMs(errorRow(error));
        await this.sleep(Math.max(this.spacingMs, retry === null ? this.spacingMs : retry));
      }
    }
  }
}

function channelIdOf(channel: unknown): string | null {
  if (typeof channel === "string") return channel;
  if (!channel || typeof channel !== "object") return null;
  const value = channel as AnyRow;
  return String(value.channelId || value.channel_id || value.id || "") || null;
}

function helpChannels(program: AnyRow): string[] {
  const ids = new Set<string>();
  if (program?.helpChannel) ids.add(program.helpChannel);
  for (const channel of Array.isArray(program?.channels) ? program.channels : []) {
    const id = channelIdOf(channel);
    if (id && programs.isHelpChannel(id, (program.workspaceId || program.workspace_id || null) as unknown as null)) ids.add(id);
  }
  try {
    for (const row of db.listProgramChannels(program.id)) {
      if (row.kind === "help") ids.add(row.channel_id);
    }
  } catch (_) {}
  return [...ids];
}

function messageIsBot(message: AnyRow): boolean {
  const botId = config?.slack?.botUserId;
  return !!message?.bot_id || (botId && message.user === botId) || message?.subtype === "bot_message";
}

function isTopLevelHuman(message: AnyRow | null | undefined): boolean {
  if (!message || !message.ts || message.thread_ts && message.thread_ts !== message.ts) return false;
  if (!message.user || messageIsBot(message)) return false;
  if (message.subtype && (message.subtype.startsWith("channel_") || message.subtype === "message_changed" || message.subtype === "message_deleted" || message.subtype.includes("join") || message.subtype.includes("leave"))) return false;
  return String(message.text || "").trim().length > 0;
}

function nextCursor(response: AnyRow): string | null {
  return response?.response_metadata?.next_cursor || response?.metadata?.next_cursor || null;
}

async function historyPage(client: SlackClientLike, channel: string, cursor: string | null, oldest: string, throttle: SlackThrottle): Promise<AnyRow> {
  return throttle.call(() => client.conversations.history({ channel, oldest, limit: 100, ...(cursor ? { cursor } : {}) }));
}

async function replies(client: SlackClientLike, channel: string, threadTs: string, throttle: SlackThrottle): Promise<AnyRow[]> {
  const out: AnyRow[] = [];
  let cursor: string | null = null;
  do {
    const response = await throttle.call(() => client.conversations.replies({ channel, ts: threadTs, limit: 100, ...(cursor ? { cursor } : {}) }));
    out.push(...(response?.messages || []));
    cursor = nextCursor(response);
  } while (cursor);
  return out;
}

function parseDetail(event: AnyRow): AnyRow {
  try { return JSON.parse(String(event.detail || "{}")) as AnyRow; } catch (_) { return {}; }
}

function hasEventTs(ticketId: number, ts: unknown): boolean {
  return (db.listTicketEvents(ticketId, 500) as AnyRow[]).some((event) => String(parseDetail(event).ts || "") === String(ts));
}

function isHelper(programId: string, userId: string | null): boolean {
  if (!userId) return false;
  if (tickets.isActorAllowed(programId, userId, false)) return true;
  return (db.listHelpers(programId, false) as AnyRow[]).some((row: AnyRow) => row.user_id === userId);
}

function recordEvent(ticket: AnyRow, eventType: string, actorId: string | null, message: AnyRow, detail: AnyRow = {}): boolean {
  if (hasEventTs(Number(ticket.id), message.ts)) return false;
  const addTicketEvent = db.addTicketEvent as unknown as (event: Record<string, unknown>) => unknown;
  addTicketEvent({
    ticketId: ticket.id,
    programId: ticket.program_id,
    actorId,
    eventType,
    detail: { ...detail, ts: message.ts, text: String(message.text || "").trim(), backfill: true },
    createdAt: tsMs(message.ts),
  });
  return true;
}

function addReplyEvents(ticket: AnyRow, program: AnyRow, messages: AnyRow[]): { helperMessages: AnyRow[]; pixieMessages: AnyRow[]; requesterMessages: AnyRow[] } {
  const helperMessages: AnyRow[] = [];
  const pixieMessages: AnyRow[] = [];
  const requesterMessages: AnyRow[] = [];
  for (const message of messages || []) {
    if (!message.ts || String(message.ts) === String(ticket.thread_ts)) continue;
    const userId = message.user || null;
    if (messageIsBot(message)) {
      if (recordEvent(ticket, "pixie_answer", userId, message)) pixieMessages.push(message);
      else pixieMessages.push(message);
      const recordFirstResponse = db.recordFirstResponse as unknown as (...args: unknown[]) => unknown;
      recordFirstResponse(ticket.id, false, tsMs(message.ts));
      continue;
    }
    if (userId === ticket.requester_id) {
      if (recordEvent(ticket, "requester_followup", userId, message)) requesterMessages.push(message);
      else requesterMessages.push(message);
      continue;
    }
    if (isHelper(String(program.id), userId)) {
      const recorded = recordEvent(ticket, "helper_reply", userId, message, { backfill: true });
      helperMessages.push(message);
      const recordFirstResponse = db.recordFirstResponse as unknown as (...args: unknown[]) => unknown;
      recordFirstResponse(ticket.id, true, tsMs(message.ts));
      if (recorded) {
        try { require("./helperRoute").recordReply({ programId: ticket.program_id, userId, category: ticket.category }); } catch (_) {}
      }
    }
  }
  return { helperMessages, pixieMessages, requesterMessages };
}

function reactionConfirms(messages: AnyRow[], ticket: AnyRow, program: AnyRow): number | null {
  let latest = null;
  for (const message of messages || []) {
    for (const reaction of message.reactions || []) {
      if (!CHECKMARKS.has(String(reaction.name || "").toLowerCase())) continue;
      const users = Array.isArray(reaction.users) ? reaction.users : [];
      if (users.some((userId: string) => userId === ticket.requester_id || isHelper(String(program.id), userId))) {
        latest = Math.max(latest || 0, tsMs(message.ts));
      }
    }
  }
  return latest;
}

function openStatus(status: unknown): boolean {
  return typeof status === "string" && ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened", "ai_answered"].includes(status);
}

async function resolveOrQueue(ticket: AnyRow, program: AnyRow, messages: AnyRow[], replyState: { helperMessages: AnyRow[]; pixieMessages: AnyRow[]; requesterMessages: AnyRow[] }, now: number, options: AnyRow): Promise<{ resolved: boolean; closed: boolean; queued: boolean }> {
  if (!openStatus(ticket.status)) return { resolved: false, closed: false, queued: false };
  const answerMessages = [...replyState.helperMessages, ...replyState.pixieMessages];
  const existingAnswer = (db.listTicketEvents(ticket.id, 500) as AnyRow[]).some((event: AnyRow) => event.event_type === "helper_reply" || event.event_type === "pixie_answer");
  if (answerMessages.length === 0 && !existingAnswer) {
    if (now - tsMs(ticket.thread_ts) > QUIET_CLOSE_MS) {
      const closeTicket = db.closeTicket as unknown as (...args: unknown[]) => unknown;
      if (closeTicket(ticket.id, "no answer (history import)", now)) {
        const addTicketEvent = db.addTicketEvent as unknown as (event: Record<string, unknown>) => unknown;
        addTicketEvent({ ticketId: ticket.id, programId: ticket.program_id, eventType: "closed", detail: { source: "backfill", reason: "no answer (history import)" }, createdAt: now });
        return { resolved: false, closed: true, queued: false };
      }
    }
    return { resolved: false, closed: false, queued: false };
  }
  const requesterConfirmation = replyState.requesterMessages.find((message) => CONFIRMATION.test(String(message.text || "")));
  const reactionAt = reactionConfirms(messages, ticket, program);
  const signalAt = requesterConfirmation ? tsMs(requesterConfirmation.ts) : reactionAt;
  if (!signalAt) {
    const helperLast = lastWord.helperLastWord({
      programId: ticket.program_id,
      requesterId: ticket.requester_id,
      threadTs: ticket.thread_ts,
      rows: (messages || []).map((message) => ({ ts: message.ts, userId: message.user || null, isBot: messageIsBot(message) })),
      now,
    });
    if (helperLast) {
      const resolveTicket = tickets.resolveTicket as unknown as (options: AnyRow) => AnyRow;
      const result = resolveTicket({
        ticketId: ticket.id,
        actorId: null,
        creditId: helperLast.helperId,
        resolution: "resolved: a helper had the last word and the requester didn't come back",
        source: "backfill",
        resolutionMeta: { rule: "last_word", helper: helperLast.helperId },
        resolvedAt: helperLast.at,
        programId: ticket.program_id,
        workspaceId: ticket.workspace_id,
        program,
      });
      return { resolved: !!result.ok, closed: false, queued: false };
    }
  }
  if (signalAt) {
    const resolveTicket = tickets.resolveTicket as unknown as (options: AnyRow) => AnyRow;
    const result = resolveTicket({
      ticketId: ticket.id,
      actorId: null,
      resolution: "resolved from historical confirmation",
      source: "backfill",
      resolvedAt: signalAt,
      programId: ticket.program_id,
      workspaceId: ticket.workspace_id,
      program,
    });
    return { resolved: !!result.ok, closed: false, queued: false };
  }
  const enqueueForJudge = resolutionWatcher.enqueueForJudge as unknown as (options: AnyRow) => boolean;
  const queued = enqueueForJudge({ ticketId: ticket.id, client: options.client, program, judge: options.judge, autoStart: options.autoStartJudge !== false });
  return { resolved: false, closed: false, queued };
}

function incrementProgress(progress: AnyRow, patch: AnyRow): AnyRow {
  const next: AnyRow = {};
  for (const key of ["messagesScanned", "ticketsCreated", "ticketsEnriched", "resolved", "closed", "queuedForJudge"]) {
    if (patch[key]) next[key] = Number(progress[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] || 0) + Number(patch[key]);
  }
  return upsertProgress(String(progress.program_id || ""), String(progress.channel_id || ""), next);
}

async function importChannel(program: AnyRow, channel: string, client: SlackClientLike, options: AnyRow = {}): Promise<AnyRow> {
  const clock = options.now || Date.now;
  const throttle = options.throttle || new SlackThrottle(options);
  let progress = getImportProgress(String(program.id), channel);
  if (!progress) {
    progress = upsertProgress(String(program.id), channel, { status: "pending", rulesVersion: RULES_VERSION });
  } else if (Number(progress.rules_version || 1) < RULES_VERSION) {
    progress = upsertProgress(String(program.id), channel, {
      status: "pending", cursor: null, newestTsDone: null, rulesVersion: RULES_VERSION,
      messagesScanned: 0, ticketsCreated: 0, ticketsEnriched: 0, resolved: 0, closed: 0, queuedForJudge: 0, completedAt: null,
    });
  }
  const wasDone = progress.status === "done";
    progress = upsertProgress(String(program.id), channel, { status: "running", lastError: null, startedAt: progress.started_at || clock() });
  let cursor = progress.cursor || null;
  const oldest = wasDone ? (progress.newest_ts_done || "0") : "0";
  try {
    do {
      const page = await historyPage(client, channel, cursor, oldest, throttle);
      const messages = [...(page?.messages || [])].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
      for (const message of messages) {
        if (!isTopLevelHuman(message)) continue;
        const timestamp = tsMs(message.ts, clock());
        const getTicketByThread = db.getTicketByChannelThreadTs as unknown as (channel: string, threadTs: string, workspaceId: null, programId: string) => AnyRow | null;
        const before = getTicketByThread(channel, String(message.ts), (program.workspaceId || program.workspace_id || null) as unknown as null, String(program.id));
        const ticket = await ensureSupportTicket({
          program,
          channel,
          threadTs: message.ts,
          requesterId: message.user,
          question: String(message.text || "").trim(),
          workspaceId: program.workspaceId || program.workspace_id || null,
          silent: true,
          backfill: true,
          createdAt: timestamp,
          source: "backfill",
        });
        if (!ticket) continue;
        let counts = { messagesScanned: !before || !before.visibility ? 1 : 0, ticketsCreated: before ? 0 : 1, ticketsEnriched: before && (!before.visibility || !before.question || !before.requester_id) ? 1 : 0, resolved: 0, closed: 0, queuedForJudge: 0 };
        const thread = (message.reply_count || 0) > 0 ? await replies(client, channel, String(message.ts), throttle) : [message];
        const state = addReplyEvents(ticket, program, thread);
        const outcome = await resolveOrQueue(db.getTicket(ticket.id), program, thread, state, clock(), options);
        counts.resolved = outcome.resolved ? 1 : 0;
        counts.closed = outcome.closed ? 1 : 0;
        counts.queuedForJudge = outcome.queued ? 1 : 0;
        progress = incrementProgress(progress, counts);
        const newestTsDone = Math.max(Number(progress.newest_ts_done || 0), Number(message.ts || 0));
        progress = upsertProgress(String(program.id), channel, { newestTsDone: String(newestTsDone) });
      }
      cursor = nextCursor(page);
      progress = upsertProgress(String(program.id), channel, { cursor });
    } while (cursor);
    return upsertProgress(String(program.id), channel, { status: "done", cursor: null, completedAt: clock(), lastError: null });
  } catch (error: unknown) {
    upsertProgress(String(program.id), channel, { status: "error", cursor, lastError: errorMessage(error), completedAt: null });
    throw error;
  }
}

async function importProgram(program: AnyRow, client: SlackClientLike, options: AnyRow = {}): Promise<AnyRow> {
  if (!program?.id) throw new Error("program required");
  if (!client?.conversations?.history || !client?.conversations?.replies) throw new Error("Slack conversations client required");
  const channels = helpChannels(program);
  for (const channel of channels) await importChannel(program, channel, client, options);
  return getProgress(String(program.id), channels);
}

function progressShape(programId: string, rows: AnyRow[], channels: string[]): AnyRow {
  const list = channels.map((channel) => rows.find((row) => row.channel_id === channel) || {
    program_id: programId, channel_id: channel, status: "pending", messages_scanned: 0, tickets_created: 0, tickets_enriched: 0, resolved: 0, closed: 0, queued_for_judge: 0,
  });
  const totals = list.reduce<Record<string, number>>((out, row) => {
    for (const key of ["messages_scanned", "tickets_created", "tickets_enriched", "resolved", "closed", "queued_for_judge"]) out[key] += Number(row[key] || 0);
    return out;
  }, { messages_scanned: 0, tickets_created: 0, tickets_enriched: 0, resolved: 0, closed: 0, queued_for_judge: 0 });
  const status = list.some((row) => row.status === "running") ? "running" : list.some((row) => row.status === "error") ? "error" : list.length > 0 && list.every((row) => row.status === "done") ? "done" : "pending";
  return {
    programId,
    status,
    channels: list.map((row) => ({ channel: row.channel_id, status: row.status, cursor: row.cursor, newestTsDone: row.newest_ts_done, messagesScanned: row.messages_scanned || 0, ticketsCreated: row.tickets_created || 0, enriched: row.tickets_enriched || 0, resolved: row.resolved || 0, closed: row.closed || 0, queuedForJudge: row.queued_for_judge || 0, lastError: row.last_error || null })),
    messagesScanned: totals.messages_scanned,
    ticketsCreated: totals.tickets_created,
    enriched: totals.tickets_enriched,
    resolved: totals.resolved,
    closed: totals.closed,
    queuedForJudge: totals.queued_for_judge,
    lastError: list.find((row) => row.last_error)?.last_error || null,
  };
}

function getProgress(programId: string, channels: string[] | null = null): AnyRow {
  const program = programs.get(programId);
  const list = channels || helpChannels(program || { id: programId });
  return progressShape(programId, db.getHistoryImportProgress(programId), list);
}

function startProgramImport(programId: string, client: SlackClientLike, options: AnyRow = {}): Promise<AnyRow> {
  if (inFlight.has(programId)) return inFlight.get(programId);
  const program = programs.get(programId);
  if (!program) return Promise.resolve({ error: "unknown program" });
  const run = jobLease.runOnce(`ticket-history-backfill:${programId}`, LEASE_TTL_MS, () => importProgram(program, client, options))
    .catch((error: unknown) => {
      log.warn("ticketBackfill", `history import failed for ${programId}: ${errorMessage(error)}`);
      return getProgress(programId);
    })
    .finally(() => inFlight.delete(programId));
  inFlight.set(programId, run);
  return run;
}

async function runPendingImports(client: SlackClientLike): Promise<void> {
  const eligible = (programs.all() as AnyRow[]).filter((program: AnyRow) => program.supportActive !== false && program.status !== "paused");
  const tracked = (program: AnyRow) => db.getTicketsForProgram(String(program.id)).length;
  eligible.sort((a: AnyRow, b: AnyRow) => tracked(b) - tracked(a));
  for (const program of eligible) {
    if (helpChannels(program).length === 0) continue;
    await startProgramImport(String(program.id), client);
  }
}

const RETRY_MS = 10 * 60 * 1000;
let retryTimer: ReturnType<typeof setInterval> | null = null;

function start(client: SlackClientLike, { delayMs = STARTUP_DELAY_MS, retryMs = RETRY_MS }: { delayMs?: number; retryMs?: number } = {}): ReturnType<typeof setTimeout> | null {
  if (startupTimer || retryTimer) return startupTimer || retryTimer;
  const tick = () => void runPendingImports(client).catch((error: unknown) => log.warn("ticketBackfill", `history import pass failed: ${errorMessage(error)}`));
  startupTimer = setTimeout(() => {
    startupTimer = null;
    tick();
    retryTimer = setInterval(tick, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  }, delayMs);
  if (startupTimer.unref) startupTimer.unref();
  return startupTimer;
}

function stop() {
  if (startupTimer) clearTimeout(startupTimer);
  if (retryTimer) clearInterval(retryTimer);
  startupTimer = null;
  retryTimer = null;
}

export = { MIN_INTERVAL_MS, QUIET_CLOSE_MS, SlackThrottle, helpChannels, isTopLevelHuman, importChannel, importProgram, startProgramImport, getProgress, start, stop };
