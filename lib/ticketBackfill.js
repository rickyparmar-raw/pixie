const db = require("./db");
const log = require("./log");
const programs = require("./programs");
const tickets = require("./tickets");
const jobLease = require("./jobLease");
const resolutionWatcher = require("./resolutionWatcher");
const lastWord = require("./lastWord");

// Bump when the resolution rules change, so every channel is re-walked once
// from the beginning and old tickets are re-evaluated. v2: last-word rule.
// v3: tickets regardless of the program's ticket toggles (v2 created none for Pixl).
const RULES_VERSION = 3;
const { config } = require("./config");

// Slack allows ~50 conversations.replies calls a minute per app, shared with
// live Pixie. The import runs just under that (1.2s) and drops to 3s for the
// rest of the run the first time Slack rate-limits it, so live replies win.
const MIN_INTERVAL_MS = Number(process.env.PIXIE_HISTORY_IMPORT_SPACING_MS) || 1200;
const BACKOFF_INTERVAL_MS = 3000;
const QUIET_CLOSE_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const LEASE_TTL_MS = 30 * 60 * 1000;
const CHECKMARKS = new Set(["white_check_mark", "heavy_check_mark", "✅"]);
const CONFIRMATION = /\b(?:thanks?(?:\s+so\s+much)?[,.!]?\s+(?:that|it)\s+worked|that\s+worked|solved|fixed|got\s+it|nvm\s+figured\s+it\s+out|never\s*mind\s*,?\s+i\s+figured\s+it\s+out)\b/i;
const inFlight = new Map();
let startupTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tsMs(ts, fallback = Date.now()) {
  const value = Number(ts);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : fallback;
}

function retryAfterMs(error) {
  const data = error?.data || {};
  const raw = error?.retryAfter ?? error?.retry_after ?? data.retryAfter ?? data.retry_after
    ?? error?.headers?.["retry-after"] ?? error?.headers?.["Retry-After"];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

function isRateLimited(error) {
  const code = error?.code || error?.data?.error || error?.error;
  return code === "ratelimited" || code === "rate_limited" || code === "rate_limit" || code === 429;
}

class SlackThrottle {
  constructor({ sleepFn = sleep, now = Date.now, spacingMs = MIN_INTERVAL_MS } = {}) {
    this.sleep = sleepFn;
    this.now = now;
    this.spacingMs = spacingMs;
    this.lastCallAt = null;
  }

  async call(fn) {
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
      } catch (error) {
        if (!isRateLimited(error)) throw error;
        if (this.spacingMs > 0) this.spacingMs = Math.max(this.spacingMs, BACKOFF_INTERVAL_MS);
        const retry = retryAfterMs(error);
        await this.sleep(Math.max(this.spacingMs, retry === null ? this.spacingMs : retry));
      }
    }
  }
}

function channelIdOf(channel) {
  if (typeof channel === "string") return channel;
  return channel?.channelId || channel?.channel_id || channel?.id || null;
}

// Help channels only: a program's main/discussion channels are chatter, and
// walking their history would spend thousands of Slack calls on messages that
// never become tickets.
function helpChannels(program) {
  const ids = new Set();
  if (program?.helpChannel) ids.add(program.helpChannel);
  for (const channel of Array.isArray(program?.channels) ? program.channels : []) {
    const id = channelIdOf(channel);
    if (id && programs.isHelpChannel(id, program.workspaceId || program.workspace_id || null)) ids.add(id);
  }
  try {
    for (const row of db.listProgramChannels(program.id)) {
      if (row.kind === "help") ids.add(row.channel_id);
    }
  } catch (_) {}
  return [...ids];
}

function messageIsBot(message) {
  const botId = config?.slack?.botUserId;
  return !!message?.bot_id || (botId && message.user === botId) || message?.subtype === "bot_message";
}

function isTopLevelHuman(message) {
  if (!message || !message.ts || message.thread_ts && message.thread_ts !== message.ts) return false;
  if (!message.user || messageIsBot(message)) return false;
  if (message.subtype && (message.subtype.startsWith("channel_") || message.subtype === "message_changed" || message.subtype === "message_deleted" || message.subtype.includes("join") || message.subtype.includes("leave"))) return false;
  return String(message.text || "").trim().length > 0;
}

function nextCursor(response) {
  return response?.response_metadata?.next_cursor || response?.metadata?.next_cursor || null;
}

async function historyPage(client, channel, cursor, oldest, throttle) {
  return throttle.call(() => client.conversations.history({ channel, oldest, limit: 100, ...(cursor ? { cursor } : {}) }));
}

async function replies(client, channel, threadTs, throttle) {
  const out = [];
  let cursor = null;
  do {
    const response = await throttle.call(() => client.conversations.replies({ channel, ts: threadTs, limit: 100, ...(cursor ? { cursor } : {}) }));
    out.push(...(response?.messages || []));
    cursor = nextCursor(response);
  } while (cursor);
  return out;
}

function parseDetail(event) {
  try { return JSON.parse(event.detail || "{}"); } catch (_) { return {}; }
}

function hasEventTs(ticketId, ts) {
  return db.listTicketEvents(ticketId, 500).some((event) => String(parseDetail(event).ts || "") === String(ts));
}

// History import credits anyone who was ever on the roster, not just today's
// active helpers, so a helper who has since left keeps their past replies.
function isHelper(programId, userId) {
  if (!userId) return false;
  if (tickets.isActorAllowed(programId, userId, false)) return true;
  return db.listHelpers(programId, false).some((row) => row.user_id === userId);
}

function recordEvent(ticket, eventType, actorId, message, detail = {}) {
  if (hasEventTs(ticket.id, message.ts)) return false;
  db.addTicketEvent({
    ticketId: ticket.id,
    programId: ticket.program_id,
    actorId,
    eventType,
    detail: { ...detail, ts: message.ts, text: String(message.text || "").trim(), backfill: true },
    createdAt: tsMs(message.ts),
  });
  return true;
}

function addReplyEvents(ticket, program, messages) {
  const helperMessages = [];
  const pixieMessages = [];
  const requesterMessages = [];
  for (const message of messages || []) {
    if (!message.ts || String(message.ts) === String(ticket.thread_ts)) continue;
    const userId = message.user || null;
    if (messageIsBot(message)) {
      if (recordEvent(ticket, "pixie_answer", userId, message)) pixieMessages.push(message);
      else pixieMessages.push(message);
      db.recordFirstResponse(ticket.id, false, tsMs(message.ts));
      continue;
    }
    if (userId === ticket.requester_id) {
      if (recordEvent(ticket, "requester_followup", userId, message)) requesterMessages.push(message);
      else requesterMessages.push(message);
      continue;
    }
    if (isHelper(program.id, userId)) {
      const recorded = recordEvent(ticket, "helper_reply", userId, message, { backfill: true });
      helperMessages.push(message);
      db.recordFirstResponse(ticket.id, true, tsMs(message.ts));
      // Only a newly recorded reply counts toward expertise, so reruns and
      // replies the live path already recorded never inflate it.
      if (recorded) {
        try { require("./helperRoute").recordReply({ programId: ticket.program_id, userId, category: ticket.category }); } catch (_) {}
      }
    }
  }
  return { helperMessages, pixieMessages, requesterMessages };
}

function reactionConfirms(messages, ticket, program) {
  let latest = null;
  for (const message of messages || []) {
    for (const reaction of message.reactions || []) {
      if (!CHECKMARKS.has(String(reaction.name || "").toLowerCase())) continue;
      const users = Array.isArray(reaction.users) ? reaction.users : [];
      if (users.some((userId) => userId === ticket.requester_id || isHelper(program.id, userId))) {
        latest = Math.max(latest || 0, tsMs(message.ts));
      }
    }
  }
  return latest;
}

function openStatus(status) {
  return ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened", "ai_answered"].includes(status);
}

async function resolveOrQueue(ticket, program, messages, replyState, now, options) {
  if (!openStatus(ticket.status)) return { resolved: false, closed: false, queued: false };
  const answerMessages = [...replyState.helperMessages, ...replyState.pixieMessages];
  const existingAnswer = db.listTicketEvents(ticket.id, 500).some((event) => event.event_type === "helper_reply" || event.event_type === "pixie_answer");
  if (answerMessages.length === 0 && !existingAnswer) {
    if (now - tsMs(ticket.thread_ts) > QUIET_CLOSE_MS) {
      if (db.closeTicket(ticket.id, "no answer (history import)", now)) {
        db.addTicketEvent({ ticketId: ticket.id, programId: ticket.program_id, eventType: "closed", detail: { source: "backfill", reason: "no answer (history import)" }, createdAt: now });
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
      const result = tickets.resolveTicket({
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
    const result = tickets.resolveTicket({
      ticketId: ticket.id,
      // System resolve; finishResolve credits the worker (see resolutionWatcher).
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
  const queued = resolutionWatcher.enqueueForJudge({ ticketId: ticket.id, client: options.client, program, judge: options.judge, autoStart: options.autoStartJudge !== false });
  return { resolved: false, closed: false, queued };
}

function incrementProgress(progress, patch) {
  const next = {};
  for (const key of ["messagesScanned", "ticketsCreated", "ticketsEnriched", "resolved", "closed", "queuedForJudge"]) {
    if (patch[key]) next[key] = (progress[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] || 0) + patch[key];
  }
  return db.upsertHistoryImportProgress(progress.program_id, progress.channel_id, next);
}

async function importChannel(program, channel, client, options = {}) {
  const clock = options.now || Date.now;
  const throttle = options.throttle || new SlackThrottle(options);
  let progress = db.getHistoryImportProgress(program.id, channel);
  if (!progress) {
    progress = db.upsertHistoryImportProgress(program.id, channel, { status: "pending", rulesVersion: RULES_VERSION });
  } else if (Number(progress.rules_version || 1) < RULES_VERSION) {
    // New rules: start over from the channel's first message with fresh counts.
    progress = db.upsertHistoryImportProgress(program.id, channel, {
      status: "pending", cursor: null, newestTsDone: null, rulesVersion: RULES_VERSION,
      messagesScanned: 0, ticketsCreated: 0, ticketsEnriched: 0, resolved: 0, closed: 0, queuedForJudge: 0, completedAt: null,
    });
  }
  const wasDone = progress.status === "done";
  progress = db.upsertHistoryImportProgress(program.id, channel, { status: "running", lastError: null, startedAt: progress.started_at || clock() });
  let cursor = progress.cursor || null;
  const oldest = wasDone ? (progress.newest_ts_done || "0") : "0";
  try {
    do {
      const page = await historyPage(client, channel, cursor, oldest, throttle);
      const messages = [...(page?.messages || [])].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
      for (const message of messages) {
        if (!isTopLevelHuman(message)) continue;
        const timestamp = tsMs(message.ts, clock());
        const before = db.getTicketByChannelThreadTs(channel, message.ts, program.workspaceId || program.workspace_id || null, program.id);
        const ticket = await tickets.ensureSupportTicket({
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
        const thread = (message.reply_count || 0) > 0 ? await replies(client, channel, message.ts, throttle) : [message];
        const state = addReplyEvents(ticket, program, thread);
        const outcome = await resolveOrQueue(db.getTicket(ticket.id), program, thread, state, clock(), options);
        counts.resolved = outcome.resolved ? 1 : 0;
        counts.closed = outcome.closed ? 1 : 0;
        counts.queuedForJudge = outcome.queued ? 1 : 0;
        progress = incrementProgress(progress, counts);
        const newestTsDone = Math.max(Number(progress.newest_ts_done || 0), Number(message.ts || 0));
        progress = db.upsertHistoryImportProgress(program.id, channel, { newestTsDone: String(newestTsDone) });
      }
      cursor = nextCursor(page);
      progress = db.upsertHistoryImportProgress(program.id, channel, { cursor });
    } while (cursor);
    return db.upsertHistoryImportProgress(program.id, channel, { status: "done", cursor: null, completedAt: clock(), lastError: null });
  } catch (error) {
    db.upsertHistoryImportProgress(program.id, channel, { status: "error", cursor, lastError: String(error?.message || error), completedAt: null });
    throw error;
  }
}

async function importProgram(program, client, options = {}) {
  if (!program?.id) throw new Error("program required");
  if (!client?.conversations?.history || !client?.conversations?.replies) throw new Error("Slack conversations client required");
  const channels = helpChannels(program);
  for (const channel of channels) await importChannel(program, channel, client, options);
  return getProgress(program.id, channels);
}

function progressShape(programId, rows, channels) {
  const list = channels.map((channel) => rows.find((row) => row.channel_id === channel) || {
    program_id: programId, channel_id: channel, status: "pending", messages_scanned: 0, tickets_created: 0, tickets_enriched: 0, resolved: 0, closed: 0, queued_for_judge: 0,
  });
  const totals = list.reduce((out, row) => {
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

function getProgress(programId, channels = null) {
  const program = programs.get(programId);
  const list = channels || helpChannels(program || { id: programId });
  return progressShape(programId, db.getHistoryImportProgress(programId), list);
}

function startProgramImport(programId, client, options = {}) {
  if (inFlight.has(programId)) return inFlight.get(programId);
  const program = programs.get(programId);
  if (!program) return Promise.resolve({ error: "unknown program" });
  const run = jobLease.runOnce(`ticket-history-backfill:${programId}`, LEASE_TTL_MS, () => importProgram(program, client, options))
    .catch((error) => {
      log.warn("ticketBackfill", `history import failed for ${programId}: ${error.message}`);
      return getProgress(programId);
    })
    .finally(() => inFlight.delete(programId));
  inFlight.set(programId, run);
  return run;
}

// Imports every eligible program: a full pass the first time (or after a
// rules change), then only messages newer than the last one done, so every
// new help-channel request becomes a dashboard ticket within RETRY_MS even
// when the program's own ticket toggles are off. Idempotent: per-program
// leases and the in-flight map make repeat calls no-ops while one runs.
async function runPendingImports(client) {
  // Passive programs still track dashboard tickets, so they're imported too;
  // only programs whose support is off or paused are skipped. Busiest first.
  const eligible = programs.all().filter((program) => program.supportActive !== false && program.status !== "paused");
  const tracked = (program) => db.getTicketsForProgram(program.id).length;
  eligible.sort((a, b) => tracked(b) - tracked(a));
  for (const program of eligible) {
    if (helpChannels(program).length === 0) continue;
    await startProgramImport(program.id, client);
  }
}

// Runs shortly after boot, then retries every RETRY_MS: a lease left behind by
// an instance that was replaced mid-import only blocks until it expires,
// instead of skipping the import until the next deploy.
const RETRY_MS = 10 * 60 * 1000;
let retryTimer = null;

function start(client, { delayMs = STARTUP_DELAY_MS, retryMs = RETRY_MS } = {}) {
  if (startupTimer || retryTimer) return startupTimer || retryTimer;
  const tick = () => void runPendingImports(client).catch((error) => log.warn("ticketBackfill", `history import pass failed: ${error.message}`));
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

module.exports = { MIN_INTERVAL_MS, QUIET_CLOSE_MS, SlackThrottle, helpChannels, isTopLevelHuman, importChannel, importProgram, startProgramImport, getProgress, start, stop };
