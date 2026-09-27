import programModel = require("../programModel");
import type { Program, ChannelRole } from "../types";

interface PolicyHelp {
  enabled: boolean;
  ticketsEnabled: boolean;
  autoCreateTickets: boolean;
  escalateUnknown: boolean;
  helperPings: boolean;
  expertiseRouting: boolean;
}

interface PolicyMain {
  enabled: boolean;
  ticketsEnabled: boolean;
  helperEscalationEnabled: boolean;
}

interface PolicyBehavior {
  help: PolicyHelp;
  main: PolicyMain;
}

const DENY_ALL = Object.freeze({
  createOnSupport: false,
  recordTicket: false,
  escalate: false,
  pingHelpers: false,
  expertiseRouting: false,
});

function ticketPolicy({ program = null, role = "help" }: { program?: Program | null; role?: ChannelRole | "organizer" } = {}): Record<string, boolean> {
  if (!program) return { ...DENY_ALL };
  if (role === "organizer") return { ...DENY_ALL };
  const behavior = programModel.behaviorFor(program) as unknown as PolicyBehavior;
  if (role === "help") {
    const h = behavior.help;
    const recordTicket = h.enabled && h.ticketsEnabled;
    return {
      createOnSupport: recordTicket && h.autoCreateTickets,
      recordTicket,
      escalate: recordTicket && h.escalateUnknown,
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

function resolveTicketRole({ program = null, channel = null, workspaceId = null, role = null }: { program?: Program | null; channel?: string | null; workspaceId?: string | null; role?: ChannelRole | "organizer" | null }): ChannelRole | "organizer" {
  if (role === "help" || role === "main" || role === "organizer" || role === "dm" || role === "none") return role;
  if (channel) {
    try {
      const channelPolicy = require("../channelPolicy");
      const resolved = channelPolicy.resolve(channel, workspaceId);
      if (resolved && (resolved.role === "help" || resolved.role === "main" || resolved.role === "organizer")) return resolved.role;
    } catch (_) {
    }
    if (program) {
      if (program.helpChannel === channel) return "help";
      if (program.organizerChannel === channel) return "organizer";
      try {
        if (require("../channelPolicy").isOrganizerChannel(program, channel, workspaceId)) return "organizer";
      } catch (_) {
        return "none";
      }
      if (Array.isArray(program.channels) && program.channels.includes(channel)) return "main";
    }
  }
  return program ? "help" : "none";
}

export = { ticketPolicy, resolveTicketRole, DENY_ALL };
