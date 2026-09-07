// Append-only audit log. Records who did what to which tenant-scoped entity.
// Rows are insert-only: no update or delete path exists in app code, and log
// sweeps must archive rather than rewrite. Secrets must never be passed in.
const db = require("./db");
const log = require("./log");

function record({ programId = null, actorId = null, action, entityType = null, entityId = null, metadata = null }) {
  if (!action) return null;
  let safeMeta = null;
  if (metadata !== null && metadata !== undefined) {
    try {
      safeMeta = typeof metadata === "string" ? metadata : JSON.stringify(metadata);
    } catch (_) {
      safeMeta = null;
    }
  }
  try {
    return db.recordAuditEvent({
      programId,
      actorId,
      action,
      entityType,
      entityId: entityId === null || entityId === undefined ? null : String(entityId),
      metadata: safeMeta,
    });
  } catch (e) {
    log.warn("audit", `record failed (${action}): ${e.message}`);
    return null;
  }
}

module.exports = { record };
