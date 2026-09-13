"use strict";

const log = require("../log");
const { createLegacyPersistence } = require("./persistence-legacy");
const { tenantPredicate } = require("./ticket-domain");

function json(value) {
  return value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);
}

function clampLimit(limit, def = 100, max = 500) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

// WHY: same packing as lib/audit.js — objects stringify once here, strings
// pass through, failures yield null so an audit write never breaks its caller.
function packAuditMetadata(metadata) {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata === "string") return metadata;
  try {
    return JSON.stringify(metadata);
  } catch (_) {
    return null;
  }
}

function packAuditEntityId(entityId) {
  if (entityId === null || entityId === undefined) return null;
  return String(entityId);
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
    return db().query(`SELECT e.* FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE e.ticket_id = ? AND t.${tenant.sql} ORDER BY e.created_at ASC, e.id ASC LIMIT ?`).all(ticketId, ...tenant.params, clampLimit(limit));
  }
  function writeEvent(ticket, eventType, actorId = null, detail = null) {
    return persistence.raw.handle().query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ticket.id, ticket.program_id, actorId, eventType, json(detail), now()).changes > 0;
  }
  // Exact port of db.addTicketEvent: string details pass through, objects
  // stringify once, null stays null. Returns the row id (or null).
  function addEvent({ ticketId, programId, actorId = null, eventType, detail = null } = {}) {
    const existing = db().query("SELECT * FROM tickets WHERE id = ?").get(ticketId);
    if (!existing || existing.program_id !== programId) return null;
    const d = detail === null || detail === undefined ? null : (typeof detail === "string" ? detail : JSON.stringify(detail));
    const res = db().query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ticketId, programId, actorId, eventType, d, now());
    return res.changes > 0 ? Number(res.lastInsertRowid) : null;
  }
  // Exact port of db.addTicketNote / db.listTicketNotes, tenant-guarded the
  // same way events() is: the ticket must exist in (programId, workspaceId)
  // or the call misses instead of leaking across tenants.
  function addNote(id, programId, workspaceId, authorId, body) {
    const ticket = get(id, programId, workspaceId);
    if (!ticket) return { ok: false, reason: "not_found", ticket: null };
    const clean = String(body || "").trim();
    if (!clean) return { ok: false, reason: "note_body_required", ticket };
    const res = db().query(
      "INSERT INTO ticket_notes (ticket_id, program_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(ticket.id, ticket.program_id, authorId, clean, now());
    if (!(res.changes > 0)) return { ok: false, reason: "not_saved", ticket };
    return { ok: true, reason: "allowed", ticket, noteId: Number(res.lastInsertRowid) };
  }
  function notes(id, programId, workspaceId, limit = 100) {
    if (!programId) return [];
    const ticket = get(id, programId, workspaceId);
    if (!ticket) return [];
    return db().query(
      "SELECT id, ticket_id, program_id, author_id, body, created_at FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at ASC LIMIT ?",
    ).all(ticket.id, clampLimit(limit));
  }
  // Exact ports of db.listHelpers / db.isHelper (same SQL, same ordering,
  // same falsy guard). Membership is program-scoped only — workspaces never
  // filter helpers, matching isActorAllowed in lib/tickets.js.
  function helpers(programId, activeOnly = true) {
    if (activeOnly) {
      return db().query("SELECT * FROM program_helpers WHERE program_id = ? AND active = 1 ORDER BY added_at ASC").all(programId);
    }
    return db().query("SELECT * FROM program_helpers WHERE program_id = ? ORDER BY added_at ASC").all(programId);
  }
  function isHelper(programId, userId) {
    if (!programId || !userId) return false;
    return !!db().query("SELECT 1 FROM program_helpers WHERE program_id = ? AND user_id = ? AND active = 1").get(programId, userId);
  }
  // Exact port of audit.record -> db.recordAuditEvent: missing action yields
  // null, entity ids stringify, metadata packs once, failures yield null so
  // the audit write never breaks the ticket action it records.
  function recordAudit({ programId = null, actorId = null, action, entityType = null, entityId = null, metadata = null } = {}) {
    if (!action) return null;
    try {
      const res = db().query(
        "INSERT INTO audit_events (program_id, actor_id, action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(programId, actorId, action, entityType, packAuditEntityId(entityId), packAuditMetadata(metadata), now());
      return res.changes > 0 ? Number(res.lastInsertRowid) : null;
    } catch (e) {
      log.warn("tickets", `audit write failed: ${e.message}`);
      return null;
    }
  }
  function result(ticket, transition, ok, reason = ok ? "allowed" : "already_applied") {
    return { ok, transition, reason, ticket: ok ? get(ticket.id, ticket.program_id, ticket.workspace_id) : ticket };
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
      reopenResolved: { sql: `${base}, status = 'reopened', resolution = NULL, resolved_at = NULL, resolved_by = NULL, reopened_by = ?, reopened_at = ?, reopen_count = COALESCE(reopen_count, 0) + 1 WHERE ${w.sql} AND status IN ('resolved', 'closed')`, params: [t, actorId, t, ...w.params], event: "reopened" },
      close: { sql: `${base}, status = 'closed', resolved_at = ? WHERE ${w.sql}`, params: [t, t, ...w.params], event: "closed" },
      snooze: { sql: `${base}, status = 'snoozed', snoozed_until = ? WHERE ${w.sql}`, params: [t, args.untilMs, ...w.params], event: "snoozed" },
      duplicate: { sql: `${base}, status = 'duplicate', duplicate_of = ? WHERE ${w.sql}`, params: [t, args.canonicalTicketId, ...w.params], event: "duplicate" },
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
      let ticket = db().query("SELECT * FROM tickets WHERE id = ?").get(Number(row.lastInsertRowid)) || null;
      if (!ticket) {
        if (input.workspaceId !== null && input.workspaceId !== undefined) {
          ticket = db().query("SELECT * FROM tickets WHERE thread_ts = ? AND workspace_id = ? AND program_id = ? LIMIT 1").get(input.threadTs, input.workspaceId, input.programId) || null;
        }
        if (!ticket) ticket = db().query("SELECT * FROM tickets WHERE thread_ts = ? AND program_id = ? LIMIT 1").get(input.threadTs, input.programId) || null;
      }
      if (ticket && row.changes > 0) writeEvent(ticket, "created", input.actorId || null);
      return ticket;
    },
    get,
    getByThreadTs(threadTs, programId, workspaceId) {
      if (!programId) return null;
      if (workspaceId !== null && workspaceId !== undefined) {
        const scoped = db().query("SELECT * FROM tickets WHERE thread_ts = ? AND workspace_id = ? AND program_id = ? LIMIT 1").get(threadTs, workspaceId, programId);
        if (scoped) return scoped;
      }
      return db().query("SELECT * FROM tickets WHERE thread_ts = ? AND program_id = ? LIMIT 1").get(threadTs, programId) || null;
    },
    list(programId, workspaceId, status = null) {
      if (!programId) return [];
      if (workspaceId === null || workspaceId === undefined) {
        const extra = status ? " AND status = ?" : "";
        return db().query(`SELECT * FROM tickets WHERE program_id = ?${extra} ORDER BY created_at DESC`).all(programId, ...(status ? [status] : []));
      }
      const tenant = tenantPredicate(programId, workspaceId);
      const extra = status ? " AND status = ?" : "";
      return db().query(`SELECT * FROM tickets WHERE ${tenant.sql}${extra} ORDER BY created_at DESC`).all(...tenant.params, ...(status ? [status] : []));
    },
    events,
    addEvent,
    addNote,
    notes,
    helpers,
    isHelper,
    recordAudit,
    transition,
    claim: (id, p, w, actorId) => transition(id, p, w, "claim", actorId),
    assign: (id, p, w, actorId, assigneeId) => transition(id, p, w, "assign", actorId, { assigneeId }),
    unclaim: (id, p, w, actorId) => transition(id, p, w, "unclaim", actorId),
    resolve: (id, p, w, actorId, resolution) => transition(id, p, w, "resolve", actorId, { resolution }),
    reopen: (id, p, w, actorId) => transition(id, p, w, "reopen", actorId),
    close: (id, p, w, actorId) => transition(id, p, w, "close", actorId),
    snooze: (id, p, w, actorId, untilMs) => transition(id, p, w, "snooze", actorId, { untilMs }),
    duplicate: (id, p, w, actorId, canonicalTicketId) => transition(id, p, w, "duplicate", actorId, { canonicalTicketId }),
    reopenResolved: (id, p, w, actorId) => transition(id, p, w, "reopenResolved", actorId),
    cardTs(id, p, w, cardTs) {
      const ticket = get(id, p, w);
      if (!ticket) return false;
      return db().query("UPDATE tickets SET card_ts = ? WHERE id = ? AND card_ts IS NULL").run(cardTs, id).changes > 0;
    },
    ackTs(id, p, w, ackTs) {
      const ticket = get(id, p, w);
      if (!ticket) return false;
      return db().query("UPDATE tickets SET public_ack_ts = ? WHERE id = ? AND public_ack_ts IS NULL").run(ackTs, id).changes > 0;
    },
    triage(id, p, w, patch = {}) {
      const ticket = get(id, p, w);
      if (!ticket) return false;
      const decision = patch.aiDecision === null || patch.aiDecision === undefined ? null : (typeof patch.aiDecision === "string" ? patch.aiDecision : JSON.stringify(patch.aiDecision));
      return db().query(
        "UPDATE tickets SET category = COALESCE(?, category), priority = COALESCE(?, priority), summary = COALESCE(?, summary), ai_confidence = COALESCE(?, ai_confidence), ai_decision = COALESCE(?, ai_decision), updated_at = ? WHERE id = ?",
      ).run(patch.category ?? null, patch.priority ?? null, patch.summary ?? null, patch.aiConfidence ?? null, decision, now(), id).changes > 0;
    },
    firstResponse(id, p, w, human = false) {
      const ticket = get(id, p, w);
      if (!ticket) return false;
      const t = now();
      if (human) {
        return db().query(
          "UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?), first_human_response_at = COALESCE(first_human_response_at, ?), updated_at = ? WHERE id = ?",
        ).run(t, t, t, id).changes > 0;
      }
      return db().query(
        "UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ? AND first_response_at IS NULL",
      ).run(t, t, id).changes > 0;
    },
    search(options = {}) {
      if (!options.programId) return { total: 0, rows: [] };
      return db().query ? require("../db").searchTickets(options) : { total: 0, rows: [] };
    },
    ticketsForProgram(programId, status = null) {
      if (!programId) return [];
      return require("../db").getTicketsForProgram(programId, status);
    },
    escalate: (id, p, w, actorId) => transition(id, p, w, "escalate", actorId),
    waiting: (id, p, w, actorId) => transition(id, p, w, "waiting", actorId),
  };
}

module.exports = { createTicketRepository };
