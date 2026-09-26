const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const lease = require("./jobLease");
const watcher = require("./resolutionWatcher");

let sequence = 0;

function setupProgram(extra = {}) {
  const id = `auto-${++sequence}`;
  const program = {
    id,
    name: id,
    helpChannel: `C-${id}`,
    channels: [`C-${id}`],
    organizerChannel: `O-${id}`,
    behavior: { help: { autoResolve: true } },
    ...extra,
  };
  db.saveProgram(program);
  programs.invalidate();
  return program;
}

function makeTicket(program, extra = {}) {
  const id = db.createTicket({
    programId: program.id,
    channel: program.helpChannel,
    threadTs: `thread-${program.id}`,
    requesterId: "U-REQUESTER",
    question: "The device is broken",
  });
  const ticket = db.getTicket(id);
  if (extra.status || extra.updated_at || extra.created_at) {
    db.handle().query("UPDATE tickets SET status = COALESCE(?, status), created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at) WHERE id = ?").run(extra.status || null, extra.created_at || null, extra.updated_at || null, id);
  }
  return db.getTicket(ticket.id);
}

function clientFor(messages, posts = [], updates = []) {
  return {
    conversations: { replies: async () => ({ messages }) },
    chat: {
      postMessage: async (payload) => { posts.push(payload); return { ts: `post-${posts.length}` }; },
      update: async (payload) => { updates.push(payload); return { ok: true }; },
    },
    reactions: { add: async () => {}, remove: async () => {} },
  };
}

beforeEach(() => watcher.stop());
afterEach(() => watcher.stop());

test("resolved judgement uses canonical resolve, credits the helper, and schedules pipeline work", async () => {
  const program = setupProgram();
  db.syncHelper({ programId: program.id, userId: "U-HELPER", source: "manual" });
  const ticket = makeTicket(program);
  db.addTicketEvent({ ticketId: ticket.id, programId: program.id, actorId: "U-HELPER", eventType: "helper_reply", detail: { ts: "2", text: "Try restarting it." } });
  const client = clientFor([
    { ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question },
    { ts: "2", user: "U-HELPER", text: "Try restarting it." },
    { ts: "3", user: "U-REQUESTER", text: "Thanks, that worked." },
  ]);
  const out = await watcher.judgeTicket(ticket.id, {
    client,
    program,
    judge: async () => ({ verdict: "resolved", confidence: 0.91, reason: "requester confirmed the fix" }),
  });
  const resolved = db.getTicket(ticket.id);
  const event = db.listTicketEvents(ticket.id).find((row) => row.event_type === "resolved");
  assert.equal(out.result.ok, true);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolved_by, "U-HELPER");
  assert.match(resolved.resolution, /^auto-resolved:/);
  assert.deepEqual(JSON.parse(event.detail), { source: "auto", verdict: "resolved", confidence: 0.91, reason: "requester confirmed the fix" });
  assert.equal(event.actor_id, "U-HELPER");
});

test("unresolved, low confidence, no answer, Jev errors, and disabled programs do not resolve", async () => {
  const cases = [
    [{ verdict: "unresolved", confidence: 0.99 }, "decision"],
    [{ verdict: "resolved", confidence: 0.79 }, "decision"],
    [null, "no-answer"],
    [{ verdict: "unknown" }, "error"],
  ];
  for (const [decision, kind] of cases) {
    const program = setupProgram();
    const ticket = makeTicket(program);
    const messages = kind === "no-answer"
      ? [{ ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question }]
      : [{ ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question }, { ts: "2", bot_id: "B-PIXIE", text: "An answer" }, { ts: "3", user: "U-REQUESTER", text: "Still checking." }];
    let calls = 0;
    const out = await watcher.judgeTicket(ticket.id, {
      client: clientFor(messages),
      program,
      judge: async () => { calls += 1; if (kind === "error") throw new Error("jev unavailable"); return decision; },
    });
    assert.equal(db.getTicket(ticket.id).status, "open", kind);
    assert.equal(calls, kind === "no-answer" ? 0 : 1, kind);
    assert.ok(out);
  }
  const disabled = setupProgram({ behavior: { help: { autoResolve: false } } });
  const disabledTicket = makeTicket(disabled);
  let disabledCalls = 0;
  await watcher.judgeTicket(disabledTicket.id, { program: disabled, judge: async () => { disabledCalls += 1; return { verdict: "resolved", confidence: 1 }; } });
  assert.equal(disabledCalls, 0);
  assert.equal(db.getTicket(disabledTicket.id).status, "open");
});

test("dashboard-only tickets stay silent and visible tickets only reconcile existing messages", async () => {
  const silentProgram = setupProgram({ publicTicketsEnabled: false, ticketVisibility: "dashboard" });
  const posts = [];
  const silentTicket = await require("./tickets").ensureSupportTicket({ program: silentProgram, channel: silentProgram.helpChannel, threadTs: `silent-${silentProgram.id}`, requesterId: "U-REQUESTER", question: "silent question", client: clientFor([], posts) });
  assert.ok(silentTicket);
  assert.equal(posts.length, 0);
  await watcher.judgeTicket(silentTicket.id, {
    program: silentProgram,
    client: clientFor([
      { ts: silentTicket.thread_ts, user: "U-REQUESTER", text: silentTicket.question },
      { ts: "2", bot_id: "B-PIXIE", text: "Solved." },
      { ts: "3", user: "U-REQUESTER", text: "Thanks." },
    ], posts),
    judge: async () => ({ verdict: "resolved", confidence: 0.95, reason: "helper completed the fix" }),
  });
  assert.equal(db.getTicket(silentTicket.id).status, "resolved");
  assert.equal(posts.length, 0);

  const visible = setupProgram({ ticketVisibility: "thread" });
  const visibleTicket = makeTicket(visible);
  db.handle().query("UPDATE tickets SET card_ts = ?, public_ack_ts = ? WHERE id = ?").run("card", "ack", visibleTicket.id);
  const updates = [];
  await watcher.judgeTicket(visibleTicket.id, {
    program: visible,
    client: clientFor([{ ts: visibleTicket.thread_ts, user: "U-REQUESTER", text: visibleTicket.question }, { ts: "2", bot_id: "B-PIXIE", text: "Solved." }, { ts: "3", user: "U-REQUESTER", text: "Thanks." }], [], updates),
    judge: async () => ({ verdict: "resolved", confidence: 0.95, reason: "helper completed the fix" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(updates.some((update) => update.ts === "card"));
  assert.ok(updates.some((update) => update.ts === "ack"));
  assert.equal(updates.some((update) => update.method === "postMessage"), false);
});

test("debounce judges one burst and stale sweep honors the job lease", async () => {
  const program = setupProgram();
  const ticket = makeTicket(program);
  const client = clientFor([{ ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question }, { ts: "2", bot_id: "B-PIXIE", text: "Solved." }, { ts: "3", user: "U-REQUESTER", text: "Thanks." }]);
  let calls = 0;
  const judge = async () => { calls += 1; return { verdict: "unresolved", confidence: 0.9 }; };
  watcher.schedule({ ticketId: ticket.id, program, client, judge, delayMs: 5 });
  watcher.schedule({ ticketId: ticket.id, program, client, judge, delayMs: 5 });
  watcher.schedule({ ticketId: ticket.id, program, client, judge, delayMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);

  const old = makeTicket(program, { created_at: Date.now() - 7 * 60 * 60 * 1000, updated_at: Date.now() - 7 * 60 * 60 * 1000 });
  const holder = lease.acquire("ticket-resolution-sweep", 60 * 1000);
  const skipped = await watcher.sweepStale({ client, now: Date.now(), judge, useLease: true });
  assert.equal(skipped.judged, 0);
  lease.release("ticket-resolution-sweep", holder.owner);
  await watcher.sweepStale({ client, now: Date.now(), judge, useLease: false });
  assert.equal(db.getTicket(old.id).status, "open");
});
