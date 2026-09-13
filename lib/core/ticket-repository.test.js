process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createPersistence } = require("./persistence");
const { createTicketRepository } = require("./ticket-repository");
const db = require("../db");
const audit = require("../audit");

const persistence = createPersistence();
const tickets = createTicketRepository({ persistence });
const tenant = { programId: "core-program", workspaceId: "core-workspace" };
let sequence = 0;

before(() => {
  persistence.lifecycle.close();
  persistence.lifecycle.open(":memory:");
});

after(() => persistence.lifecycle.close());

function create(overrides = {}) {
  sequence += 1;
  return tickets.create({
    ...tenant,
    channel: "C-core",
    threadTs: `core-thread-${sequence}`,
    requesterId: "U-requester",
    question: "How do I get help?",
    ...overrides,
  });
}

test("creates idempotently and records one creation event", () => {
  const input = { ...tenant, channel: "C-core", threadTs: "core-idempotent", requesterId: "U1", question: "q" };
  const first = tickets.create(input);
  const second = tickets.create(input);
  assert.equal(first.id, second.id);
  assert.equal(tickets.events(first.id, tenant.programId, tenant.workspaceId).filter((e) => e.event_type === "created").length, 1);
});

test("preserves transition status names, predicates, and event rows", () => {
  const ticket = create();
  const transition = (name, ...args) => tickets[name](ticket.id, tenant.programId, tenant.workspaceId, "U-helper", ...args);
  assert.equal(transition("claim").ticket.status, "claimed");
  assert.equal(transition("assign", "U-other").ticket.status, "assigned");
  assert.equal(transition("unclaim").ticket.status, "open");
  assert.equal(transition("waiting").ticket.status, "waiting_for_helper");
  assert.equal(transition("claim").ticket.status, "claimed");
  assert.equal(transition("escalate").ticket.status, "escalated");
  assert.equal(transition("waiting").ticket.status, "waiting_for_helper");
  assert.equal(transition("resolve", "fixed").ticket.status, "resolved");
  assert.equal(transition("waiting").reason, "already_applied");
  assert.equal(transition("close").ticket.status, "closed");
  assert.equal(transition("reopen").ticket.status, "reopened");
  assert.equal(transition("snooze", Date.now() + 60_000).ticket.status, "snoozed");
  const events = tickets.events(ticket.id, tenant.programId, tenant.workspaceId);
  assert.deepEqual(events.map((event) => event.event_type), [
    "created", "claimed", "assigned", "unclaimed", "waiting_for_helper", "claimed", "escalated",
    "waiting_for_helper", "resolved", "closed", "reopened", "snoozed",
  ]);
});

test("duplicate overwrites canonical like legacy markDuplicateTicket", () => {
  const canonical = create();
  const canonical2 = create();
  const duplicate = create();
  const first = tickets.duplicate(duplicate.id, tenant.programId, tenant.workspaceId, "U-helper", canonical.id);
  assert.equal(first.ticket.status, "duplicate");
  assert.equal(first.ticket.duplicate_of, canonical.id);
  const second = tickets.duplicate(duplicate.id, tenant.programId, tenant.workspaceId, "U-helper", canonical2.id);
  assert.equal(second.ok, true);
  assert.equal(second.ticket.duplicate_of, canonical2.id);
  assert.equal(tickets.get(duplicate.id, "other-program", tenant.workspaceId), null);
});

test("reopenResolved only moves resolved/closed tickets", () => {
  const ticket = create();
  assert.equal(tickets.reopenResolved(ticket.id, tenant.programId, tenant.workspaceId, "U-helper").ok, false);
  assert.equal(tickets.resolve(ticket.id, tenant.programId, tenant.workspaceId, "U-helper", "fixed").ok, true);
  assert.equal(tickets.reopenResolved(ticket.id, tenant.programId, tenant.workspaceId, "U-helper").ticket.status, "reopened");
});

test("tenant predicates prevent cross-program and cross-workspace reads and writes", () => {
  const ticket = create();
  assert.equal(tickets.get(ticket.id, "other-program", tenant.workspaceId), null);
  assert.equal(tickets.claim(ticket.id, "other-program", tenant.workspaceId, "U-other").reason, "not_found");
  assert.equal(tickets.getByThreadTs(ticket.thread_ts, "other-program", tenant.workspaceId), null);
  assert.equal(tickets.list("other-program", tenant.workspaceId).length, 0);
  assert.equal(tickets.claim(ticket.id, tenant.programId, "other-workspace", "U-other").reason, "not_found");
  assert.equal(tickets.claim(ticket.id, tenant.programId, tenant.workspaceId, "U-helper").ok, true);
});

test("conditional claim is idempotent and only the first caller wins", () => {
  const ticket = create();
  const first = tickets.claim(ticket.id, tenant.programId, tenant.workspaceId, "U-first");
  const second = tickets.claim(ticket.id, tenant.programId, tenant.workspaceId, "U-second");
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_applied");
  assert.equal(tickets.get(ticket.id, tenant.programId, tenant.workspaceId).assignee_id, "U-first");
  assert.equal(tickets.events(ticket.id, tenant.programId, tenant.workspaceId).filter((e) => e.event_type === "claimed").length, 1);
});

/* ---------------- differential: repository vs direct db.js on the same DB -- */

test("repository and db share one handle on the same temp DB", () => {
  assert.equal(persistence.raw.handle(), db.handle());
});

test("differential create/get/list matches db.js row-for-row", () => {
  const scope = { programId: "diff-program", workspaceId: "diff-ws" };
  sequence += 1;
  const thread = `diff-thread-${sequence}`;
  const viaRepo = tickets.create({ ...scope, channel: "C-diff", threadTs: thread, requesterId: "U-diff", question: "diff q" });
  const viaDb = db.getTicket(viaRepo.id);
  assert.equal(viaDb.program_id, viaRepo.program_id);
  assert.equal(viaDb.workspace_id, viaRepo.workspace_id);
  assert.equal(viaDb.thread_ts, viaRepo.thread_ts);
  assert.equal(viaDb.status, "open");
  assert.equal(tickets.get(viaRepo.id, scope.programId, scope.workspaceId).id, viaDb.id);

  sequence += 1;
  const thread2 = `diff-thread-${sequence}`;
  const dbId = db.createTicket({ ...scope, channel: "C-diff", threadTs: thread2, requesterId: "U-diff", question: "db q" });
  const repoRead = tickets.get(dbId, scope.programId, scope.workspaceId);
  assert.equal(repoRead.id, dbId);
  assert.equal(repoRead.question, "db q");

  const repoIds = new Set(tickets.list(scope.programId, scope.workspaceId).map((t) => t.id));
  const dbIds = new Set(db.getTicketsForProgram(scope.programId).map((t) => t.id));
  for (const id of repoIds) assert.equal(dbIds.has(id), true);
});

test("differential transitions match db.js guards (claim/assign/resolve)", () => {
  const scope = { programId: "diff-trans", workspaceId: "diff-ws" };
  sequence += 1;
  const a = tickets.create({ ...scope, channel: "C-d", threadTs: `diff-t-${sequence}`, requesterId: "U1", question: "a" });
  sequence += 1;
  const bId = db.createTicket({ programId: scope.programId, workspaceId: scope.workspaceId, channel: "C-d", threadTs: `diff-t-${sequence}`, requesterId: "U1", question: "b" });

  // Twins start open on both paths.
  assert.equal(db.getTicket(a.id).status, "open");
  assert.equal(db.getTicket(bId).status, "open");

  // Claim via repo, claim via db: same conditional guard, same outcome.
  assert.equal(tickets.claim(a.id, scope.programId, scope.workspaceId, "U-h1").ok, true);
  assert.equal(db.claimTicket(bId, "U-h1"), true);
  assert.equal(tickets.get(a.id, scope.programId, scope.workspaceId).status, db.getTicket(bId).status);
  assert.equal(tickets.get(a.id, scope.programId, scope.workspaceId).assignee_id, db.getTicket(bId).assignee_id);

  // Resolve guard: first wins, second is a no-op on both paths.
  assert.equal(tickets.resolve(a.id, scope.programId, scope.workspaceId, "U-h1", "fixed").ok, true);
  assert.equal(db.resolveTicket(bId, "fixed", "U-h1"), true);
  assert.equal(tickets.resolve(a.id, scope.programId, scope.workspaceId, "U-h1", "again").ok, false);
  assert.equal(db.resolveTicket(bId, "again", "U-h1"), false);
  assert.equal(tickets.get(a.id, scope.programId, scope.workspaceId).status, db.getTicket(bId).status);
});

test("differential events: repository rows match db.js rows, tenant-guarded", () => {
  const scope = { programId: "diff-events", workspaceId: "diff-ws" };
  sequence += 1;
  const t = tickets.create({ ...scope, channel: "C-e", threadTs: `diff-e-${sequence}`, requesterId: "U1", question: "e" });
  const repoId = tickets.addEvent({ ticketId: t.id, programId: scope.programId, actorId: "U-h", eventType: "claimed", detail: { by: "diff" } });
  const dbId = db.addTicketEvent({ ticketId: t.id, programId: scope.programId, actorId: "U-h", eventType: "claimed", detail: { by: "diff" } });
  assert.ok(repoId > 0);
  assert.ok(dbId > 0);
  const repoRows = tickets.events(t.id, scope.programId, scope.workspaceId);
  const dbRows = db.listTicketEvents(t.id);
  // Same ticket: every repo row is a db row with identical type/detail shape.
  assert.equal(repoRows.length, dbRows.length);
  assert.deepEqual(repoRows.map((e) => e.event_type), dbRows.map((e) => e.event_type));
  // Cross-tenant addEvent is rejected instead of writing an orphan row.
  assert.equal(tickets.addEvent({ ticketId: t.id, programId: "other-program", eventType: "claimed" }), null);
  // Cross-tenant: db (unscoped) still sees rows, the repository misses.
  assert.equal(tickets.events(t.id, "other-program", scope.workspaceId).length, 0);
  assert.equal(db.listTicketEvents(t.id).length, repoRows.length);
});

test("differential notes: same trim/empty semantics as db.js, tenant-guarded", () => {
  const scope = { programId: "diff-notes", workspaceId: "diff-ws" };
  sequence += 1;
  const t = tickets.create({ ...scope, channel: "C-n", threadTs: `diff-n-${sequence}`, requesterId: "U1", question: "n" });
  const saved = tickets.addNote(t.id, scope.programId, scope.workspaceId, "U-helper", "  hello  ");
  assert.equal(saved.ok, true);
  assert.ok(saved.noteId > 0);
  const dbNoteId = db.addTicketNote({ ticketId: t.id, programId: scope.programId, authorId: "U-helper", body: "  world  " });
  assert.ok(dbNoteId > 0);
  // Empty bodies never persist on either path.
  assert.equal(db.addTicketNote({ ticketId: t.id, programId: scope.programId, authorId: "U-h", body: "   " }), null);
  const empty = tickets.addNote(t.id, scope.programId, scope.workspaceId, "U-h", "   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "note_body_required");
  // Same projection, same order.
  const repoBodies = tickets.notes(t.id, scope.programId, scope.workspaceId).map((n) => n.body);
  const dbBodies = db.listTicketNotes(t.id).map((n) => n.body);
  assert.deepEqual(repoBodies, dbBodies);
  assert.deepEqual(repoBodies, ["hello", "world"]);
  // Cross-tenant misses instead of leaking.
  assert.deepEqual(tickets.notes(t.id, "other-program", scope.workspaceId), []);
  assert.equal(tickets.addNote(t.id, "other-program", scope.workspaceId, "U-h", "x").reason, "not_found");
});

test("differential helpers: repository membership reads match db.js", () => {
  const programId = `diff-helpers-${(sequence += 1)}`;
  db.syncHelper({ programId, userId: "U-m1" });
  db.syncHelper({ programId, userId: "U-m2" });
  assert.deepEqual(tickets.helpers(programId).map((h) => h.user_id), db.listHelpers(programId).map((h) => h.user_id));
  assert.deepEqual(tickets.helpers(programId, false).map((h) => h.user_id), db.listHelpers(programId, false).map((h) => h.user_id));
  assert.equal(tickets.isHelper(programId, "U-m1"), db.isHelper(programId, "U-m1"));
  assert.equal(tickets.isHelper(programId, "U-stranger"), false);
  assert.equal(tickets.isHelper(programId, null), false);
  db.removeHelper({ programId, userId: "U-m2" });
  assert.equal(tickets.isHelper(programId, "U-m2"), false);
  assert.deepEqual(tickets.helpers(programId).map((h) => h.user_id), ["U-m1"]);
  // Membership is program-scoped only: another program sees nobody.
  assert.deepEqual(tickets.helpers(`${programId}-other`), []);
});

test("differential audit writes match audit.record packing", () => {
  const programId = `diff-audit-${(sequence += 1)}`;
  const repoId = tickets.recordAudit({ programId, actorId: "U-h", action: "ticket.claimed", entityType: "ticket", entityId: 42, metadata: { by: "diff" } });
  assert.ok(repoId > 0);
  const viaHelper = audit.record({ programId, actorId: "U-h", action: "ticket.claimed", entityType: "ticket", entityId: 42, metadata: { by: "diff" } });
  assert.ok(viaHelper > 0);
  const rows = db.listAuditEvents({ programId });
  const ours = rows.filter((r) => r.action === "ticket.claimed");
  assert.ok(ours.length >= 2);
  // Objects stringify once, entity ids stringify, strings pass through.
  assert.equal(ours[0].metadata, JSON.stringify({ by: "diff" }));
  assert.equal(ours[0].entity_id, "42");
  const strId = tickets.recordAudit({ programId, actorId: "U-h", action: "ticket.note_added", metadata: "plain" });
  assert.ok(strId > 0);
  assert.equal(db.listAuditEvents({ programId }).find((r) => r.action === "ticket.note_added").metadata, "plain");
  // Missing action persists nothing on either path.
  assert.equal(tickets.recordAudit({ programId, action: "" }), null);
  assert.equal(audit.record({ programId, action: "" }), null);
});

test("mixed concurrency: repo claim vs direct db claim, only the first wins", () => {
  const scope = { programId: "diff-race", workspaceId: "diff-ws" };
  sequence += 1;
  const t = tickets.create({ ...scope, channel: "C-r", threadTs: `diff-r-${sequence}`, requesterId: "U1", question: "race" });
  assert.equal(tickets.claim(t.id, scope.programId, scope.workspaceId, "U-repo").ok, true);
  assert.equal(db.claimTicket(t.id, "U-db"), false);
  assert.equal(db.getTicket(t.id).assignee_id, "U-repo");

  sequence += 1;
  const otherId = db.createTicket({ programId: scope.programId, workspaceId: scope.workspaceId, channel: "C-r", threadTs: `diff-r-${sequence}`, requesterId: "U1", question: "race2" });
  assert.equal(db.claimTicket(otherId, "U-db"), true);
  assert.equal(tickets.claim(otherId, scope.programId, scope.workspaceId, "U-repo").ok, false);
  assert.equal(db.getTicket(otherId).assignee_id, "U-db");
});

test("transitions record both event and audit rows like legacy recordTransition", () => {
  const ticket = create();
  assert.equal(tickets.claim(ticket.id, tenant.programId, tenant.workspaceId, "U-helper").ok, true);
  assert.equal(
    tickets.events(ticket.id, tenant.programId, tenant.workspaceId).filter((e) => e.event_type === "claimed").length,
    1,
  );
  assert.ok(
    db.listAuditEvents({ programId: tenant.programId }).some((e) => e.action === "ticket.claimed"),
    "claim transition writes an audit row",
  );
});

test("cross-program and cross-workspace isolation holds for every surface", () => {
  const scope = { programId: "diff-iso", workspaceId: "diff-ws-a" };
  sequence += 1;
  const t = tickets.create({ ...scope, channel: "C-i", threadTs: `diff-i-${sequence}`, requesterId: "U1", question: "iso" });
  tickets.addNote(t.id, scope.programId, scope.workspaceId, "U-h", "secret");
  tickets.addEvent({ ticketId: t.id, programId: scope.programId, actorId: "U-h", eventType: "claimed", detail: null });
  // Wrong program misses everywhere.
  assert.equal(tickets.get(t.id, "other-program", scope.workspaceId), null);
  assert.equal(tickets.getByThreadTs(t.thread_ts, "other-program", scope.workspaceId), null);
  assert.deepEqual(tickets.list("other-program", scope.workspaceId), []);
  assert.deepEqual(tickets.events(t.id, "other-program", scope.workspaceId), []);
  assert.deepEqual(tickets.notes(t.id, "other-program", scope.workspaceId), []);
  assert.equal(tickets.claim(t.id, "other-program", scope.workspaceId, "U-h").reason, "not_found");
  // Program-only list keeps legacy getTicketsForProgram semantics.
  assert.ok(tickets.list(scope.programId).some((row) => row.id === t.id));
  // Wrong workspace misses everywhere (tenant predicate is program + workspace).
  assert.equal(tickets.get(t.id, scope.programId, "other-ws"), null);
  assert.deepEqual(tickets.list(scope.programId, "other-ws"), []);
  assert.deepEqual(tickets.events(t.id, scope.programId, "other-ws"), []);
  assert.deepEqual(tickets.notes(t.id, scope.programId, "other-ws"), []);
  // The authoritative tenant still sees everything.
  assert.equal(tickets.get(t.id, scope.programId, scope.workspaceId).id, t.id);
  assert.equal(tickets.notes(t.id, scope.programId, scope.workspaceId).length, 1);
});
