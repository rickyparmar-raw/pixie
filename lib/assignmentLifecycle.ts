import db = require("./db");
import log = require("./log");

interface DbRow {
  id: number;
  ticket_id: number;
  actor_id: string | null;
  event_type: string;
  detail: EventDetail;
  created_at: number;
  helper_offer_timeout_ms?: number;
  [key: string]: unknown;
}

interface EventDetail {
  to?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

interface TicketLike {
  id: number;
  program_id: string;
  status?: string;
}

interface Offer {
  offeredAt: number;
  to: string | null;
  source: string | null;
  outcome: string;
  outcomeAt: number | null;
  outcomeBy: string | null;
}

const OFFERED = "helper_assignment_offered";
const CLAIMED = "helper_assignment_claimed";
const DECLINED = "helper_assignment_declined";
const RELEASED = "helper_assignment_released";
const TIMED_OUT = "helper_assignment_timed_out";
const EVENT_TYPES = [OFFERED, CLAIMED, DECLINED, RELEASED, TIMED_OUT];

const MIN_COMPLETED_OFFERS_FOR_RATE = 3;

const DEFAULT_OFFER_TIMEOUT_MS = 30 * 60 * 1000;

const CLOSED_TICKET_STATUSES = new Set(["resolved", "closed"]);

function parseDetail(value: unknown): EventDetail {
  if (!value) return {};
  try {
    return (typeof value === "string" ? JSON.parse(value) : value) as EventDetail;
  } catch (_) {
    return {};
  }
}

function lifecycleEvents(programId: string, ticketId: number | null = null): DbRow[] {
  const rows = ticketId
    ? db
        .handle()
        .query(
          `SELECT id, ticket_id, actor_id, event_type, detail, created_at FROM ticket_events
          WHERE program_id = ? AND ticket_id = ? AND event_type IN (${EVENT_TYPES.map(() => "?").join(",")})
          ORDER BY created_at ASC, id ASC`,
        )
        .all(programId, ticketId, ...EVENT_TYPES)
    : db
        .handle()
        .query(
          `SELECT id, ticket_id, actor_id, event_type, detail, created_at FROM ticket_events
          WHERE program_id = ? AND event_type IN (${EVENT_TYPES.map(() => "?").join(",")})
          ORDER BY created_at ASC, id ASC`,
        )
        .all(programId, ...EVENT_TYPES);
  return (rows as DbRow[]).map((row) => ({ ...row, detail: parseDetail(row.detail) }));
}

function offersFromEvents(events: DbRow[]): Offer[] {
  const offers: Offer[] = [];
  let open: Offer | null = null;
  const closeOpen = (outcome: string, at: number, by: string | null) => {
    if (!open) return;
    open.outcome = outcome;
    open.outcomeAt = at;
    open.outcomeBy = by || null;
    offers.push(open);
    open = null;
  };
  for (const event of events) {
    if (event.event_type === OFFERED) {
      if (open) closeOpen("superseded", event.created_at, null);
      open = {
        offeredAt: event.created_at,
        to: event.detail.to ?? null,
        source: event.detail.source || null,
        outcome: "pending",
        outcomeAt: null,
        outcomeBy: null,
      };
      continue;
    }
    if (!open || open.outcome !== "pending") continue;
    if (event.event_type === CLAIMED) closeOpen("claimed", event.created_at, event.actor_id);
    else if (event.event_type === TIMED_OUT) closeOpen("timed_out", event.created_at, null);
    else if (event.event_type === DECLINED && open.to && event.actor_id === open.to) {
      closeOpen("declined", event.created_at, event.actor_id);
    }
  }
  if (open) offers.push(open);
  return offers;
}

function openOfferFor(programId: string, ticketId: number): Offer | null {
  const offers = offersFromEvents(lifecycleEvents(programId, ticketId));
  const last = offers[offers.length - 1];
  return last && last.outcome === "pending" ? last : null;
}

function guardTicket(ticket: TicketLike | null | undefined): ticket is TicketLike {
  return Boolean(ticket && ticket.id && ticket.program_id);
}

function emit({
  ticket,
  eventType,
  actorId = null,
  detail = null,
  metricDetail = null,
}: {
  ticket: TicketLike;
  eventType: string;
  actorId?: string | null;
  detail?: unknown;
  metricDetail?: unknown;
}): number | null {
  let eventId = null;
  try {
    const addTicketEvent = db.addTicketEvent as (row: Record<string, unknown>) => number | null;
    eventId = addTicketEvent({
      ticketId: ticket.id,
      programId: ticket.program_id,
      actorId,
      eventType,
      detail,
    });
  } catch (e: any) {
    log.warn("assignmentLifecycle", `${eventType} append failed for #${ticket.id}: ${e.message}`);
    return null;
  }
  try {
    const recordMetric = db.recordMetric as (...args: unknown[]) => unknown;
    recordMetric(eventType, null, metricDetail, ticket.program_id);
  } catch (e: any) {
    log.debug("assignmentLifecycle", `metric ${eventType} failed: ${e.message}`);
  }
  return eventId;
}

function recordOffer({
  ticket,
  to = null,
  source = "queue",
  actorId = null,
}: {
  ticket: TicketLike;
  to?: string | null;
  source?: string;
  actorId?: string | null;
}): Record<string, unknown> {
  if (!guardTicket(ticket)) return { recorded: false };
  if (ticket.status !== undefined && CLOSED_TICKET_STATUSES.has(ticket.status)) return { recorded: false };
  const open = openOfferFor(ticket.program_id, ticket.id);
  if (open && (open.to ?? null) === (to ?? null)) return { recorded: false, deduped: true };
  const eventId = emit({
    ticket,
    eventType: OFFERED,
    actorId,
    detail: { to: to ?? null, source },
    metricDetail: source,
  });
  return { recorded: !!eventId, eventId };
}

function recordClaim({ ticket, userId }: { ticket: TicketLike; userId?: string }): Record<string, unknown> {
  if (!guardTicket(ticket) || !userId) return { recorded: false };
  const open = openOfferFor(ticket.program_id, ticket.id);
  if (!open) return { recorded: false, noOffer: true };
  const source = open.to === userId ? "targeted" : "pool";
  const eventId = emit({ ticket, eventType: CLAIMED, actorId: userId, detail: { source }, metricDetail: source });
  return { recorded: !!eventId, eventId, source };
}

function recordDecline({
  ticket,
  userId,
  reason = null,
}: {
  ticket: TicketLike;
  userId?: string;
  reason?: unknown;
}): Record<string, unknown> {
  if (!guardTicket(ticket) || !userId) return { recorded: false };
  if (!openOfferFor(ticket.program_id, ticket.id)) return { recorded: false, noOffer: true };
  const events = lifecycleEvents(ticket.program_id, ticket.id);
  const lastClaimByUser = [...events].reverse().find((e) => e.event_type === CLAIMED && e.actor_id === userId);
  const declineAfter = events.some(
    (e) =>
      e.event_type === DECLINED &&
      e.actor_id === userId &&
      (!lastClaimByUser || e.created_at > lastClaimByUser.created_at),
  );
  if (declineAfter) return { recorded: false, deduped: true };
  const clean = reason ? String(reason).trim().toLowerCase().slice(0, 40) : null;
  const eventId = emit({
    ticket,
    eventType: DECLINED,
    actorId: userId,
    detail: { reason: clean },
    metricDetail: clean || "no_reason",
  });
  return { recorded: !!eventId, eventId };
}

function recordRelease({ ticket, userId }: { ticket: TicketLike; userId?: string }): Record<string, unknown> {
  if (!guardTicket(ticket) || !userId) return { recorded: false };
  const eventId = emit({ ticket, eventType: RELEASED, actorId: userId, detail: {}, metricDetail: "released" });
  return { recorded: !!eventId, eventId };
}

function recordTimeout({
  ticket,
  to = null,
  offeredAt = null,
}: {
  ticket: TicketLike;
  to?: string | null;
  offeredAt?: number | null;
}): Record<string, unknown> {
  if (!guardTicket(ticket)) return { recorded: false };
  const open = openOfferFor(ticket.program_id, ticket.id);
  if (!open) return { recorded: false, deduped: true };
  const eventId = emit({
    ticket,
    eventType: TIMED_OUT,
    actorId: null,
    detail: { to: to ?? open.to ?? null, offeredAt: offeredAt ?? open.offeredAt ?? null },
    metricDetail: open.to ? "targeted" : "pool",
  });
  return { recorded: !!eventId, eventId };
}

function helperAcceptStats(programId: string, userId: string): Record<string, unknown> {
  const events = lifecycleEvents(programId);
  const claimed = new Set();
  const declined = new Set();
  const released = new Set();
  const timedOut = new Set();
  let offered = 0;
  for (const event of events) {
    if (event.event_type === OFFERED && event.detail.to === userId) offered += 1;
    else if (event.event_type === CLAIMED && event.actor_id === userId) claimed.add(event.ticket_id);
    else if (event.event_type === DECLINED && event.actor_id === userId) declined.add(event.ticket_id);
    else if (event.event_type === RELEASED && event.actor_id === userId) released.add(event.ticket_id);
    else if (event.event_type === TIMED_OUT && event.detail.to === userId) timedOut.add(event.ticket_id);
  }
  for (const ticketId of claimed) declined.delete(ticketId);
  const acceptedAssignments = claimed.size;
  const declinedAssignments = declined.size;
  const timedOutAssignments = timedOut.size;
  const releasedAssignments = released.size;
  const completedOffers = acceptedAssignments + declinedAssignments + timedOutAssignments;
  const touched = offered > 0 || completedOffers > 0 || releasedAssignments > 0;
  const supported = completedOffers >= MIN_COMPLETED_OFFERS_FOR_RATE;
  return {
    offered,
    acceptedAssignments,
    declinedAssignments,
    timedOutAssignments,
    releasedAssignments,
    completedOffers,
    acceptRate: supported ? Number((acceptedAssignments / completedOffers).toFixed(3)) : null,
    assignmentLifecycle: !touched ? "unsupported" : supported ? "supported" : "insufficient",
  };
}

function programAcceptStats(programId: string): Record<string, unknown> {
  const events = lifecycleEvents(programId);
  const claimedByTicket = new Set<number>();
  const declinedByTicket = new Set<string>();
  const timedOutByTicket = new Set<number>();
  for (const event of events) {
    if (event.event_type === CLAIMED) claimedByTicket.add(event.ticket_id);
    else if (event.event_type === DECLINED) declinedByTicket.add(`${event.ticket_id}:${event.actor_id}`);
    else if (event.event_type === TIMED_OUT) timedOutByTicket.add(event.ticket_id);
  }
  for (const key of [...declinedByTicket]) {
    if (claimedByTicket.has(Number(key.split(":")[0]))) declinedByTicket.delete(key);
  }
  const acceptedAssignments = claimedByTicket.size;
  const completedOffers = acceptedAssignments + declinedByTicket.size + timedOutByTicket.size;
  const supported = completedOffers >= MIN_COMPLETED_OFFERS_FOR_RATE;
  return {
    acceptedAssignments,
    completedOffers,
    acceptRate: supported ? Number((acceptedAssignments / completedOffers).toFixed(3)) : null,
    assignmentLifecycle: completedOffers === 0 ? "unsupported" : supported ? "supported" : "insufficient",
  };
}

function pendingTimeoutOffers({
  programId,
  timeoutMs,
  now = Date.now(),
}: {
  programId: string;
  timeoutMs: number;
  now?: number;
}): Array<{ ticketId: number; to: string | null; offeredAt: number }> {
  if (!timeoutMs || timeoutMs <= 0) return [];
  const events = lifecycleEvents(programId);
  const byTicket = new Map<number, DbRow[]>();
  for (const event of events) {
    if (!byTicket.has(event.ticket_id)) byTicket.set(event.ticket_id, []);
    const bucket = byTicket.get(event.ticket_id) as DbRow[] | undefined;
    if (bucket) bucket.push(event);
  }
  const stale: Array<{ ticketId: number; to: string | null; offeredAt: number }> = [];
  for (const [ticketId, ticketEvents] of byTicket) {
    const offers = offersFromEvents(ticketEvents);
    const last = offers[offers.length - 1];
    if (!last || last.outcome !== "pending") continue;
    if (now - last.offeredAt <= timeoutMs) continue;
    const ticket = db.getTicket(ticketId);
    if (!ticket || CLOSED_TICKET_STATUSES.has(ticket.status)) continue;
    stale.push({ ticketId, to: last.to, offeredAt: last.offeredAt });
  }
  return stale;
}

function sweepProgramTimeouts({ programId, now = Date.now() }: { programId: string; now?: number }): { swept: number } {
  let row;
  try {
    row = db.handle().query("SELECT helper_offer_timeout_ms FROM programs WHERE id = ?").get(programId);
  } catch (e: any) {
    log.debug("assignmentLifecycle", `timeout config read failed for ${programId}: ${e.message}`);
    return { swept: 0 };
  }
  const timeoutMs = row && Number.isFinite(row.helper_offer_timeout_ms) ? row.helper_offer_timeout_ms : null;
  if (!timeoutMs || timeoutMs <= 0) return { swept: 0 };
  const stale = pendingTimeoutOffers({ programId, timeoutMs, now });
  let swept = 0;
  for (const offer of stale) {
    const ticket = db.getTicket(offer.ticketId);
    if (!ticket) continue;
    const res = recordTimeout({ ticket, to: offer.to, offeredAt: offer.offeredAt });
    if (res.recorded) swept += 1;
  }
  return { swept };
}

function helpersWhoPassed(programId: string, ticketId: number): Set<string> {
  const passed = new Set<string>();
  for (const event of lifecycleEvents(programId, ticketId)) {
    if (event.event_type === DECLINED && event.actor_id) passed.add(event.actor_id);
    if (event.event_type === TIMED_OUT && event.detail.to) passed.add(event.detail.to);
  }
  return passed;
}

function nextEligibleHelper({
  programId,
  ticketId,
  category = null,
  exclude = [],
  expertiseRouting = true,
}: {
  programId: string;
  ticketId: number;
  category?: string | null;
  exclude?: string[];
  expertiseRouting?: boolean;
}): Record<string, unknown> | null {
  const helperRoute = require("./helperRoute");
  const skip = helpersWhoPassed(programId, ticketId);
  for (const id of exclude) skip.add(id);
  const ranked = helperRoute.recommend({ programId, category, limit: 10, exclude: [...skip], expertiseRouting });
  return ranked.find((candidate: { userId: string }) => !skip.has(candidate.userId)) || null;
}

export = {
  OFFERED,
  CLAIMED,
  DECLINED,
  RELEASED,
  TIMED_OUT,
  EVENT_TYPES,
  MIN_COMPLETED_OFFERS_FOR_RATE,
  DEFAULT_OFFER_TIMEOUT_MS,
  recordOffer,
  recordClaim,
  recordDecline,
  recordRelease,
  recordTimeout,
  helperAcceptStats,
  programAcceptStats,
  offersFromEvents,
  openOfferFor,
  pendingTimeoutOffers,
  sweepProgramTimeouts,
  helpersWhoPassed,
  nextEligibleHelper,
};
