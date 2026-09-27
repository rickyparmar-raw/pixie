// Channel IDs are only unique inside a Slack workspace, so tenant keys always pair
// workspace identity with channel/message identity.
import configModule = require("./config");

const { config } = configModule;

interface SlackBody {
  team_id?: string;
  team?: { id?: string };
}


const DEFAULT_WORKSPACE = "default";

function configuredWorkspaceId() {
  return (process.env.PIXIE_WORKSPACE_ID || "").trim() || null;
}

function teamOfBody(body: SlackBody = {}): string | null {
  // Slack event bodies and interactive payloads place the team id in different fields.
  if (body.team_id) return body.team_id;
  if (body.team && body.team.id) return body.team.id;
  return null;
}


function workspaceOf(event: SlackBody = {}, body: SlackBody = {}): string | null {
  if (event && typeof event.team === "string") return event.team;
  return teamOfBody(body) || configuredWorkspaceId();
}

function scopedKey(workspaceId: string | null, suffix: string): string {
  return `${workspaceId || DEFAULT_WORKSPACE}:${suffix}`;
}

function threadKey(workspaceId: string | null, threadTs: string): string {
  return scopedKey(workspaceId, threadTs);
}

function channelKey(workspaceId: string | null, channelId: string): string {
  return scopedKey(workspaceId, channelId);
}

export = { configuredWorkspaceId, workspaceOf, threadKey, channelKey, DEFAULT_WORKSPACE };
