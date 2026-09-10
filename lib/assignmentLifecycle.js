// Explicit helper-assignment lifecycle. An append-only trail of five
// ticket_events records what happened to every offer of a ticket to a human:
//
//   helper_assignment_offered     — a ticket was put in front of a helper
//                                   (to a specific one, or the pool)
//   helper_assignment_claimed     — a helper took it (the offer was accepted)
//   helper_assignment_declined    — a helper passed on it (not a resolution
//                                   failure — the ticket stays available)
//   helper_assignment_released    — a helper who had claimed it gave it back
//   helper_assignment_timed_out   — an offer sat unclaimed past the program's
//                                   configured window
//
// Ticket status and assignee_id are still owned by lib/tickets.js + lib/db.js;
// nothing here changes them. This module only appends events, reads them back
// as accept-rate stats, and answers "which offers have gone stale" for the
// timeout sweep. Routing retry is a pure capability here (nextEligibleHelper)
// and is deliberately wired to nothing automatic.
const db = require("./db");
const log = require("./log");

const OFFERED = "helper_assignment_offered";
const CLAIMED = "helper_assignment_claimed";
const DECLINED = "helper_assignment_declined";
const RELEASED = "helper_assignment_released";
const TIMED_OUT = "helper_assignment_timed_out";
const EVENT_TYPES = [OFFERED, CLAIMED, DECLINED, RELEASED, TIMED_OUT];

// WHY: an accept rate over one or two offers is noise, not a signal. Below this
// the helper's rate is null and the lifecycle is reported "insufficient".
const MIN_COMPLETED_OFFERS_FOR_RATE = 3;

// A conservative default a caller MAY pass to the sweep. Nothing in production
// uses it — programs opt in by setting helper_offer_timeout_ms, and until they
// do the sweep is a no-op.
const DEFAULT_OFFER_TIMEOUT_MS = 30 * 60 * 1000;

const CLOSED_TICKET_STATUSES = new Set(["resolved", "closed"]);

function parseDetail(value) {
  if (!value) return {};
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (_) {
    return {};
  }
}

function lifecycleEvents(programId, ticketId = null) {
  const rows = ticketId
    ? db.handle().query(
        `SELECT id, ticket_id, actor_id, event_type, detail, created_at FROM ticket_events
          WHERE program_id = ? AND ticket_id = ? AND event_type IN (${EVENT_TYPES.map(() => "?").join(",")})
          ORDER BY created_at ASC, id ASC`,
      ).all(programId, ticketId, ...EVENT_TYPES)
    : db.handle().query(
        `SELECT id, ticket_id, actor_id, event_type, detail, created_at FROM ticket_events
          WHERE program_id = ? AND event_type IN (${EVENT_TYPES.map(() => "?").join(",")})
          ORDER BY created_at ASC, id ASC`,
      ).all(programId, ...EVENT_TYPES);
  return rows.map((row) => ({ ...row, detail: parseDetail(row.detail) }));
}

// Walk one ticket's lifecycle events into a list of offers, each with its
// outcome. An `offered` opens an offer; a claim/timeout closes it; a decline
// closes it only when it targeted that same recipient (a pool decline leaves
// the offer open for someone else); a fresh `offered` supersedes a stale one.
function offersFromEvents(events) {
  const offers = [];
  let open = null;
  const closeOpen = (outcome, at, by) => {
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

function openOfferFor(programId, ticketId) {
  const offers = offersFromEvents(lifecycleEvents(programId, ticketId));
  const last = offers[offers.length - 1];
  return last && last.outcome === "pending" ? last : null;
}

/* ----------------------------------------------------------- append trail -- */

function guardTicket(ticket) {
  return ticket && ticket.id && ticket.program_id;
}

function emit({ ticket, eventType, actorId = null, detail = null, metricDetail = null }) {
  let eventId = null;
  try {
    eventId = db.addTicketEvent({
      ticketId: ticket.id,
      programId: ticket.program_id,
      actorId,
      eventType,
      detail,
    });
  } catch (e) {
    log.warn("assignmentLifecycle", `${eventType} append failed for #${ticket.id}: ${e.message}`);
    return null;
  }
  try {
    db.recordMetric(eventType, null, metricDetail, ticket.program_id);
  } catch (e) {
    log.debug("assignmentLifecycle", `metric ${eventType} failed: ${e.message}`);
  }
  return eventId;
}

// A ticket enters the queue, or is routed/reassigned to one helper. `to` is a
// Slack user id for a targeted offer, or null for a pool offer. Idempotent:
// an offer with the same target already open is not re-emitted.
function recordOffer({ ticket, to = null, source = "queue", actorId = null }) {
  if (!guardTicket(ticket)) return { recorded: false };
  if (CLOSED_TICKET_STATUSES.has(ticket.status)) return { recorded: false };
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

// A helper took the ticket. Called only after db.claimTicket won its
// conditional UPDATE, so exactly one concurrent claim reaches here. A claim is
// a lifecycle event only when it closes a real open offer — claiming a ticket
// that was never offered (an artificial or dashboard-only path) records
// nothing, so no accept rate is ever inferred without an offer. Idempotent
// against a Slack retry: the open offer is already gone on the second call.
function recordClaim({ ticket, userId }) {
  if (!guardTicket(ticket) || !userId) return { recorded: false };
  const open = openOfferFor(ticket.program_id, ticket.id);
  if (!open) return { recorded: false, noOffer: true };
  const source = open.to === userId ? "targeted" : "pool";
  const eventId = emit({ ticket, eventType: CLAIMED, actorId: userId, detail: { source }, metricDetail: source });
  return { recorded: !!eventId, eventId, source };
}

// A helper passed on a ticket they had not claimed. Does not touch ticket
// status, assignee, or resolution — the ticket stays offered to everyone else.
// Idempotent per (ticket, helper) until that helper claims it.
function recordDecline({ ticket, userId, reason = null }) {
  if (!guardTicket(ticket) || !userId) return { recorded: false };
  if (!openOfferFor(ticket.program_id, ticket.id)) return { recorded: false, noOffer: true };
  const events = lifecycleEvents(ticket.program_id, ticket.id);
  const lastClaimByUser = [...events].reverse().find((e) => e.event_type === CLAIMED && e.actor_id === userId);
  const declineAfter = events.some(
    (e) => e.event_type === DECLINED && e.actor_id === userId
      && (!lastClaimByUser || e.created_at > lastClaimByUser.created_at),
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

// A helper who had claimed the ticket gave it back. Distinct from decline:
// the offer was accepted first. The caller is responsible for the status
// change (back to the queue) and for re-offering to the pool.
function recordRelease({ ticket, userId }) {
  if (!guardTicket(ticket) || !userId) return { recorded: false };
  const eventId = emit({ ticket, eventType: RELEASED, actorId: userId, detail: {}, metricDetail: "released" });
  return { recorded: !!eventId, eventId };
}

// An offer sat unclaimed past the window. Recorded by the sweep only.
// Idempotent: an offer already closed (claimed, declined, timed out) is not
// timed out again.
function recordTimeout({ ticket, to = null, offeredAt = null }) {
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

/* --------------------------------------------------------------- reading -- */

// Per-helper accept-rate stats, program-scoped. Only the five lifecycle events
// count — a pre-lifecycle ticket, or a ticket resolved with no explicit offer,
// contributes nothing, so accept rates are never inferred from history.
//
//   acceptRate = distinct tickets this helper CLAIMED
//              / (that same count + distinct tickets they DECLINED
//                 + distinct tickets whose targeted timeout named them)
//
// Pending offers are excluded (they are in none of those sets). A release does
// not lower the rate — the helper accepted the offer first — but is counted on
// its own. Below MIN_COMPLETED_OFFERS_FOR_RATE the rate is null.
function helperAcceptStats(programId, userId) {
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
  // Accepting a ticket outranks a stale decline of the same ticket.
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

// Program-level roll-up across every helper's completed offers.
function programAcceptStats(programId) {
  const events = lifecycleEvents(programId);
  const claimedByTicket = new Set();
  const declinedByTicket = new Set();
  const timedOutByTicket = new Set();
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

/* --------------------------------------------------------------- timeout -- */

// Which of this program's offers have sat pending longer than timeoutMs.
// Pure over the event trail plus `now`; the sweep turns each into a
// helper_assignment_timed_out. Never returns offers on resolved/closed tickets.
function pendingTimeoutOffers({ programId, timeoutMs, now = Date.now() }) {
  if (!timeoutMs || timeoutMs <= 0) return [];
  const events = lifecycleEvents(programId);
  const byTicket = new Map();
  for (const event of events) {
    if (!byTicket.has(event.ticket_id)) byTicket.set(event.ticket_id, []);
    byTicket.get(event.ticket_id).push(event);
  }
  const stale = [];
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

// Background sweep for one program. A no-op unless the program set
// helper_offer_timeout_ms — so adding this to the loop automates nothing for a
// program that has not opted in. Records timeouts only; it does not reassign.
function sweepProgramTimeouts({ programId, now = Date.now() }) {
  let row;
  try {
    row = db.handle().query("SELECT helper_offer_timeout_ms FROM programs WHERE id = ?").get(programId);
  } catch (e) {
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

/* ----------------------------------------------------- routing retry (capability) -- */

// Helpers who declined this ticket or let a targeted offer time out.
function helpersWhoPassed(programId, ticketId) {
  const passed = new Set();
  for (const event of lifecycleEvents(programId, ticketId)) {
    if (event.event_type === DECLINED && event.actor_id) passed.add(event.actor_id);
    if (event.event_type === TIMED_OUT && event.detail.to) passed.add(event.detail.to);
  }
  return passed;
}

// The next helper routing would pick, skipping anyone who already declined or
// timed out on this ticket (and any caller-supplied exclusions). This is a
// capability only — no automatic path calls it. A gated retry, or an
// organizer's reassign menu, can.
function nextEligibleHelper({ programId, ticketId, category = null, exclude = [] }) {
  const helperRoute = require("./helperRoute");
  const skip = helpersWhoPassed(programId, ticketId);
  for (const id of exclude) skip.add(id);
  const ranked = helperRoute.recommend({ programId, category, limit: 10 });
  return ranked.find((candidate) => !skip.has(candidate.userId)) || null;
}

module.exports = {
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
