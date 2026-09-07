// Slack workspace identity for the shared hosted platform.
//
// Channel IDs are only unique within one workspace, so every tenant boundary —
// channel ownership, ticket/thread identity, dedupe, event correlation — keys
// on (workspace, channel/message), never on a bare channel or ts.
const { config } = require("./config");

function configuredWorkspaceId() {
  return (process.env.PIXIE_WORKSPACE_ID || "").trim() || null;
}

// Bolt events carry the team id at top level; interactive payloads nest it
// under team.id. Prefer the event value, fall back to the configured one so
// single-workspace deployments keep working when Slack omits it.
function workspaceOf(event = {}, body = {}) {
  const fromEvent = event && typeof event.team === "string" ? event.team : null;
  const fromBody = body && body.team_id ? body.team_id : body.team && body.team.id ? body.team.id : null;
  return fromEvent || fromBody || configuredWorkspaceId();
}

function threadKey(workspaceId, threadTs) {
  return `${workspaceId || "default"}:${threadTs}`;
}

function channelKey(workspaceId, channelId) {
  return `${workspaceId || "default"}:${channelId}`;
}

module.exports = { configuredWorkspaceId, workspaceOf, threadKey, channelKey };
