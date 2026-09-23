// One decision table for ticket/helper behavior, driven by the channel's
// role settings. Callers ask "what may happen for this program in this role"
// and get plain booleans; lib/tickets.js applies them at its entry points.
//
//   help role: help.enabled, help.ticketsEnabled (a ticket exists at all),
//     help.autoCreateTickets (create on first support message vs only on
//     escalation), help.escalateUnknown (unknown question -> waiting_for_helper),
//     help.helperPings (Slack mention of a helper), help.expertiseRouting
//     (category/expertise selection vs plain workload selection).
//   main role: tickets only if main.ticketsEnabled; escalation/pings only if
//     main.helperEscalationEnabled (both default OFF).
//
// ticketVisibility is deliberately NOT here — it only decides which Slack
// surfaces show a ticket, never whether one exists.
const programModel = require("../programModel");

const DENY_ALL = Object.freeze({
  createOnSupport: false,
  recordTicket: false,
  escalate: false,
  pingHelpers: false,
  expertiseRouting: false,
});

// The single exported decision helper.
// `role` is "help" | "main" | "dm" | "none". Unknown programs fail closed:
// the legacy pipeline only ever acted on a known program, and the settings
// defaults read permissive (help pings default ON) so they must never apply
// to a program we cannot even name.
function ticketPolicy({ program = null, role = "help" } = {}) {
  if (!program) return { ...DENY_ALL };
  // Organizer channels are where ticket cards land; they never file tickets.
  if (role === "organizer") return { ...DENY_ALL };
  const behavior = programModel.behaviorFor(program);
  if (role === "help") {
    const h = behavior.help;
    const recordTicket = h.enabled && h.ticketsEnabled;
    return {
      createOnSupport: recordTicket && h.autoCreateTickets,
      recordTicket,
      escalate: recordTicket && h.escalateUnknown,
      // Pinging a helper into the thread needs no ticket: a ticketless
      // program that opted into helper pings (Pixl) gets the ticket-free
      // mention in lib/tickets.js pingThreadHelper, ranked by expertise.
      pingHelpers: h.enabled && h.helperPings,
      expertiseRouting: h.enabled && h.expertiseRouting,
    };
  }
  if (role === "main") {
    const m = behavior.main;
    const recordTicket = m.enabled && m.ticketsEnabled;
    const escalate = recordTicket && m.helperEscalationEnabled;
    return {
      createOnSupport: recordTicket,
      recordTicket,
      escalate,
      pingHelpers: escalate,
      expertiseRouting: false,
    };
  }
  return { ...DENY_ALL };
}

// Which role applies to this call. An explicit `role` wins (the orchestrator
// resolves it once via channelPolicy and passes it down). Otherwise resolve
// via channelPolicy — THE way to know a channel's role — and fall back to
// the passed program object's own shape for ad-hoc/unclaimed channels that
// the registry does not know (tests, legacy paths). Never throws.
function resolveTicketRole({ program = null, channel = null, workspaceId = null, role = null } = {}) {
  if (role === "help" || role === "main" || role === "organizer" || role === "dm" || role === "none") return role;
  if (channel) {
    try {
      const channelPolicy = require("../channelPolicy");
      const resolved = channelPolicy.resolve(channel, workspaceId);
      if (resolved && (resolved.role === "help" || resolved.role === "main" || resolved.role === "organizer")) return resolved.role;
    } catch (_) {
      // Fall through to the program-shape inference below.
    }
    if (program) {
      if (program.helpChannel === channel) return "help";
      // Hosted programs store their organizer channel inside channels[]; it
      // must never be mistaken for a main channel.
      if (program.organizerChannel === channel) return "organizer";
      try {
        if (require("../channelPolicy").isOrganizerChannel(program, channel, workspaceId)) return "organizer";
      } catch (_) {
        return "none";
      }
      if (Array.isArray(program.channels) && program.channels.includes(channel)) return "main";
    }
  }
  // An explicitly passed program with no resolvable channel is a deliberate
  // human escalation path (escalateTicket with paging) — treat it as help so
  // it is not silently dropped on unclaimed channels. No program at all
  // means nobody claimed anything: none.
  return program ? "help" : "none";
}

module.exports = { ticketPolicy, resolveTicketRole, DENY_ALL };
