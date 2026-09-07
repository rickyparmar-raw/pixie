// Program-scoped support macros (?shipping). Organizers define approved
// templates; helpers search/preview/send them from the dashboard. Templates
// interpolate a fixed safe value set — requester, ticket, program, status,
// helper — by plain token replacement. Unknown tokens stay literal (visible,
// never executed), and there is no expression evaluation of any kind.
const db = require("./db");
const audit = require("./audit");

const TRIGGER_RE = /^[?!][a-z0-9][a-z0-9_-]{0,30}$/;
const SAFE_KEYS = new Set(["requester", "ticket_id", "program", "status", "helper"]);

function normalizeTrigger(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!TRIGGER_RE.test(t)) return null;
  return t;
}

function interpolate(content, values = {}) {
  return String(content || "").replace(/\{([a-z_]+)\}/g, (match, key) => {
    if (!SAFE_KEYS.has(key)) return match;
    const v = values[key];
    return v === null || v === undefined ? match : String(v);
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

function validate({ trigger, name, content, onSendTransition = null }) {
  if (!normalizeTrigger(trigger)) return "trigger must look like ?shipping (lowercase, ?/! prefix)";
  if (!String(name || "").trim() || String(name).length > 80) return "name required (max 80 chars)";
  if (!String(content || "").trim() || String(content).length > 2000) return "content required (max 2000 chars)";
  const allowed = new Set(["resolved", "closed", "snoozed", null, undefined, ""]);
  if (!allowed.has(onSendTransition)) return "invalid on-send transition";
  return null;
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
    if (String(e.message || "").includes("UNIQUE")) return { error: "that trigger already exists for this program" };
    return { error: e.message };
  }
}

function now() {
  return Date.now();
}

function get(id) {
  return db.handle().query("SELECT * FROM program_macros WHERE id = ?").get(id) || null;
}

function list(programId, { enabledOnly = false, q = null } = {}) {
  let rows = db.handle().query("SELECT * FROM program_macros WHERE program_id = ? ORDER BY trigger ASC").all(programId);
  if (enabledOnly) rows = rows.filter((r) => r.enabled);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => r.trigger.includes(needle) || (r.name || "").toLowerCase().includes(needle) || (r.description || "").toLowerCase().includes(needle));
  }
  return rows;
}

function update(id, patch = {}, actorId = null) {
  const row = get(id);
  if (!row) return { error: "macro not found" };
  if (patch.trigger !== undefined) {
    const t = normalizeTrigger(patch.trigger);
    if (!t) return { error: "invalid trigger" };
    patch = { ...patch, trigger: t };
  }
  if (patch.content !== undefined && (!String(patch.content).trim() || String(patch.content).length > 2000)) {
    return { error: "invalid content" };
  }
  const merged = { ...row, ...patch, updated_at: now() };
  const problem = validate({ trigger: merged.trigger, name: merged.name, content: merged.content, onSendTransition: merged.on_send_transition });
  if (problem) return { error: problem };
  try {
    db.handle().query(
      `UPDATE program_macros SET trigger = ?, name = ?, description = ?, content = ?, enabled = ?, allowed_roles = ?, on_send_transition = ?, updated_at = ? WHERE id = ?`,
    ).run(merged.trigger, merged.name, merged.description, merged.content, merged.enabled ? 1 : 0,
      merged.allowed_roles, merged.on_send_transition, merged.updated_at, id);
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) return { error: "that trigger already exists for this program" };
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

// Keyword-overlap suggestion for the copilot draft path. Ranked, never
// auto-applied, and permissions still gate the actual send.
function suggestFor({ programId, question, limit = 3 }) {
  const enabled = list(programId, { enabledOnly: true });
  if (!question || enabled.length === 0) return [];
  const retrieve = require("./retrieve");
  const qterms = new Set(retrieve.tokenize(question));
  if (qterms.size === 0) return [];
  return enabled
    .map((m) => {
      const hay = new Set(retrieve.tokenize(`${m.trigger} ${m.name} ${m.description || ""} ${m.content}`.slice(0, 500)));
      let overlap = 0;
      for (const t of qterms) {
        if (hay.has(t)) overlap += 1;
      }
      return { id: m.id, trigger: m.trigger, name: m.name, description: m.description, score: Number((overlap / qterms.size).toFixed(3)) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function send({ id, ticketId, actorId, client }) {
  const macro = get(id);
  if (!macro) return { error: "macro not found" };
  if (!macro.enabled) return { error: "macro is disabled" };
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.program_id !== macro.program_id) return { error: "program mismatch" };
  const { isAdmin } = require("./config");
  const allowed = macro.allowed_roles ? JSON.parse(macro.allowed_roles) : null;
  const role = isAdmin(actorId) ? "admin" : db.isHelper(ticket.program_id, actorId) ? "helper" : null;
  if (!role) return { error: "actor is not a helper of this program" };
  if (allowed && !allowed.includes(role)) return { error: `macro requires role: ${allowed.join("/")}` };

  const programs = require("./programs");
  const text = interpolate(macro.content, valuesFor({ ticket, program: programs.get(ticket.program_id), actorId }));
  const tickets = require("./tickets");
  const sent = await tickets.replyToTicket({ ticketId, authorId: actorId, text, client });
  if (sent.error) return sent;
  if (macro.on_send_transition === "resolved") db.resolveTicket(ticketId, `resolved via macro ${macro.trigger}`, actorId);
  else if (macro.on_send_transition === "closed") db.closeTicket(ticketId);
  else if (macro.on_send_transition === "snoozed") db.snoozeTicket(ticketId, Date.now() + 24 * 60 * 60 * 1000);
  db.addTicketEvent({ ticketId, programId: ticket.program_id, actorId, eventType: "macro_sent", detail: { macroId: id, trigger: macro.trigger } });
  audit.record({ programId: ticket.program_id, actorId, action: "macro.sent", entityType: "macro", entityId: id, metadata: { ticketId } });
  return { ok: true, ts: sent.ts, ticket: db.getTicket(ticketId) };
}

module.exports = {
  create,
  get,
  list,
  update,
  remove,
  interpolate,
  normalizeTrigger,
  suggestFor,
  send,
  valuesFor,
};
