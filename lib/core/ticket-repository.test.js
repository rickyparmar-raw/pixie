process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createPersistence } = require("./persistence");
const { createTicketRepository } = require("./ticket-repository");

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

test("duplicate requires no special repository-side mutation and is idempotent", () => {
  const canonical = create();
  const duplicate = create();
  const first = tickets.duplicate(duplicate.id, tenant.programId, tenant.workspaceId, "U-helper", canonical.id);
  const second = tickets.duplicate(duplicate.id, tenant.programId, tenant.workspaceId, "U-helper", canonical.id);
  assert.equal(first.ticket.status, "duplicate");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_applied");
  assert.equal(tickets.get(duplicate.id, "other-program", tenant.workspaceId), null);
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
