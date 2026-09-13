import { fail, ok, type DomainError, type Result } from "../domain/result";
import type { TicketSnapshot, TicketStatus } from "../domain/ticket";

export type LegacyTicketShapeError = DomainError & { code: "invalid_legacy_ticket" };
const statuses = new Set<TicketStatus>(["open", "waiting_for_helper", "reopened", "claimed", "assigned", "snoozed", "resolved", "closed", "duplicate", "escalated"]);

export function fromLegacyTicketRow(value: unknown): Result<TicketSnapshot, LegacyTicketShapeError> {
  if (!value || typeof value !== "object") return fail({ code: "invalid_legacy_ticket", message: "Ticket row must be an object" });
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "number" || typeof row.program_id !== "string" || typeof row.channel !== "string" || typeof row.thread_ts !== "string" || typeof row.status !== "string" || !statuses.has(row.status as TicketStatus)) {
    return fail({ code: "invalid_legacy_ticket", message: "Ticket row is missing required fields" });
  }
  return ok({
    ticketId: row.id,
    programId: row.program_id,
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
    channelId: row.channel,
    threadTs: row.thread_ts,
    status: row.status as TicketStatus,
    requesterId: typeof row.requester_id === "string" ? row.requester_id : null,
    assigneeId: typeof row.assignee_id === "string" ? row.assignee_id : null,
    question: typeof row.question === "string" ? row.question : "",
    resolution: typeof row.resolution === "string" ? row.resolution : null,
    cardTs: typeof row.card_ts === "string" ? row.card_ts : null,
  });
}

export function toLegacyTicketStatus(status: TicketStatus): string { return status; }
