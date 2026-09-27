// Append-only audit log. Records who did what to which tenant-scoped entity.
// Rows are insert-only: no update or delete path exists in app code, and log
// sweeps must archive rather than rewrite. Secrets must never be passed in.
import db = require("./db");
import log = require("./log");

// Metadata rides one TEXT column, so objects are stringified once here —
// every caller gets the same shape without repeating the try/catch.
function packMetadata(metadata: any) {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata === "string") return metadata;
  try {
    return JSON.stringify(metadata);
  } catch (_: any) {
    return null;
  }
}

function packEntityId(entityId: any) {
  if (entityId === null || entityId === undefined) return null;
  return String(entityId);
}

function record({ programId = null, actorId = null, action, entityType = null, entityId = null, metadata = null }: Record<string, any>) {
  if (!action) return null;
  try {
    return db.recordAuditEvent({
      programId,
      actorId,
      action,
      entityType,
      entityId: packEntityId(entityId),
      metadata: packMetadata(metadata),
    });
  } catch (e: any) {
    // Loud enough to notice in deploy logs, quiet enough to never break the
    // caller — an audit write must not fail the action it records.
    log.warn("audit", `record failed (${action}): ${e.message}`);
    return null;
  }
}

export = { record };
