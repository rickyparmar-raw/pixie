// Channel ownership and role are resolved here. Handlers must not reconstruct
// help/main/organizer behavior from separate environment lists.
import programs = require("./programs");
import programModel = require("./programModel");
import configModule = require("./config");
import type { Program } from "./types";

const { config } = configModule;

function isMainChannel(program: Program | null, channelId: string | null) {
  if (!program || !channelId) return false;
  if (program.helpChannel === channelId) return false;
  if (Array.isArray(program.channels) && program.channels.includes(channelId)) return true;

  return (config?.slack?.faqChannels || []).includes(channelId);
}

function isOrganizerChannel(program: Program | null, channelId: string | null, workspaceId: string | null) {
  if (!program || !channelId) return false;
  if (program.organizerChannel === channelId) return true;
  try {
    const claim = require("./db").getChannelOwner(workspaceId || "default", channelId);
    return Boolean(claim && claim.program_id === program.id && claim.kind === "organizer");
  } catch (_: unknown) {
    return false;
  }
}

function organizerSettings(main: Record<string, unknown>) {
  // Organizers receive ticket cards but are never an ambient reply or ticket target.
  return Object.freeze({
    ...main,
    ambientProgramReplies: false,
    ticketsEnabled: false,
    helperEscalationEnabled: false,
  });
}

function resolve(channelId: string, workspaceId: string | null = null, { isDm = false }: { isDm?: boolean } = {}) {
  // DM role wins before channel lookup because DMs have no program channel ownership.
  const program = programs.forChannel(channelId, workspaceId);
  let role = "none";
  if (isDm) role = "dm";
  else if (programs.isHelpChannel(channelId, workspaceId)) role = "help";
  else if (isOrganizerChannel(program, channelId, workspaceId)) role = "organizer";
  else if (isMainChannel(program, channelId)) role = "main";

  const behavior = programModel.behaviorFor(program || {});
  const status = programModel.statusFor(program || {});
  let settings =
    role === "help"
      ? behavior.help
      : role === "main"
        ? behavior.main
        : role === "organizer"
          ? organizerSettings(behavior.main)
          : null;

  // Paused programs remain resolvable for display but cannot answer through any role.
  if (settings && status === "paused") settings = Object.freeze({ ...settings, enabled: false });
  return { program, role, settings, behavior, status };
}

function validate() {
  let claims = [];
  try {
    claims = require("./db").listChannelClaims?.() || [];
  } catch (_: unknown) {
    claims = [];
  }
  return programModel.validateChannelRoles({
    programs: programs.all(),
    legacyHelp: config?.slack?.helpChannel || null,
    legacyMain: config?.slack?.faqChannels || [],
    claims,
  });
}

export = { resolve, validate, isMainChannel, isOrganizerChannel };
