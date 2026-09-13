"use strict";

const { createLegacyPersistence } = require("./persistence-legacy");
const { tenantPredicate } = require("./ticket-domain");

function json(value) {
  return value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);
}

function createTicketRepository({ persistence = createLegacyPersistence() } = {}) {
  const raw = persistence.raw;
  if (!raw || typeof raw.handle !== "function") throw new TypeError("ticket repository requires raw persistence");

  function db() { return raw.handle(); }
  function now() { return typeof persistence.tickets?.now === "function" ? persistence.tickets.now() : Date.now(); }
  function where(id, programId, workspaceId) {
    const tenant = tenantPredicate(programId, workspaceId);
    return { sql: `id = ? AND ${tenant.sql}`, params: [id, ...tenant.params] };
  }
  function get(id, programId, workspaceId) {
    if (!programId) return null;
    const w = where(id, programId, workspaceId);
    return db().query(`SELECT * FROM tickets WHERE ${w.sql}`).get(...w.params) || null;
  }
  function events(ticketId, programId, workspaceId, limit = 100) {
    if (!programId) return [];
    const tenant = tenantPredicate(programId, workspaceId);
    return db().query(`SELECT e.* FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE e.ticket_id = ? AND t.${tenant.sql} ORDER BY e.created_at ASC, e.id ASC LIMIT ?`).all(ticketId, ...tenant.params, limit);
  }
  function writeEvent(ticket, eventType, actorId = null, detail = null) {
    return persistence.raw.handle().query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ticket.id, ticket.program_id, actorId, eventType, json(detail), now()).changes > 0;
  }
  function result(ticket, transition, ok, reason = ok ? "allowed" : "already_applied") {
    return { ok, transition, reason, ticket: ok ? get(ticket.id, ticket.program_id, ticket.workspace_id) : ticket };
  }
  function update(ticket, transition, sql, params, eventType = transition, detail = null) {
    const changed = db().query(sql).run(...params).changes > 0;
    if (!changed) return result(ticket, transition, false);
    const updated = get(ticket.id, ticket.program_id, ticket.workspace_id);
    writeEvent(updated, eventType, params.actorId || null, detail);
    return result(updated, transition, true);
  }
  function transition(id, programId, workspaceId, transitionName, actorId, args = {}) {
    const ticket = get(id, programId, workspaceId);
    if (!ticket) return { ok: false, transition: transitionName, reason: "not_found", ticket: null };
    const t = now();
    const w = where(id, programId, workspaceId);
    const base = "UPDATE tickets SET updated_at = ?";
    const calls = {
      claim: { sql: `${base}, status = 'claimed', assignee_id = ?, claimed_at = ?, assigned_at = ? WHERE ${w.sql} AND status IN ('open', 'waiting_for_helper')`, params: [t, actorId, t, t, ...w.params], event: "claimed" },
      assign: { sql: `${base}, status = 'assigned', assignee_id = ?, assigned_at = ? WHERE ${w.sql} AND status IN ('open', 'claimed', 'assigned', 'waiting_for_helper', 'escalated', 'reopened')`, params: [t, args.assigneeId, t, ...w.params], event: "assigned" },
      unclaim: { sql: `${base}, status = 'open', assignee_id = NULL, claimed_at = NULL WHERE ${w.sql}`, params: [t, ...w.params], event: "unclaimed" },
      resolve: { sql: `${base}, status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ?, first_response_at = COALESCE(first_response_at, ?) WHERE ${w.sql} AND status NOT IN ('resolved', 'closed')`, params: [t, args.resolution || "resolved", actorId, t, t, ...w.params], event: "resolved" },
      reopen: { sql: `${base}, status = 'reopened', resolution = NULL, resolved_at = NULL, resolved_by = NULL, reopened_by = ?, reopened_at = ?, reopen_count = COALESCE(reopen_count, 0) + 1 WHERE ${w.sql}`, params: [t, actorId, t, ...w.params], event: "reopened" },
      close: { sql: `${base}, status = 'closed', resolved_at = ? WHERE ${w.sql}`, params: [t, t, ...w.params], event: "closed" },
      snooze: { sql: `${base}, status = 'snoozed', snoozed_until = ? WHERE ${w.sql}`, params: [t, args.untilMs, ...w.params], event: "snoozed" },
      duplicate: { sql: `${base}, status = 'duplicate', duplicate_of = ? WHERE ${w.sql} AND status NOT IN ('resolved', 'closed', 'duplicate')`, params: [t, args.canonicalTicketId, ...w.params], event: "duplicate" },
      escalate: { sql: `${base}, status = 'escalated' WHERE ${w.sql}`, params: [t, ...w.params], event: "escalated" },
      waiting: { sql: `${base}, status = 'waiting_for_helper' WHERE ${w.sql} AND status IN ('open', 'reopened', 'escalated')`, params: [t, ...w.params], event: "waiting_for_helper" },
    }[transitionName];
    if (!calls) return { ok: false, transition: transitionName, reason: "invalid_transition", ticket };
    const changed = db().query(calls.sql).run(...calls.params).changes > 0;
    if (!changed) return result(ticket, transitionName, false);
    const updated = get(id, programId, workspaceId);
    writeEvent(updated, calls.event, actorId, args.detail);
    return result(updated, transitionName, true);
  }
  return {
    create(input) {
      const t = now();
      const row = db().query(`INSERT OR IGNORE INTO tickets (program_id, workspace_id, channel, thread_ts, requester_id, question, category, priority, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .run(input.programId, input.workspaceId ?? null, input.channel, input.threadTs, input.requesterId, input.question, input.category ?? null, input.priority ?? null, input.summary ?? null, t, t);
      const ticket = db().query("SELECT * FROM tickets WHERE id = ?").get(Number(row.lastInsertRowid)) || db().query("SELECT * FROM tickets WHERE thread_ts = ? AND workspace_id IS ? AND program_id = ? LIMIT 1").get(input.threadTs, input.workspaceId ?? null, input.programId) || null;
      if (ticket && row.changes > 0) writeEvent(ticket, "created", input.actorId || null);
      return ticket;
    },
    get,
    getByThreadTs(threadTs, programId, workspaceId) {
      if (!programId) return null;
      const tenant = tenantPredicate(programId, workspaceId);
      return db().query(`SELECT * FROM tickets WHERE thread_ts = ? AND ${tenant.sql} LIMIT 1`).get(threadTs, ...tenant.params) || null;
    },
    list(programId, workspaceId, status = null) {
      if (!programId) return [];
      const tenant = tenantPredicate(programId, workspaceId);
      const extra = status ? " AND status = ?" : "";
      return db().query(`SELECT * FROM tickets WHERE ${tenant.sql}${extra} ORDER BY created_at DESC`).all(...tenant.params, ...(status ? [status] : []));
    },
    events,
    transition,
    claim: (id, p, w, actorId) => transition(id, p, w, "claim", actorId),
    assign: (id, p, w, actorId, assigneeId) => transition(id, p, w, "assign", actorId, { assigneeId }),
    unclaim: (id, p, w, actorId) => transition(id, p, w, "unclaim", actorId),
    resolve: (id, p, w, actorId, resolution) => transition(id, p, w, "resolve", actorId, { resolution }),
    reopen: (id, p, w, actorId) => transition(id, p, w, "reopen", actorId),
    close: (id, p, w, actorId) => transition(id, p, w, "close", actorId),
    snooze: (id, p, w, actorId, untilMs) => transition(id, p, w, "snooze", actorId, { untilMs }),
    duplicate: (id, p, w, actorId, canonicalTicketId) => transition(id, p, w, "duplicate", actorId, { canonicalTicketId }),
    escalate: (id, p, w, actorId) => transition(id, p, w, "escalate", actorId),
    waiting: (id, p, w, actorId) => transition(id, p, w, "waiting", actorId),
  };
}

module.exports = { createTicketRepository };
