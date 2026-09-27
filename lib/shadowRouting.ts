// Shadow only
import db = require("./db");

const EVENT_TYPE = "helper_routing_recommended";

interface ShadowTicket {
  id: number;
  program_id: string;
  category?: string | null;
}

interface Recommendation {
  userId: string;
  score: number;
  reasons: string[];
  load: number;
  role: string;
}

interface ExpertiseRow {
  tag: string;
  solved_count: number;
}
interface ShadowCandidate extends Recommendation {
  rank: number;
  openLoad: number;
  expertiseMatches: string[];
  observedCategoryResolutions: number;
}
interface ShadowDetail {
  mode?: string;
  category?: string;
  candidates?: ShadowCandidate[];
}
interface ShadowRow {
  event_id: number;
  ticket_id: number;
  program_id: string;
  detail: string | null;
  recommended_at: number;
  category: string | null;
  created_at: number;
  assignee_id: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  reopen_count: number;
  status: string;
}

interface HelperRouteApi {
  recommend(options: { programId: string; category?: string | null; limit?: number }): Recommendation[];
  getExpertise(programId: string, userId: string): ExpertiseRow[];
}

const helperRoute = require("./helperRoute") as HelperRouteApi;

function snapshotForTicket(ticket: ShadowTicket | null) {
  if (!ticket || !ticket.program_id) return null;
  if (db.listTicketEvents(ticket.id).some((event) => event.event_type === EVENT_TYPE)) return null;
  const category = ticket.category || "general";
  const recommendations: Recommendation[] = helperRoute.recommend({ programId: ticket.program_id, category, limit: 5 });
  const candidates = recommendations.map((candidate, index) => {
    const expertise = helperRoute.getExpertise(ticket.program_id, candidate.userId);
    const categoryMatch =
      expertise.find((entry: ExpertiseRow) => entry.tag === String(category).trim().toLowerCase()) || null;
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
  const eventId = db.addTicketEvent({
    ticketId: ticket.id,
    programId: ticket.program_id,
    eventType: EVENT_TYPE,
    detail,
  });
  return eventId ? { eventId, detail } : null;
}

function parseDetail(detail: string | null): ShadowDetail {
  try {
    return detail ? JSON.parse(detail) : {};
  } catch {
    return {};
  }
}

function list(programId: string | null = null, limit = 20) {
  if (!programId) return [];
  const rows = db
    .handle()
    .query(
      `SELECT e.id AS event_id, e.ticket_id, e.program_id, e.detail, e.created_at AS recommended_at,
            t.category, t.created_at, t.assignee_id, t.resolved_by, t.resolved_at, t.reopen_count, t.status
       FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id AND t.program_id = e.program_id
      WHERE e.program_id = ? AND e.event_type = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .all(programId, EVENT_TYPE, Math.min(Math.max(Number(limit) || 20, 1), 100)) as ShadowRow[];
  return rows.map((row: ShadowRow) => {
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
      top3ContainsResolver: Boolean(
        (resolved.at(-1)?.actor_id || row.resolved_by) &&
        detail.candidates
          ?.slice(0, 3)
          .some((candidate) => candidate.userId === (resolved.at(-1)?.actor_id || row.resolved_by)),
      ),
      resolvedAt: row.resolved_at,
      reopened: (row.reopen_count || 0) > 0,
      status: row.status,
      assigneeId: row.assignee_id,
    };
  });
}

export = { EVENT_TYPE, snapshotForTicket, list };
