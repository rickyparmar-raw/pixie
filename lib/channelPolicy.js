// The one answer to "which program owns this channel, and in which role".
// Handlers, respond, tickets and commands read the role and settings from
// here; nothing else should re-derive help/main from env vars or id lists.
//
// Roles:
//   "help" — active support channel (tickets, escalation)
//   "main" — the program's own channel; Pixie is mostly passive
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

function resolve(channelId, workspaceId = null, { isDm = false } = {}) {
  const program = programs.forChannel(channelId, workspaceId);
  let role = "none";
  if (isDm) role = "dm";
  else if (programs.isHelpChannel(channelId, workspaceId)) role = "help";
  else if (isMainChannel(program, channelId)) role = "main";

  const behavior = programModel.behaviorFor(program || {});
  const status = programModel.statusFor(program || {});
  const settings = role === "help" ? behavior.help : role === "main" ? behavior.main : null;
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

module.exports = { resolve, validate, isMainChannel };
