process.env.PIXIE_DB_PATH = ":memory:";
process.env.JEV_ENABLED = "false";
process.env.PIXIE_RESOLUTION_PIPELINE = "false";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const backfill = require("./ticketBackfill");
const watcher = require("./resolutionWatcher");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const ts = (at) => String(at / 1000);

function setup() {
  db.close();
  db.open(":memory:");
  watcher.stop();
  const program = {
    id: "backfill-pixl",
    name: "Pixl",
    helpChannel: "C-HELP",
    channels: ["C-HELP"],
    posture: "active",
    publicTicketsEnabled: false,
    ticketVisibility: "thread",
    behavior: { help: { autoResolve: true } },
  };
  db.saveProgram(program);
  db.syncHelper({ programId: program.id, userId: "U-HELPER", source: "manual" });
  programs.invalidate();
  return program;
}

function fakeClient(rawMessages, repliesByTs, posts = []) {
  const calls = { history: 0, replies: 0 };
  // Real conversations.history carries reply_count on thread parents.
  const messages = rawMessages.map((m) => ({ ...m, reply_count: Math.max(0, (repliesByTs[m.ts] || []).length - 1) || ((repliesByTs[m.ts] || []).length ? 1 : 0) }));
  return {
    calls,
    conversations: {
      history: async ({ cursor }) => {
        calls.history += 1;
        return cursor
          ? { messages: messages.slice(3), response_metadata: { next_cursor: "" } }
          : { messages: messages.slice(0, 3), response_metadata: { next_cursor: "page-2" } };
      },
      replies: async ({ ts: threadTs }) => {
        calls.replies += 1;
        return { messages: repliesByTs[threadTs] || [] };
      },
    },
    chat: {
      postMessage: async (payload) => { posts.push(payload); throw new Error("history import posted to Slack"); },
      update: async () => { throw new Error("history import updated Slack"); },
    },
    reactions: { add: async () => { throw new Error("history import reacted in Slack"); } },
  };
}

test("history import creates, enriches, resolves, closes, queues, and stays silent", async () => {
  const program = setup();
  const messages = [
    { ts: ts(NOW - 9 * DAY), user: "U-ONE", text: "helper answer" },
    { ts: ts(NOW - 8 * DAY), user: "U-TWO", text: "checkmark answer", reactions: [{ name: "white_check_mark", users: ["U-TWO"] }] },
    { ts: ts(NOW - 6 * DAY), user: "U-THREE", text: "Pixie answered" },
    { ts: ts(NOW - 10 * DAY), user: "U-FOUR", text: "no answer" },
    { ts: ts(NOW - 5 * DAY), user: "U-FIVE", text: "already tracked" },
  ];
  const tracked = db.createTicket({ programId: program.id, channel: program.helpChannel, threadTs: messages[4].ts, requesterId: "U-FIVE", question: "already tracked", createdAt: NOW - 5 * DAY });
  const replies = {
    [messages[0].ts]: [messages[0], { ts: ts(NOW - 8 * DAY), user: "U-HELPER", text: "Try this fix." }, { ts: ts(NOW - 7 * DAY), user: "U-ONE", text: "Thanks, that worked." }],
    [messages[1].ts]: [messages[1], { ts: ts(NOW - 7 * DAY), user: "U-HELPER", text: "The fix is to restart it." }],
    [messages[2].ts]: [messages[2], { ts: ts(NOW - 5 * DAY), bot_id: "B-PIXIE", text: "Here is the answer." }],
    [messages[3].ts]: [messages[3]],
    [messages[4].ts]: [messages[4], { ts: ts(NOW - 4 * DAY), user: "U-HELPER", text: "The missing historical reply." }],
  };
  db.addTicketEvent({ ticketId: tracked, programId: program.id, actorId: "U-HELPER", eventType: "helper_reply", detail: { ts: "old-reply", text: "already present" }, createdAt: NOW - 4 * DAY });
  const posts = [];
  const client = fakeClient(messages, replies, posts);
  await backfill.importProgram(program, client, { now: () => NOW, spacingMs: 0, sleepFn: async () => {}, autoStartJudge: false });

  const rows = db.getTicketsForProgram(program.id);
  assert.equal(rows.length, 5);
  // thanks + checkmark + last word (the helper replied last, requester quiet 4 days)
  assert.equal(rows.filter((row) => row.status === "resolved").length, 3);
  const lastWord = rows.find((row) => row.requester_id === "U-FIVE");
  assert.equal(lastWord.resolved_credit_id, "U-HELPER");
  assert.equal(lastWord.resolved_at, NOW - 4 * DAY);
  assert.equal(rows.find((row) => row.requester_id === "U-FOUR").status, "closed");
  assert.equal(rows.find((row) => row.requester_id === "U-FOUR").resolution, "no answer (history import)");
  assert.equal(rows.every((row) => row.visibility === "dashboard"), true);
  assert.equal(rows.find((row) => row.requester_id === "U-ONE").resolved_at, NOW - 7 * DAY);
  assert.equal(rows.find((row) => row.requester_id === "U-TWO").resolved_by, "U-HELPER");
  assert.equal(db.listTicketEvents(rows.find((row) => row.requester_id === "U-ONE").id).find((event) => event.event_type === "helper_reply").created_at, NOW - 8 * DAY);
  assert.equal(db.listTicketEvents(rows.find((row) => row.requester_id === "U-ONE").id).filter((event) => event.event_type === "requester_followup").length, 1);
  assert.equal(backfill.getProgress(program.id).messagesScanned, 5);
  assert.equal(backfill.getProgress(program.id).queuedForJudge, 1);
  assert.deepEqual(posts, []);
});

test("history import reruns without duplicates and resumes a failed replies page", async () => {
  const program = setup();
  const messages = [
    { ts: ts(NOW - DAY), user: "U-ONE", text: "one", reply_count: 1 },
    { ts: ts(NOW - 2 * DAY), user: "U-TWO", text: "two" },
  ];
  const historyOldest = [];
  let fail = true;
  const replies = {
    [messages[0].ts]: [messages[0], { ts: ts(NOW - 12 * 60 * 60 * 1000), user: "U-HELPER", text: "answer" }],
    [messages[1].ts]: [messages[1]],
  };
  const client = {
    conversations: {
      history: async ({ oldest }) => { historyOldest.push(oldest); return { messages }; },
      replies: async ({ ts: threadTs }) => {
        if (threadTs === messages[0].ts && fail) { fail = false; throw new Error("crash mid-page"); }
        return { messages: replies[threadTs] };
      },
    },
  };
  await assert.rejects(backfill.importProgram(program, client, { now: () => NOW, spacingMs: 0, sleepFn: async () => {}, autoStartJudge: false }), /crash mid-page/);
  assert.equal(db.getTicketsForProgram(program.id).length, 2);
  await backfill.importProgram(program, client, { now: () => NOW, spacingMs: 0, sleepFn: async () => {}, autoStartJudge: false });
  await backfill.importProgram(program, client, { now: () => NOW, spacingMs: 0, sleepFn: async () => {}, autoStartJudge: false });
  assert.equal(db.getTicketsForProgram(program.id).length, 2);
  for (const ticket of db.getTicketsForProgram(program.id)) {
    const events = db.listTicketEvents(ticket.id);
    assert.equal(events.filter((event) => event.event_type === "created").length, 1);
    assert.equal(events.filter((event) => event.event_type === "helper_reply").length, ticket.requester_id === "U-ONE" ? 1 : 0);
  }
  assert.equal(historyOldest.at(-1), messages[0].ts);
});

test("backfill resolution skips the resolution pipeline", async () => {
  const program = setup();
  const thread = { ts: ts(NOW - DAY), user: "U-ONE", text: "fix" };
  const client = fakeClient([thread], { [thread.ts]: [thread, { ts: ts(NOW - 12 * 60 * 60 * 1000), user: "U-HELPER", text: "done" }, { ts: ts(NOW - 6 * 60 * 60 * 1000), user: "U-ONE", text: "got it" }] });
  const pipeline = require("./resolutionPipeline");
  const original = pipeline.schedule;
  let scheduled = 0;
  pipeline.schedule = () => { scheduled += 1; };
  try {
    await backfill.importProgram(program, client, { now: () => NOW, spacingMs: 0, sleepFn: async () => {}, autoStartJudge: false });
  } finally {
    pipeline.schedule = original;
  }
  assert.equal(scheduled, 0);
});

test("history import internal route starts work and rejects missing auth", async () => {
  const program = setup();
  const savedToken = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = "backfill-route-token";
  const api = require("./web/api");
  const serve = require("./web/serve");
  api.setSlackClient({ conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) } });
  try {
    const path = `/internal/programs/${program.id}/history-import`;
    const progress = await serve.handleRequest(new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer backfill-route-token" } }));
    assert.equal(progress.status, 200);
    assert.equal((await progress.json()).status, "pending");
    const started = await serve.handleRequest(new Request(`http://localhost${path}`, { method: "POST", headers: { Authorization: "Bearer backfill-route-token", "Content-Type": "application/json" }, body: "{}" }));
    assert.equal(started.status, 200);
    assert.equal((await started.json()).started, true);
    const denied = await serve.handleRequest(new Request(`http://localhost${path}`));
    assert.equal(denied.status, 401);
  } finally {
    backfill.stop();
    if (savedToken === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = savedToken;
  }
});

test("backfill judge lane spaces calls and honors Jev backoff", async () => {
  const program = setup();
  const makeTicket = (name) => {
    const id = db.createTicket({ programId: program.id, channel: program.helpChannel, threadTs: name, requesterId: `U-${name}`, question: name });
    db.addTicketEvent({ ticketId: id, programId: program.id, actorId: "U-HELPER", eventType: "helper_reply", detail: { ts: `${name}-reply` } });
    return id;
  };
  const first = makeTicket("thread-one");
  const second = makeTicket("thread-two");
  const client = { conversations: { replies: async ({ ts: threadTs }) => ({ messages: [{ ts: threadTs, user: "U-requester", text: "question" }, { ts: `${threadTs}-reply`, user: "U-HELPER", text: "answer" }] }) } };
  let calls = 0;
  const judge = async () => { calls += 1; return { verdict: "unresolved", confidence: 1 }; };
  watcher.enqueueForJudge({ ticketId: first, client, program, judge, autoStart: false });
  watcher.enqueueForJudge({ ticketId: second, client, program, judge, autoStart: false });
  await watcher.drainBacklog({ now: 1000, spacingMs: 20000 });
  const spaced = await watcher.drainBacklog({ now: 1001, spacingMs: 20000 });
  assert.equal(calls, 1);
  assert.equal(spaced.reason, "spacing");
  watcher.stop();

  const limitedTicket = makeTicket("thread-limited");
  const queuedTicket = makeTicket("thread-queued");
  const limited = async () => { calls += 1; return { verdict: "unknown", errorKind: "rate_limit" }; };
  watcher.enqueueForJudge({ ticketId: limitedTicket, client, program, judge: limited, autoStart: false });
  await watcher.drainBacklog({ now: Date.now(), spacingMs: 0 });
  watcher.enqueueForJudge({ ticketId: queuedTicket, client, program, judge: limited, autoStart: false });
  const backoff = await watcher.drainBacklog({ now: Date.now(), spacingMs: 0 });
  assert.equal(backoff.reason, "backoff");
});

afterEach(() => watcher.stop());

test("a rules-version bump re-walks the channel from the start with fresh counts", async () => {
  const program = setup();
  const thread = { ts: ts(NOW - 10 * DAY), user: "U-ONE", text: "q" };
  const client = fakeClient([thread], { [thread.ts]: [thread, { ts: ts(NOW - 9 * DAY), user: "U-HELPER", text: "a" }] });
  db.upsertHistoryImportProgress(program.id, program.helpChannel, { status: "done", newestTsDone: thread.ts, rulesVersion: 1, resolved: 7 });
  await backfill.importProgram(program, client, { now: () => NOW, spacingMs: 0, sleepFn: async () => {}, autoStartJudge: false });
  const progress = db.getHistoryImportProgress(program.id, program.helpChannel);
  assert.equal(progress.rules_version, 2);
  assert.equal(progress.status, "done");
  assert.equal(progress.resolved, 1, "counts restart instead of adding to the old 7");
  assert.equal(db.getTicketsForProgram(program.id)[0].status, "resolved");
});

test("a passive program with its ticket toggles off still gets every help thread as a dashboard ticket", async () => {
  db.close();
  db.open(":memory:");
  watcher.stop();
  const program = {
    id: "backfill-passive", name: "Passive Pixl", helpChannel: "C-PASSIVE", channels: ["C-PASSIVE"], posture: "passive",
    publicTicketsEnabled: true, ticketVisibility: "thread", behavior: { help: { ticketsEnabled: false, autoCreateTickets: false } },
  };
  db.saveProgram(program);
  programs.invalidate();
  const thread = { ts: ts(NOW - 3 * DAY), user: "U-ONE", text: "how do tiers work" };
  const posts = [];
  const client = fakeClient([thread], { [thread.ts]: [thread] }, posts);
  await backfill.importProgram(programs.get(program.id) || program, client, { now: () => NOW, spacingMs: 0, sleepFn: async () => {}, autoStartJudge: false });
  const rows = db.getTicketsForProgram(program.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visibility, "dashboard");
  assert.deepEqual(posts, []);
});
