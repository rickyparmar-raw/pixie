// Program-scoped support macros (?shipping). Organizers define approved
// templates; helpers search/preview/send them from the dashboard. Templates
// interpolate a fixed safe value set by plain token replacement. Unknown
// tokens stay literal (visible, never executed), and there is no expression
// evaluation of any kind.
const db = require("./db");
const audit = require("./audit");

// Lowercase sigil + short slug: triggers stay typable and unique per program.
const TRIGGER_RE = /^[?!][a-z0-9][a-z0-9_-]{0,30}$/;
// The only interpolatable names — anything else stays literal, never executed.
const SAFE_KEYS = new Set([
  "requester", "ticket_id", "program", "status", "helper",
  "queue_depth", "typical_wait", "position",
]);
// Canonical terminal states a macro may land after sending — via db.* only.
const SEND_TRANSITIONS = new Set(["resolved", "closed", "snoozed"]);
const OPEN_STATUSES = new Set(["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"]);
// Snooze parks the ticket for a day so the helper loop re-surfaces it.
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const BULK_MAX_TICKETS = 50;
const BULK_DELAY_MS = 100;
const MAX_NAME = 80;
const MAX_CONTENT = 2000;

// These are suggestions only. The dashboard may copy one into its create
// form; Core never persists or sends them automatically.
const SUGGESTED_TEMPLATES = [
  {
    key: "queue-delay",
    trigger: "!queue-update",
    name: "Queue backed up / review delay",
    description: "Explain that reviews are delayed by the current queue.",
    content: "Hey {requester} — reviews are taking longer than usual because the queue is backed up ({queue_depth} waiting, usually {typical_wait}). You're #{position}; hang tight until your review is done!",
  },
  {
    key: "shipping-delay",
    trigger: "!shipping-delay",
    name: "Shipping delay",
    description: "Let a requester know that shipping is taking longer than expected.",
    content: "Hey {requester} — your shipment is taking a little longer than expected. We'll share an update as soon as we have one. (Ticket #{ticket_id})",
  },
  {
    key: "need-more-info",
    trigger: "!need-info",
    name: "Need more info",
    description: "Ask the requester for the details needed to investigate.",
    content: "Hey {requester} — could you share a little more detail so we can investigate this properly? Please include what you expected, what happened, and any relevant links or screenshots.",
  },
  {
    key: "resolved-follow-up",
    trigger: "!resolved-follow-up",
    name: "Resolved follow-up",
    description: "Confirm that the request is resolved and invite a follow-up.",
    content: "Hey {requester} — this should be resolved now. If anything still looks wrong, reply here and we'll take another look.",
    onSendTransition: "resolved",
  },
];

// The only live queue tokens. Values are computed at send time from this
// ticket's program and category; no arbitrary database fields are exposed.
const PLACEHOLDER_DOCS = [
  { token: "{queue_depth}", description: "Open queue tickets waiting for a helper; category-scoped when this ticket has a category." },
  { token: "{typical_wait}", description: "The recent median wait in human-friendly text, or \"a little while\" with insufficient history." },
  { token: "{position}", description: "This ticket's one-based place in the program/category waiting queue." },
];

function now() {
  return Date.now();
}

function normalizeTrigger(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!TRIGGER_RE.test(t)) return null;
  return t;
}

function interpolate(content, values = {}) {
  return String(content || "").replace(/\{([a-z_]+)\}/g, (match, key) => {
    if (!SAFE_KEYS.has(key)) return match;
    const v = values[key];
    if (v === null || v === undefined) return match;
    return String(v);
  });
}

function valuesFor({ ticket = null, program = null, actorId = null } = {}) {
  return {
    requester: ticket ? `<@${ticket.requester_id}>` : "",
    ticket_id: ticket ? String(ticket.id) : "",
    program: program ? program.name : "",
    status: ticket ? ticket.status : "",
    helper: actorId ? `<@${actorId}>` : "",
  };
}

function contextValuesFor({ ticket = null, program = null, actorId = null } = {}) {
  const values = valuesFor({ ticket, program, actorId });
  if (!ticket || !ticket.program_id) {
    return { ...values, queue_depth: "", typical_wait: "a little while", position: "" };
  }
  const wait = require("./waitTime");
  const category = ticket.category || null;
  const estimate = wait.estimate({ programId: ticket.program_id, category, ticketId: ticket.id });
  const queuePosition = wait.queuePosition(ticket.program_id, ticket.id, category);
  return {
    ...values,
    queue_depth: String(wait.queueDepth(ticket.program_id, category)),
    typical_wait: wait.formatWait(estimate) || "a little while",
    position: queuePosition === null ? "" : String(queuePosition + 1),
  };
}

function suggestedTemplates() {
  return SUGGESTED_TEMPLATES.map((template) => ({ ...template }));
}

function placeholderDocs() {
  return PLACEHOLDER_DOCS.map((item) => ({ ...item }));
}

function validate({ trigger, name, content, onSendTransition = null }) {
  if (!normalizeTrigger(trigger)) return "trigger must look like ?shipping (lowercase, ?/! prefix)";
  if (!String(name || "").trim() || String(name).length > MAX_NAME) return "name required (max 80 chars)";
  if (!String(content || "").trim() || String(content).length > MAX_CONTENT) return "content required (max 2000 chars)";
  const empty = onSendTransition === null || onSendTransition === undefined || onSendTransition === "";
  if (!empty && !SEND_TRANSITIONS.has(onSendTransition)) return "invalid on-send transition";
  return null;
}

function isUniqueConflict(e) {
  return String((e && e.message) || "").includes("UNIQUE");
}

function create({ programId, trigger, name, description = null, content, enabled = true, allowedRoles = null, onSendTransition = null, createdBy = null }) {
  const problem = validate({ trigger, name, content, onSendTransition });
  if (problem) return { error: problem };
  const t = now();
  try {
    const res = db.handle().query(
      `INSERT INTO program_macros (program_id, trigger, name, description, content, enabled, allowed_roles, on_send_transition, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(programId, normalizeTrigger(trigger), String(name).trim(), description, String(content).trim(),
      enabled ? 1 : 0, allowedRoles ? JSON.stringify(allowedRoles) : null, onSendTransition || null, createdBy, t, t);
    const row = get(Number(res.lastInsertRowid));
    audit.record({ programId, actorId: createdBy, action: "macro.created", entityType: "macro", entityId: row.id });
    return { ok: true, macro: row };
  } catch (e) {
    if (isUniqueConflict(e)) return { error: "that trigger already exists for this program" };
    return { error: e.message };
  }
}

function get(id) {
  return db.handle().query("SELECT * FROM program_macros WHERE id = ?").get(id) || null;
}

function matchesQuery(row, needle) {
  return row.trigger.includes(needle)
    || (row.name || "").toLowerCase().includes(needle)
    || (row.description || "").toLowerCase().includes(needle);
}

function list(programId, { enabledOnly = false, q = null } = {}) {
  let rows = db.handle().query("SELECT * FROM program_macros WHERE program_id = ? ORDER BY trigger ASC").all(programId);
  if (enabledOnly) rows = rows.filter((r) => r.enabled);
  if (!q) return rows;
  const needle = String(q).toLowerCase();
  return rows.filter((r) => matchesQuery(r, needle));
}

function normalizePatchTrigger(patch) {
  if (patch.trigger === undefined) return { patch, error: null };
  const t = normalizeTrigger(patch.trigger);
  if (!t) return { patch, error: "invalid trigger" };
  return { patch: { ...patch, trigger: t }, error: null };
}

function update(id, patch = {}, actorId = null) {
  const row = get(id);
  if (!row) return { error: "macro not found" };
  const normalized = normalizePatchTrigger(patch);
  if (normalized.error) return { error: normalized.error };
  const next = normalized.patch;
  if (next.content !== undefined && (!String(next.content).trim() || String(next.content).length > MAX_CONTENT)) {
    return { error: "invalid content" };
  }
  const merged = { ...row, ...next, updated_at: now() };
  const problem = validate({ trigger: merged.trigger, name: merged.name, content: merged.content, onSendTransition: merged.on_send_transition });
  if (problem) return { error: problem };
  try {
    db.handle().query(
      `UPDATE program_macros SET trigger = ?, name = ?, description = ?, content = ?, enabled = ?, allowed_roles = ?, on_send_transition = ?, updated_at = ? WHERE id = ?`,
    ).run(merged.trigger, merged.name, merged.description, merged.content, merged.enabled ? 1 : 0,
      merged.allowed_roles, merged.on_send_transition, merged.updated_at, id);
  } catch (e) {
    if (isUniqueConflict(e)) return { error: "that trigger already exists for this program" };
    return { error: e.message };
  }
  audit.record({ programId: row.program_id, actorId, action: "macro.updated", entityType: "macro", entityId: id });
  return { ok: true, macro: get(id) };
}

function remove(id, actorId = null) {
  const row = get(id);
  if (!row) return { error: "macro not found" };
  db.handle().query("DELETE FROM program_macros WHERE id = ?").run(id);
  audit.record({ programId: row.program_id, actorId, action: "macro.deleted", entityType: "macro", entityId: id });
  return { ok: true };
}

function scoreMacro(macro, qterms) {
  const retrieve = require("./retrieve");
  const hay = new Set(retrieve.tokenize(`${macro.trigger} ${macro.name} ${macro.description || ""} ${macro.content}`.slice(0, 500)));
  let overlap = 0;
  for (const t of qterms) {
    if (hay.has(t)) overlap += 1;
  }
  return { id: macro.id, trigger: macro.trigger, name: macro.name, description: macro.description, score: Number((overlap / qterms.size).toFixed(3)) };
}

// Keyword-overlap suggestion for the copilot draft path. Ranked, never
// auto-applied, and permissions still gate the actual send.
function suggestFor({ programId, question, limit = 3 }) {
  const enabled = list(programId, { enabledOnly: true });
  if (!question || enabled.length === 0) return [];
  const retrieve = require("./retrieve");
  const qterms = new Set(retrieve.tokenize(question));
  if (qterms.size === 0) return [];
  return enabled
    .map((m) => scoreMacro(m, qterms))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function actorRole(programId, actorId) {
  const { isAdmin } = require("./config");
  if (isAdmin(actorId)) return "admin";
  if (db.isHelper(programId, actorId)) return "helper";
  return null;
}

function applySendTransition(macro, ticketId, actorId, client) {
  if (macro.on_send_transition === "resolved") {
    const tickets = require("./tickets");
    return tickets.resolveTicket({ ticketId, actorId, resolution: `resolved via macro ${macro.trigger}`, source: "macro", programId: macro.program_id, client });
  }
  else if (macro.on_send_transition === "closed") db.closeTicket(ticketId);
  else if (macro.on_send_transition === "snoozed") db.snoozeTicket(ticketId, Date.now() + SNOOZE_MS);
  return { ok: true };
}

async function send({ id, ticketId, actorId, client, requireOpen = false }) {
  const macro = get(id);
  if (!macro) return { error: "macro not found" };
  if (!macro.enabled) return { error: "macro is disabled" };
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.program_id !== macro.program_id) return { error: "program mismatch" };
  const guardOpen = requireOpen || macro.on_send_transition === "resolved";
  if (guardOpen && !OPEN_STATUSES.has(ticket.status)) return { error: "ticket is not open" };
  const allowed = macro.allowed_roles ? JSON.parse(macro.allowed_roles) : null;
  const role = actorRole(ticket.program_id, actorId);
  if (!role) return { error: "actor is not a helper of this program" };
  if (allowed && !allowed.includes(role)) return { error: `macro requires role: ${allowed.join("/")}` };

  const programs = require("./programs");
  const text = interpolate(macro.content, contextValuesFor({ ticket, program: programs.get(ticket.program_id), actorId }));
  const tickets = require("./tickets");
  const sent = await tickets.replyToTicket({ ticketId, authorId: actorId, text, client, programId: macro.program_id, requireOpen: guardOpen });
  if (sent.error) return sent;
  const transition = applySendTransition(macro, ticketId, actorId, client);
  if (transition?.error) return transition;
  db.addTicketEvent({ ticketId, programId: ticket.program_id, actorId, eventType: "macro_sent", detail: { macroId: id, trigger: macro.trigger } });
  audit.record({ programId: ticket.program_id, actorId, action: "macro.sent", entityType: "macro", entityId: id, metadata: { ticketId } });
  return { ok: true, ts: sent.ts, ticket: db.getTicket(ticketId) };
}

async function threadStarter(client, channel, threadTs) {
  if (!client?.conversations?.replies) return null;
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
    const parent = (res.messages || [])[0];
    return parent && !parent.bot_id ? parent.user || null : null;
  } catch (_) {
    return null;
  }
}

// A macro typed in a thread that has no ticket: there is no ticket to reply
// through or transition, so Pixie just posts the text into the thread.
// Program-wide queue numbers stand in for the ticket's own.
async function sendToThread({ id, program, channel, threadTs, actorId, client }) {
  const macro = get(id);
  if (!macro) return { error: "macro not found" };
  if (!macro.enabled) return { error: "macro is disabled" };
  if (!program || program.id !== macro.program_id) return { error: "program mismatch" };
  const allowed = macro.allowed_roles ? JSON.parse(macro.allowed_roles) : null;
  const role = actorRole(program.id, actorId);
  if (!role) return { error: "actor is not a helper of this program" };
  if (allowed && !allowed.includes(role)) return { error: `macro requires role: ${allowed.join("/")}` };

  const wait = require("./waitTime");
  const requesterId = await threadStarter(client, channel, threadTs);
  const text = interpolate(macro.content, {
    ...valuesFor({ program, actorId }),
    requester: requesterId ? `<@${requesterId}>` : "there",
    queue_depth: String(wait.queueDepth(program.id)),
    typical_wait: wait.formatWait(wait.estimate({ programId: program.id })) || "a little while",
    position: "",
  });
  let res;
  try {
    res = await require("./slackMessages").sendProgramMessage({ client, program, channel, threadTs, text });
  } catch (e) {
    return { error: e.message };
  }
  audit.record({ programId: program.id, actorId, action: "macro.sent", entityType: "macro", entityId: id, metadata: { channel, threadTs } });
  return { ok: true, ts: res?.ts || null };
}

function waitingTicketIds({ programId, category = null } = {}) {
  return db.getTicketsForProgram(programId, "waiting_for_helper")
    .filter((ticket) => !category || ticket.category === category)
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
    .map((ticket) => ticket.id);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBulk({ macroId, ticketIds, actorId, client, delayMs = BULK_DELAY_MS } = {}) {
  if (!Array.isArray(ticketIds)) return { error: "ticketIds must be an array" };
  if (ticketIds.length > BULK_MAX_TICKETS) return { error: `at most ${BULK_MAX_TICKETS} ticketIds may be sent at once` };
  const macro = get(Number(macroId));
  if (!macro) return { error: "macro not found" };
  if (!macro.enabled) return { error: "macro is disabled" };

  const sent = [];
  const skipped = [];
  const seen = new Set();
  for (let i = 0; i < ticketIds.length; i += 1) {
    const rawTicketId = ticketIds[i];
    const ticketId = Number(rawTicketId);
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      skipped.push({ ticketId: rawTicketId, reason: "invalid ticket id" });
    } else if (seen.has(ticketId)) {
      skipped.push({ ticketId, reason: "duplicate ticket id" });
    } else {
      seen.add(ticketId);
      const ticket = db.getTicket(ticketId);
      let result;
      if (!ticket) result = { error: "ticket not found" };
      else if (ticket.program_id !== macro.program_id) result = { error: "program mismatch" };
      else if (!OPEN_STATUSES.has(ticket.status)) result = { error: "ticket is not open" };
      else if (!actorRole(ticket.program_id, actorId)) result = { error: "actor is not a helper of this program" };
      else result = await send({ id: Number(macroId), ticketId, actorId, client, requireOpen: true });

      if (result && result.ok) sent.push(ticketId);
      else skipped.push({ ticketId, reason: result?.error || "send failed" });
    }
    if (i < ticketIds.length - 1 && delayMs > 0) await delay(delayMs);
  }
  return { sent, skipped };
}

module.exports = {
  sendToThread,
  create,
  get,
  list,
  update,
  remove,
  interpolate,
  normalizeTrigger,
  suggestFor,
  suggestedTemplates,
  placeholderDocs,
  waitingTicketIds,
  send,
  sendBulk,
  valuesFor,
};
