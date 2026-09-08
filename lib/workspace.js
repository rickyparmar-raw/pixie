// Slack workspace identity for the shared hosted platform.
//
// Channel IDs are only unique within one workspace, so every tenant boundary —
// channel ownership, ticket/thread identity, dedupe, event correlation — keys
// on (workspace, channel/message), never on a bare channel or ts.
const { config } = require("./config");

// Unscoped callers predate multi-tenancy and intentionally see the default
// scope rather than throwing — keeps single-workspace deployments working.
const DEFAULT_WORKSPACE = "default";

function configuredWorkspaceId() {
  return (process.env.PIXIE_WORKSPACE_ID || "").trim() || null;
}

function teamOfBody(body = {}) {
  if (body.team_id) return body.team_id;
  if (body.team && body.team.id) return body.team.id;
  return null;
}

// Bolt events carry the team id at top level; interactive payloads nest it
// under team.id. Prefer the event value, fall back to the configured one so
// single-workspace deployments keep working when Slack omits it.
function workspaceOf(event = {}, body = {}) {
  if (event && typeof event.team === "string") return event.team;
  return teamOfBody(body) || configuredWorkspaceId();
}

function scopedKey(workspaceId, suffix) {
  return `${workspaceId || DEFAULT_WORKSPACE}:${suffix}`;
}

function threadKey(workspaceId, threadTs) {
  return scopedKey(workspaceId, threadTs);
}

function channelKey(workspaceId, channelId) {
  return scopedKey(workspaceId, channelId);
}

module.exports = { configuredWorkspaceId, workspaceOf, threadKey, channelKey, DEFAULT_WORKSPACE };
