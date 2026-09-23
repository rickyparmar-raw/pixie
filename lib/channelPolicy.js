// The one answer to "which program owns this channel, and in which role".
// Handlers, respond, tickets and commands read the role and settings from
// here; nothing else should re-derive help/main from env vars or id lists.
//
// Roles:
//   "help" — active support channel (tickets, escalation)
//   "main" — the program's own channel; Pixie is mostly passive
//   "organizer" — the helpers' channel where ticket cards land; Pixie never
//            volunteers there, answers only when addressed, files no tickets
//   "dm"   — direct message
//   "none" — nobody claimed this channel; Pixie stays silent
const programs = require("./programs");
const programModel = require("./programModel");
const { config } = require("./config");

function isMainChannel(program, channelId) {
  if (!program || !channelId) return false;
  if (program.helpChannel === channelId) return false;
  if (Array.isArray(program.channels) && program.channels.includes(channelId)) return true;
  // Legacy single-program env: SLACK_FAQ_CHANNELS are the main channels.
  return (config?.slack?.faqChannels || []).includes(channelId);
}

function isOrganizerChannel(program, channelId, workspaceId) {
  if (!program || !channelId) return false;
  if (program.organizerChannel === channelId) return true;
  try {
    const claim = require("./db").getChannelOwner(workspaceId || "default", channelId);
    return Boolean(claim && claim.program_id === program.id && claim.kind === "organizer");
  } catch (_) {
    return false;
  }
}

// Organizer channels reuse the main-channel settings with everything that
// would make Pixie speak unprompted or file work switched off.
function organizerSettings(main) {
  return Object.freeze({ ...main, ambientProgramReplies: false, ticketsEnabled: false, helperEscalationEnabled: false });
}

function resolve(channelId, workspaceId = null, { isDm = false } = {}) {
  const program = programs.forChannel(channelId, workspaceId);
  let role = "none";
  if (isDm) role = "dm";
  else if (programs.isHelpChannel(channelId, workspaceId)) role = "help";
  else if (isOrganizerChannel(program, channelId, workspaceId)) role = "organizer";
  else if (isMainChannel(program, channelId)) role = "main";

  const behavior = programModel.behaviorFor(program || {});
  const status = programModel.statusFor(program || {});
  let settings = role === "help" ? behavior.help
    : role === "main" ? behavior.main
      : role === "organizer" ? organizerSettings(behavior.main)
        : null;
  // A paused program is off in every role, whatever its toggles say.
  if (settings && status === "paused") settings = Object.freeze({ ...settings, enabled: false });
  return { program, role, settings, behavior, status };
}

// Startup / sync-time validation against every configuration layer.
function validate() {
  let claims = [];
  try {
    claims = require("./db").listChannelClaims?.() || [];
  } catch (_) {
    claims = [];
  }
  return programModel.validateChannelRoles({
    programs: programs.all(),
    legacyHelp: config?.slack?.helpChannel || null,
    legacyMain: config?.slack?.faqChannels || [],
    claims,
  });
}

module.exports = { resolve, validate, isMainChannel, isOrganizerChannel };
