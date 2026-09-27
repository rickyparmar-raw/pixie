// Append-only audit records for tenant-scoped actions; callers never pass secrets.
// Audit failure is intentionally non-fatal so the action being recorded still completes.
import db = require("./db");
import log = require("./log");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function packMetadata(metadata: unknown) {
  // Store one predictable TEXT shape so every caller gets the same serialization behavior.
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata === "string") return metadata;
  try {
    return JSON.stringify(metadata);
  } catch (_: unknown) {
    return null;
  }
}

function packEntityId(entityId: unknown) {
  if (entityId === null || entityId === undefined) return null;
  return String(entityId);
}

function record({ programId = null, actorId = null, action, entityType = null, entityId = null, metadata = null }: Record<string, unknown>) {
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
  } catch (e: unknown) {


    log.warn("audit", `record failed (${action}): ${errorMessage(e)}`);
    return null;
  }
}

export = { record };
