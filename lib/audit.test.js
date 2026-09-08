// STEP 1 characterization pins for lib/audit.js (PLATFORM FOUNDATION).
// Append-only audit log: insert-only, fail-closed to null, metadata
// stringified, no update/delete surface.
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const audit = require("./audit");

db.open(":memory:");

test("char: record persists a tenant-scoped row and returns its id", () => {
  const id = audit.record({ programId: "char-audit", actorId: "U1", action: "char.tested", entityType: "ticket", entityId: 7, metadata: { k: "v" } });
  assert.ok(typeof id === "number");
  const rows = db.listAuditEvents({ programId: "char-audit" });
  assert.ok(rows.some((r) => r.id === id && r.action === "char.tested" && r.entity_id === "7"));
});

test("char: metadata objects are stringified, strings pass through", () => {
  const id = audit.record({ programId: "char-audit", actorId: "U1", action: "char.meta", metadata: { a: 1 } });
  const row = db.listAuditEvents({ programId: "char-audit" }).find((r) => r.id === id);
  assert.equal(row.metadata, JSON.stringify({ a: 1 }));
  const id2 = audit.record({ programId: "char-audit", actorId: "U1", action: "char.meta2", metadata: "raw-string" });
  const row2 = db.listAuditEvents({ programId: "char-audit" }).find((r) => r.id === id2);
  assert.equal(row2.metadata, "raw-string");
});

test("char: missing action records nothing", () => {
  assert.equal(audit.record({ programId: "char-audit", actorId: "U1" }), null);
  assert.equal(audit.record({}), null);
});

test("char: write failures return null instead of throwing", () => {
  const orig = db.recordAuditEvent;
  db.recordAuditEvent = () => { throw new Error("db down"); };
  try {
    assert.equal(audit.record({ programId: "char-audit", actorId: "U1", action: "char.fail" }), null);
  } finally {
    db.recordAuditEvent = orig;
  }
});

test("char: the module exposes no update or delete path", () => {
  assert.equal(typeof audit.record, "function");
  assert.equal(audit.update, undefined);
  assert.equal(audit.delete, undefined);
  assert.equal(audit.remove, undefined);
});

test("char: audit rows are tenant-isolated on read", () => {
  audit.record({ programId: "char-audit-a", actorId: "U1", action: "char.a" });
  const rows = db.listAuditEvents({ programId: "char-audit-b" });
  assert.ok(!rows.some((r) => r.action === "char.a"));
});
