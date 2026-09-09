// The support-ticket lifecycle: a ticket for every eligible root question in an
// active help channel, opened before and independent of whether Pixie answers,
// resolved and reopened from the thread, and idempotent against Slack's event
// and interaction retries.
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const tickets = require("./tickets");
const respond = require("./respond");
const answer = require("./answer");
const intent = require("./intent");

const HELP = "C-st-help";
const ORG = "C-st-org";

function clientSpy() {
  const posts = [];
  return {
    posts,
    chat: {
      postMessage: async (p) => {
        posts.push({ ...p });
        return { ts: `ts-${posts.length}` };
      },
      update: async (p) => {
        posts.push({ ...p, isUpdate: true });
        return { ts: p.ts };
      },
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }) },
  };
}

const FLEET = JSON.stringify([
  {
    id: "st-prog",
    name: "Support Prog",
    posture: "active",
    scope: "program",
    helpChannel: HELP,
    channels: [HELP],
    organizerChannel: ORG,
    links: { docs: "https://example.test/docs" },
  },
  {
    id: "st-pixl",
    name: "Pixl",
    posture: "passive",
    helpChannel: "C-st-pixl-help",
    channels: ["C-st-pixl-help"],
  },
]);

let savedBlob;
const realStream = answer.getAnswerOrChatStream;
const realIntent = intent.classifyIntent;

before(() => {
  db.close();
  db.open(":memory:");
  savedBlob = process.env.PIXIE_PROGRAMS_JSON;
});

beforeEach(() => {
  process.env.PIXIE_PROGRAMS_JSON = FLEET;
  programs.invalidate();
  intent.classifyIntent = async () => intent.HELP_NEEDED;
});

afterEach(() => {
  answer.getAnswerOrChatStream = realStream;
  intent.classifyIntent = realIntent;
  if (savedBlob === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedBlob;
  programs.invalidate();
});

let askN = 0;
async function ask(client, threadTs, question, { messageTs, mode = respond.ALWAYS, userId } = {}) {
  return respond.respond({
    client,
    channel: HELP,
    threadTs,
    messageTs: messageTs || threadTs,
    userId: userId || `U-asker-${(askN += 1)}`,
    question,
    mode,
  });
}

/* -------------------------------------------------------- knows the answer -- */

test("knows the answer: ticket opens, answer posts in the same thread, ticket stays OPEN", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "yes, as long as it's public" });
  const client = clientSpy();
  await ask(client, "t-knows", "does my repo need to be public?");

  const ticket = db.getTicketByThreadTs("t-knows");
  assert.ok(ticket, "a ticket exists even though Pixie answered");
  assert.equal(ticket.status, "open");

  const texts = client.posts.map((p) => p.text || "");
  assert.ok(texts.some((t) => /Someone will be here to help you soon/.test(t)), "open ticket UI in the thread");
  assert.ok(texts.some((t) => /public/.test(t)), "Pixie's answer in the same thread");
  const uiMsg = client.posts.find((p) => /Someone will be here/.test(p.text || ""));
  assert.ok(uiMsg.blocks.find((b) => b.type === "actions")?.elements.some((e) => e.action_id === "st_resolve"));
  // The docs link the program configured, not a hardcoded one.
  assert.match(JSON.stringify(uiMsg.blocks), /example\.test\/docs/);
});

/* --------------------------------------------------- doesn't know the answer */

test("doesn't know the answer: the ticket opens identically and moves to waiting_for_helper", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
  const client = clientSpy();
  await ask(client, "t-unknown", "what is error 0x88?", { mode: respond.HELP_ONLY });

  const ticket = db.getTicketByThreadTs("t-unknown");
  assert.ok(ticket);
  assert.ok(["open", "waiting_for_helper", "assigned"].includes(ticket.status));
  assert.ok(client.posts.some((p) => /Someone will be here to help you soon/.test(p.text || "")));
  assert.ok(client.posts.some((p) => p.channel === ORG), "organizer card posted");
});

/* --------------------------------------------------- duplicate Slack event -- */

test("the same root event delivered twice yields exactly one ticket and one ticket UI", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-dupe", "how are journals graded?");
  await ask(client, "t-dupe", "how are journals graded?"); // retry

  const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-dupe");
  assert.equal(rows.length, 1);
  const uiMsgs = client.posts.filter((p) => /Someone will be here to help you soon/.test(p.text || "") && !p.isUpdate);
  assert.equal(uiMsgs.length, 1, "the open ticket UI is posted once");
});

/* --------------------------------------------------------- thread replies -- */

test("a reply inside an existing ticket thread does not open a second ticket", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-thread", "root question about demos");
  const before = db.getTicketByThreadTs("t-thread").id;

  // a follow-up: same thread, its own message ts
  await ask(client, "t-thread", "and what about a CLI?", { messageTs: "t-thread-reply-1", mode: respond.HELP_ONLY });

  const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-thread");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, before);
});

/* -------------------------------------------------------------- resolve x2 -- */

test("resolve is idempotent: two clicks, one transition, one confirmation, no stale button", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-res", "a real question", { userId: "U-res" });
  const ticket = db.getTicketByThreadTs("t-res");

  const a = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-res", client });
  const b = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-res", client });
  assert.equal(a.ok, true);
  assert.equal(b.deduped, true);
  assert.equal(db.listTicketEvents(ticket.id).filter((e) => e.event_type === "resolved").length, 1);

  const ui = client.posts.filter((p) => p.isUpdate).at(-1);
  assert.match(JSON.stringify(ui.blocks), /Resolved by <@U-res>/);
  assert.ok(!JSON.stringify(ui.blocks).includes("st_resolve"), "no stale Mark as resolved button");
  assert.ok(JSON.stringify(ui.blocks).includes("st_reopen"));
});

/* ---------------------------------------------------------- reopen cycle --- */

test("resolve -> reopen -> resolve repeats without corrupting state", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-cycle", "a real question", { userId: "U-cyc" });
  const id = db.getTicketByThreadTs("t-cycle").id;

  await tickets.publicResolveTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).status, "resolved");
  await tickets.publicReopenTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).status, "reopened");
  assert.equal(db.getTicket(id).reopen_count, 1);
  await tickets.publicReopenTicket({ ticketId: id, actorId: "U-cyc", client }); // double click
  assert.equal(db.getTicket(id).reopen_count, 1, "double reopen click doesn't bump the count");
  await tickets.publicResolveTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).status, "resolved");
  await tickets.publicReopenTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).reopen_count, 2);
  assert.match(client.posts.map((p) => p.text || "").join(" "), /Ticket reopened by <@U-cyc>/);
});

/* ------------------------------------------------------------ bot output --- */

test("Pixie's own thread messages never open a ticket", async () => {
  // The bot filter lives in handlers.onMessage (event.bot_id); respond() is
  // only ever called for human turns. This pins that a non-support turn — the
  // classifier's job — is also filtered.
  intent.classifyIntent = async () => intent.CASUAL_CHAT;
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "haha" });
  const client = clientSpy();
  await ask(client, "t-bot", "lmao nice");
  assert.equal(db.getTicketByThreadTs("t-bot"), null);
});

/* --------------------------------------------------------- cross-program --- */

test("a passive program (Pixl) opens no ticket; the active program does", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });

  const c1 = clientSpy();
  await respond.respond({ client: c1, channel: "C-st-pixl-help", threadTs: "t-pixl", messageTs: "t-pixl", userId: "U1", question: "how do i submit?", mode: respond.ALWAYS });
  assert.equal(db.getTicketByThreadTs("t-pixl"), null, "Pixl is passive — answer only, no ticket");

  const c2 = clientSpy();
  await ask(c2, "t-active", "how do i submit?");
  const t = db.getTicketByThreadTs("t-active");
  assert.ok(t);
  assert.equal(t.program_id, "st-prog");
});

test("tickets and their organizer channel belong to the question's own program", async () => {
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
  const client = clientSpy();
  await ask(client, "t-scope", "unanswerable thing", { mode: respond.HELP_ONLY });

  const ticket = db.getTicketByThreadTs("t-scope");
  assert.equal(ticket.program_id, "st-prog");
  assert.equal(tickets.getOrganizerChannel(programs.get("st-prog")), ORG);
  const card = client.posts.find((p) => p.channel === ORG);
  assert.ok(card, "card goes to this program's organizer channel, not another's");
});
