"use strict";

const STATUSES = Object.freeze([
  "open", "waiting_for_helper", "reopened", "claimed", "assigned",
  "snoozed", "resolved", "closed", "duplicate", "escalated",
]);

const TRANSITIONS = Object.freeze([
  "claim", "assign", "unclaim", "resolve", "reopen", "close", "snooze",
  "duplicate", "escalate", "waiting",
]);

function isStatus(value) { return STATUSES.includes(value); }

function tenantPredicate(programId, workspaceId) {
  return { sql: "program_id = ? AND workspace_id IS ?", params: [programId, workspaceId ?? null] };
}

module.exports = { STATUSES, TRANSITIONS, isStatus, tenantPredicate };
