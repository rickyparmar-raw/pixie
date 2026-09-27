// Program-scoped helper performance reporting. This module only reads the
// existing ticket/event/feedback rows; routing remains owned by helperRoute.
const db = require("./db");
const assignmentLifecycle = require("./assignmentLifecycle");
const ticketMetrics = require("./ticketMetrics");

const OPEN_STATUSES = ["claimed", "assigned", "waiting_for_helper", "escalated", "reopened"];

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
}

function detail(row) {
  if (!row) return {};
  try {
    return row.detail ? JSON.parse(row.detail) : {};
  } catch (_) {
    return {};
  }
}

function helperStats(programId, userId, { recentLimit = 20, since = 0 } = {}) {
  const helper = db.listHelpers(programId, false).find((row) => row.user_id === userId) || null;
  if (!helper) return null;
  const limit = Number.isInteger(recentLimit) && recentLimit > 0 ? Math.min(recentLimit, 100) : 20;
  const totals = ticketMetrics.helperTotals(programId, userId, { since });
  const tickets = db.handle().query("SELECT * FROM tickets WHERE program_id = ?").all(programId);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const events = db.handle().query(
    "SELECT * FROM ticket_events WHERE program_id = ? ORDER BY created_at ASC, id ASC",
  ).all(programId).map((event) => ({ ...event, detail: detail(event) }));
  const assignments = events.filter((event) =>
    (event.event_type === "claimed" && event.actor_id === userId) ||
    (event.event_type === "assigned" && event.detail.to === userId),
  );
  const replies = events.filter((event) => event.event_type === "helper_reply" && event.actor_id === userId);
  const resolutions = db.handle().query(
    `SELECT t.* FROM tickets t
     WHERE t.program_id = ? AND t.status = 'resolved' AND t.resolved_at IS NOT NULL
       AND t.resolved_at >= ? AND ${ticketMetrics.CREDIT_SQL} = ?`,
  ).all(programId, Number(since) || 0, userId);
  const involvedIds = new Set([
    ...assignments.map((event) => event.ticket_id),
    ...replies.map((event) => event.ticket_id),
    ...resolutions.map((ticket) => ticket.id),
  ]);
  for (const ticket of tickets) {
    if (ticket.assignee_id === userId || ticket.resolved_by === userId) involvedIds.add(ticket.id);
  }

  const open = tickets.filter((ticket) => ticket.assignee_id === userId && OPEN_STATUSES.includes(ticket.status));
  const feedbackKeys = new Set();
  let helpful = 0;
  let unhelpful = 0;
  for (const reply of replies) {
    const messageTs = reply.detail.ts;
    if (!messageTs) continue;
    const rows = db.handle().query("SELECT user_id, vote FROM feedback WHERE message_ts = ?").all(messageTs);
    for (const row of rows) {
      const key = `${messageTs}:${row.user_id}`;
      if (feedbackKeys.has(key)) continue;
      feedbackKeys.add(key);
      if (row.vote > 0) helpful += 1;
      if (row.vote < 0) unhelpful += 1;
    }
  }
  const firstReplies = new Map();
  for (const reply of replies) {
    if (!firstReplies.has(reply.ticket_id)) firstReplies.set(reply.ticket_id, reply);
  }
  const categoryResolved = totals.categoryResolved;
  const recentTickets = [...involvedIds].map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at))
    .slice(0, limit)
    .map((ticket) => ({
      id: ticket.id,
      category: ticket.category || "general",
      status: ticket.status,
      assignedAt: ticket.assigned_at,
      firstResponseAt: firstReplies.get(ticket.id)?.created_at || null,
      resolvedAt: resolutions.find((resolved) => resolved.id === ticket.id)?.resolved_at || null,
      reopened: (ticket.reopen_count || 0) > 0,
    }));
  const lastActivity = events.filter((event) => event.actor_id === userId || assignments.includes(event)).at(-1)?.created_at || null;

  // Explicit assignment lifecycle (offered/claimed/declined/released/timed_out).
  // acceptRate stays null until enough offers have reached a terminal state —
  // it is never inferred from pre-lifecycle tickets. See lib/assignmentLifecycle.
  const accept = assignmentLifecycle.helperAcceptStats(programId, userId);

  return {
    programId,
    userId,
    role: helper.role,
    active: Boolean(helper.active),
    expertise: db.handle().query(
      `SELECT tag, solved_count, reply_count FROM helper_expertise
       WHERE program_id = ? AND user_id = ? ORDER BY solved_count DESC, reply_count DESC, tag ASC`,
    ).all(programId, userId),
    categoryResolved,
    totals: {
      assigned: totals.assigned,
      resolved: totals.resolved,
      open: totals.open,
      reopened: totals.reopened,
    },
    reopenRate: totals.reopenRate,
    replies: totals.replies,
    medianFirstResponseMs: totals.medianFirstResponseMs,
    medianResolutionMs: totals.medianResolutionMs,
    helpfulCount: helpful,
    unhelpfulCount: unhelpful,
    helpfulPercentage: rate(helpful, helpful + unhelpful),
    lastActivity,
    acceptRate: accept.acceptRate,
    assignmentLifecycle: accept.assignmentLifecycle,
    assignments: {
      offered: accept.offered,
      claimed: accept.acceptedAssignments,
      declined: accept.declinedAssignments,
      released: accept.releasedAssignments,
      timedOut: accept.timedOutAssignments,
      completedOffers: accept.completedOffers,
    },
    recentTickets,
  };
}

function listHelperStats(programId, { recentLimit = 20, since = 0 } = {}) {
  return db.listHelpers(programId, false).map((helper) => helperStats(programId, helper.user_id, { recentLimit, since }));
}

module.exports = { helperStats, listHelperStats, median, rate };
