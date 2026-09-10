// Read-only observation of Pixl routing decisions. The recommendation is
// snapshotted once at escalation time so later helper state cannot rewrite it.
const db = require("./db");
const helperRoute = require("./helperRoute");

const EVENT_TYPE = "helper_routing_recommended";

function snapshotForTicket(ticket) {
  if (!ticket || ticket.program_id !== "pixl") return null;
  if (db.listTicketEvents(ticket.id).some((event) => event.event_type === EVENT_TYPE)) return null;
  const category = ticket.category || "general";
  const recommendations = helperRoute.recommend({ programId: ticket.program_id, category, limit: 5 });
  const candidates = recommendations.map((candidate, index) => {
    const expertise = helperRoute.getExpertise(ticket.program_id, candidate.userId);
    const categoryMatch = expertise.find((entry) => entry.tag === String(category).trim().toLowerCase()) || null;
    return {
      userId: candidate.userId,
      rank: index + 1,
      score: candidate.score,
      reasons: candidate.reasons,
      openLoad: candidate.load,
      role: candidate.role,
      expertiseMatches: categoryMatch ? [categoryMatch.tag] : [],
      observedCategoryResolutions: categoryMatch?.solved_count || 0,
    };
  });
  const detail = { mode: "shadow", category, candidates };
  const eventId = db.addTicketEvent({ ticketId: ticket.id, programId: ticket.program_id, eventType: EVENT_TYPE, detail });
  return eventId ? { eventId, detail } : null;
}

function parseDetail(detail) {
  try {
    return detail ? JSON.parse(detail) : {};
  } catch (_) {
    return {};
  }
}

function list(programId = "pixl", limit = 20) {
  const rows = db.handle().query(
    `SELECT e.id AS event_id, e.ticket_id, e.program_id, e.detail, e.created_at AS recommended_at,
            t.category, t.created_at, t.assignee_id, t.resolved_by, t.resolved_at, t.reopen_count, t.status
       FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id AND t.program_id = e.program_id
      WHERE e.program_id = ? AND e.event_type = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
  ).all(programId, EVENT_TYPE, Math.min(Math.max(Number(limit) || 20, 1), 100));
  return rows.map((row) => {
    const events = db.listTicketEvents(row.ticket_id).filter((event) => event.program_id === programId);
    const replies = events.filter((event) => event.event_type === "helper_reply" && event.actor_id);
    const resolved = events.filter((event) => event.event_type === "resolved" && event.actor_id);
    const detail = parseDetail(row.detail);
    const top = detail.candidates?.[0] || null;
    return {
      eventId: row.event_id,
      ticketId: row.ticket_id,
      programId: row.program_id,
      category: detail.category || row.category || "general",
      createdAt: row.created_at,
      recommendedAt: row.recommended_at,
      mode: detail.mode || "shadow",
      candidates: detail.candidates || [],
      actualResponder: replies.at(-1)?.actor_id || null,
      actualResolver: resolved.at(-1)?.actor_id || row.resolved_by || null,
      top1MatchedResolver: Boolean(top && (resolved.at(-1)?.actor_id || row.resolved_by) === top.userId),
      top3ContainsResolver: Boolean((resolved.at(-1)?.actor_id || row.resolved_by) && detail.candidates?.slice(0, 3).some((candidate) => candidate.userId === (resolved.at(-1)?.actor_id || row.resolved_by))),
      resolvedAt: row.resolved_at,
      reopened: (row.reopen_count || 0) > 0,
      status: row.status,
      assigneeId: row.assignee_id,
    };
  });
}

module.exports = { EVENT_TYPE, snapshotForTicket, list };
