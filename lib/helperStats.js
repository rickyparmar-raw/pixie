// Program-scoped helper performance reporting. This module only reads the
// existing ticket/event/feedback rows; routing remains owned by helperRoute.
const db = require("./db");
const assignmentLifecycle = require("./assignmentLifecycle");
const { resolveTicketWorker } = require("./tickets");

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

function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function helperStats(programId, userId, { recentLimit = 20 } = {}) {
  const helper = db.listHelpers(programId, false).find((row) => row.user_id === userId) || null;
  if (!helper) return null;
  const limit = Number.isInteger(recentLimit) && recentLimit > 0 ? Math.min(recentLimit, 100) : 20;
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
  const resolutions = events
    .filter((event) => event.event_type === "resolved")
    .map((event) => ({ event, ticket: byId.get(event.ticket_id) }))
    .filter(({ event, ticket }) => ticket && resolveTicketWorker(ticket, event.actor_id) === userId)
    .map(({ event }) => event);
  const involvedIds = new Set([
    ...assignments.map((event) => event.ticket_id),
    ...replies.map((event) => event.ticket_id),
    ...resolutions.map((event) => event.ticket_id),
  ]);
  for (const ticket of tickets) {
    if (ticket.assignee_id === userId || ticket.resolved_by === userId) involvedIds.add(ticket.id);
  }

  const open = tickets.filter((ticket) => ticket.assignee_id === userId && OPEN_STATUSES.includes(ticket.status));
  const reopened = events.filter((event) => event.event_type === "reopened");
  const reopenedResolutionTickets = new Set();
  for (const resolution of resolutions) {
    if (reopened.some((event) => event.ticket_id === resolution.ticket_id && event.created_at > resolution.created_at)) {
      reopenedResolutionTickets.add(resolution.ticket_id);
    }
  }
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
  const responseDurations = [...firstReplies.values()].map((event) => {
    const ticket = byId.get(event.ticket_id);
    const created = timestamp(ticket?.created_at);
    const response = timestamp(event.created_at);
    return created !== null && response !== null ? response - created : null;
  });
  const resolutionDurations = resolutions.map((event) => {
    const ticket = byId.get(event.ticket_id);
    const created = timestamp(ticket?.created_at);
    const resolved = timestamp(event.created_at);
    return created !== null && resolved !== null ? resolved - created : null;
  });
  const categoryResolved = Object.entries(resolutions.reduce((counts, event) => {
    const category = byId.get(event.ticket_id)?.category || "general";
    counts[category] = (counts[category] || 0) + 1;
    return counts;
  }, {})).map(([category, resolved]) => ({ category, resolved }));
  const recentTickets = [...involvedIds].map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at))
    .slice(0, limit)
    .map((ticket) => ({
      id: ticket.id,
      category: ticket.category || "general",
      status: ticket.status,
      assignedAt: ticket.assigned_at,
      firstResponseAt: firstReplies.get(ticket.id)?.created_at || null,
      resolvedAt: resolutions.find((event) => event.ticket_id === ticket.id)?.created_at || null,
      reopened: reopened.some((event) => event.ticket_id === ticket.id),
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
      assigned: new Set(assignments.map((event) => event.ticket_id)).size,
      resolved: new Set(resolutions.map((event) => event.ticket_id)).size,
      open: open.length,
      reopened: reopenedResolutionTickets.size,
    },
    reopenRate: rate(reopenedResolutionTickets.size, new Set(resolutions.map((event) => event.ticket_id)).size),
    medianFirstResponseMs: median(responseDurations),
    medianResolutionMs: median(resolutionDurations),
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

function listHelperStats(programId, { recentLimit = 20 } = {}) {
  return db.listHelpers(programId, true).map((helper) => helperStats(programId, helper.user_id, { recentLimit }));
}

module.exports = { helperStats, listHelperStats, median, rate };
