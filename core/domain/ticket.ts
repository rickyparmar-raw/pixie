export type TicketStatus = "open" | "waiting_for_helper" | "reopened" | "claimed" | "assigned" | "snoozed" | "resolved" | "closed" | "duplicate" | "escalated";
export type TicketTransition = "claim" | "unclaim" | "assign" | "decline_assignment" | "resolve" | "reopen" | "snooze" | "duplicate" | "escalate" | "close";
export interface TicketRef { ticketId: number; programId: string; workspaceId: string | null; channelId: string; threadTs: string }
export interface TicketSnapshot extends TicketRef { status: TicketStatus; requesterId: string | null; assigneeId: string | null; question: string; resolution: string | null; cardTs: string | null }
export interface TransitionContext { actorId: string | null; source: "slack" | "dashboard" | "system" | "migration" | null; assigneeId?: string | null; canonicalTicketId?: number; snoozeUntilMs?: number; resolution?: string | null }
export interface TransitionResult { ok: boolean; from: TicketStatus; to: TicketStatus | null; transition: TicketTransition; reason: "allowed" | "not_found" | "unauthorized" | "invalid_transition" | "already_applied" | "invalid_context" }

export function isClaimable(status: TicketStatus): boolean { return status === "open" || status === "waiting_for_helper" || status === "reopened" }
export function isWorkable(status: TicketStatus): boolean { return status === "claimed" || status === "assigned" }
export function isClosed(status: TicketStatus): boolean { return status === "resolved" || status === "closed" }
export function isTerminal(status: TicketStatus): boolean { return isClosed(status) || status === "duplicate" }

export function canTransition(status: TicketStatus, transition: TicketTransition): boolean {
  if (transition === "claim") return isClaimable(status);
  if (transition === "unclaim") return isWorkable(status);
  if (transition === "assign") return isClaimable(status) || isWorkable(status) || status === "escalated";
  if (transition === "decline_assignment") return isWorkable(status);
  if (transition === "resolve") return !isClosed(status) && status !== "duplicate";
  if (transition === "reopen") return isClosed(status);
  if (transition === "snooze") return !isTerminal(status);
  if (transition === "duplicate") return !isTerminal(status);
  if (transition === "escalate") return !isTerminal(status);
  if (transition === "close") return status === "resolved";
  return false;
}

export function transitionTicket(ticket: TicketSnapshot, transition: TicketTransition, context: TransitionContext): TransitionResult {
  if (!canTransition(ticket.status, transition)) return { ok: false, from: ticket.status, to: null, transition, reason: "invalid_transition" };
  if (transition === "claim" && !context.actorId) return { ok: false, from: ticket.status, to: null, transition, reason: "invalid_context" };
  if (transition === "assign" && !context.assigneeId) return { ok: false, from: ticket.status, to: null, transition, reason: "invalid_context" };
  if (transition === "snooze" && (!context.snoozeUntilMs || context.snoozeUntilMs <= Date.now())) return { ok: false, from: ticket.status, to: null, transition, reason: "invalid_context" };
  if (transition === "duplicate" && (!context.canonicalTicketId || context.canonicalTicketId === ticket.ticketId)) return { ok: false, from: ticket.status, to: null, transition, reason: "invalid_context" };
  const to: Record<TicketTransition, TicketStatus> = { claim: "claimed", unclaim: "open", assign: "assigned", decline_assignment: "open", resolve: "resolved", reopen: "reopened", snooze: "snoozed", duplicate: "duplicate", escalate: "escalated", close: "closed" };
  return { ok: true, from: ticket.status, to: to[transition], transition, reason: "allowed" };
}
