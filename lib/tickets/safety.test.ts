process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db") as unknown as TestDb;
const tickets = require("../tickets") as unknown as TestTickets;
const helperRoute = require("../helperRoute") as typeof import("../helperRoute");
const lifecycle = require("../assignmentLifecycle") as typeof import("../assignmentLifecycle");
const { config } = require("../config");

before(() => {
  db.close();
  db.open(":memory:");
});

function clientSpy() {
  const posts = [];
  return {
    posts,
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `ts-${posts.length}` };
      },
      update: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
  };
}

function prog(id, helpers = [], extra = {}) {
  const p = {
    id,
    name: id,
    helpChannel: `C-${id}`,
    channels: [`C-${id}`],
    organizerChannel: `C-${id}-org`,
    helperPing: true,
    ...extra,
  };
  db.saveProgram(p);
  for (const h of helpers) db.syncHelper({ programId: id, userId: h, source: "manual" });
  return p;
}

function pings(posts) {
  return posts.filter((p) => /could you take a look/.test(p.text || ""));
}

async function escalate(program, threadTs, requesterId, client, question = "help, human please") {
  return tickets.escalateTicket({
    program,
    channel: program.helpChannel,
    threadTs,
    requesterId,
    question,
    client,
  });
}

test("safety: the requester is never selected as helper, even as the top expert", async () => {
  const program = prog("safe-req", ["U-REQ", "U-OTHER"]);
  helperRoute.recordResolution({ programId: "safe-req", userId: "U-REQ", category: "pcb" });
  helperRoute.recordResolution({ programId: "safe-req", userId: "U-REQ", category: "pcb" });

  const ticketId = db.createTicket({
    programId: "safe-req",
    channel: "C-safe-req",
    threadTs: "t-safe-req",
    requesterId: "U-REQ",
    question: "pcb help",
    category: "pcb",
  });
  const client = clientSpy();
  const who = await tickets.pingRecommendedHelper({ client, ticket: db.getTicket(ticketId), program });
  assert.equal(who, "U-OTHER");
  assert.ok(!pings(client.posts).some((p) => p.text.includes("U-REQ")));

  const solo = prog("safe-req-solo", ["U-SOLO"]);
  const soloId = db.createTicket({
    programId: "safe-req-solo",
    channel: "C-safe-req-solo",
    threadTs: "t-safe-req-solo",
    requesterId: "U-SOLO",
    question: "q",
  });
  const c2 = clientSpy();
  assert.equal(await tickets.pingRecommendedHelper({ client: c2, ticket: db.getTicket(soloId), program: solo }), null);
  assert.equal(pings(c2.posts).length, 0);
});

test("safety: Pixie's own bot user is never selected, even on the roster", async () => {
  const saved = config.slack.botUserId;
  config.slack.botUserId = "U-BOT";
  try {
    const program = prog("safe-bot", ["U-BOT", "U-HUMAN"]);
    helperRoute.recordResolution({ programId: "safe-bot", userId: "U-BOT", category: "general" });
    const ranked = helperRoute.recommend({ programId: "safe-bot", limit: 5 });
    assert.ok(ranked.length > 0);
    assert.ok(
      ranked.every((r) => r.userId !== "U-BOT"),
      "the bot user never appears in recommendations",
    );
    assert.equal(ranked[0].userId, "U-HUMAN");

    const ticketId = db.createTicket({
      programId: "safe-bot",
      channel: "C-safe-bot",
      threadTs: "t-safe-bot",
      requesterId: "U-REQ",
      question: "q",
    });
    const client = clientSpy();
    assert.equal(await tickets.pingRecommendedHelper({ client, ticket: db.getTicket(ticketId), program }), "U-HUMAN");
  } finally {
    config.slack.botUserId = saved;
  }
});

test("safety: duplicate Slack event (same ts) creates one ticket and one ping", async () => {
  const program = prog("safe-dupe", ["U-HELPER"]);
  const client = clientSpy();
  const first = await escalate(program, "t-safe-dupe", "U-req", client);
  const second = await escalate(program, "t-safe-dupe", "U-req", client);
  assert.ok(first && second);
  assert.equal(first.id, second.id);
  const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-safe-dupe");
  assert.equal(rows.length, 1);
  assert.equal(pings(client.posts).length, 1);
});

test("safety: existing open assignment offer is not duplicated (one ping per epoch)", async () => {
  const program = prog("safe-epoch", ["U-HELPER"]);
  const client = clientSpy();
  await escalate(program, "t-safe-epoch", "U-req", client);
  assert.equal(pings(client.posts).length, 1);
  for (let i = 0; i < 3; i += 1) {
    await escalate(program, "t-safe-epoch", "U-req", client, `still stuck ${i}`);
  }
  assert.equal(pings(client.posts).length, 1, "retries must not re-page");
  const ticket = db.getTicketByThreadTs("t-safe-epoch");
  assert.ok(lifecycle.openOfferFor("safe-epoch", ticket.id), "the epoch's offer stays open");
});

test("safety: resolved ticket reopens on requester write-back and reopen starts a new epoch", async () => {
  const program = prog("safe-reopen", ["U-HELPER"]);
  const client = clientSpy();
  const ticket = await escalate(program, "t-safe-reopen", "U-req", client);
  assert.equal(pings(client.posts).length, 1);

  await tickets.resolveTicket({ ticketId: ticket.id, actorId: "U-HELPER", programId: "safe-reopen" });
  assert.equal(db.getTicket(ticket.id).status, "resolved");

  const reopened = await tickets.publicReopenTicket({ ticketId: ticket.id, actorId: "U-req", client });
  assert.equal(reopened.ok, true);
  assert.equal(db.getTicket(ticket.id).status, "reopened");
  assert.equal(db.getTicket(ticket.id).reopen_count, 1);
  const epochOffer = lifecycle.openOfferFor("safe-reopen", ticket.id);
  assert.ok(epochOffer, "reopen opens a fresh pool offer");
  assert.equal(epochOffer.to, null);

  await escalate(program, "t-safe-reopen", "U-req", client, "still broken");
  assert.equal(pings(client.posts).length, 2);
  await escalate(program, "t-safe-reopen", "U-req", client, "still broken x2");
  assert.equal(pings(client.posts).length, 2, "the new epoch dedupes too");
});

test("safety: helper reply in thread stops repeated offers", async () => {
  const program = prog("safe-replied", ["U-HELPER", "U-OTHER"]);
  const client = clientSpy();
  const ticket = await escalate(program, "t-safe-replied", "U-req", client);
  assert.equal(pings(client.posts).length, 1);

  tickets.noteThreadActivity({ channel: "C-safe-replied", threadTs: "t-safe-replied", userId: "U-OTHER" });
  assert.ok(db.listTicketEvents(ticket.id).some((e) => e.event_type === "helper_reply"));

  const c2 = clientSpy();
  assert.equal(await tickets.pingRecommendedHelper({ client: c2, ticket: db.getTicket(ticket.id), program }), null);
  assert.equal(pings(c2.posts).length, 0);
});

test("safety: ping fatigue lowers rank deterministically", () => {
  const program = prog("safe-fatigue", ["U-A", "U-B"]);
  assert.ok(program);
  for (const h of ["U-A", "U-B"]) {
    helperRoute.recordResolution({ programId: "safe-fatigue", userId: h, category: "general_support" });
  }
  for (let i = 0; i < 3; i += 1) {
    const id = db.createTicket({
      programId: "safe-fatigue",
      channel: "C-safe-fatigue",
      threadTs: `t-safe-fatigue-${i}`,
      requesterId: "U-req",
      question: "q",
    });
    lifecycle.recordOffer({ ticket: db.getTicket(id), to: "U-B", source: "ping" });
  }
  const first = helperRoute.recommend({ programId: "safe-fatigue", category: "general_support", limit: 2 });
  const second = helperRoute.recommend({ programId: "safe-fatigue", category: "general_support", limit: 2 });
  assert.deepEqual(first, second, "identical inputs rank identically");
  assert.equal(first[0].userId, "U-A", "the less-pinged helper wins the tie");
});

test("safety: a helper of another program is never selected", async () => {
  prog("safe-iso-a", ["U-FOREIGN"]);
  const programB = prog("safe-iso-b", []);
  const ranked = helperRoute.recommend({ programId: "safe-iso-b", limit: 5 });
  assert.deepEqual(ranked, [], "no roster means no candidates, never a foreign helper");

  const ticketId = db.createTicket({
    programId: "safe-iso-b",
    channel: "C-safe-iso-b",
    threadTs: "t-safe-iso-b",
    requesterId: "U-req",
    question: "q",
  });
  const client = clientSpy();
  assert.equal(
    await tickets.pingRecommendedHelper({ client, ticket: db.getTicket(ticketId), program: programB }),
    null,
  );
  assert.equal(pings(client.posts).length, 0);
});

test("safety: helper selection is deterministic for identical inputs", () => {
  prog("safe-determ", ["U-1", "U-2", "U-3"]);
  helperRoute.setExpertise({ programId: "safe-determ", userId: "U-2", tags: ["pcb"] });
  helperRoute.recordResolution({ programId: "safe-determ", userId: "U-2", category: "pcb" });
  const a = helperRoute.recommend({ programId: "safe-determ", category: "pcb", limit: 3, now: 1234567890000 });
  const b = helperRoute.recommend({ programId: "safe-determ", category: "pcb", limit: 3, now: 1234567890000 });
  assert.deepEqual(a, b);
  assert.equal(a[0].userId, "U-2");
});

test("lifecycle: create -> open -> waiting_for_helper -> engaged -> resolved -> reopened, with history and attribution", async () => {
  const program = prog("safe-life", ["U-HELPER"]);
  const client = clientSpy();

  const ticket = await escalate(program, "t-safe-life", "U-asker", client, "my board will not boot");
  assert.equal(ticket.status, "waiting_for_helper");
  assert.ok(ticket.created_at, "created_at stamped at creation");
  assert.ok(db.getTicket(ticket.id).first_response_at, "the thread ack counts as first response");

  const claimed = await tickets.claimTicket({ ticketId: ticket.id, actorId: "U-HELPER", programId: "safe-life" });
  assert.equal(claimed.ok, true);
  assert.equal(db.getTicket(ticket.id).assignee_id, "U-HELPER");
  assert.ok(db.getTicket(ticket.id).claimed_at, "claimed_at stamped on claim");

  const reply = await tickets.replyToTicket({
    ticketId: ticket.id,
    authorId: "U-HELPER",
    text: "try reseating the cable",
    client,
    programId: "safe-life",
  });
  assert.equal(reply.ok, true);
  assert.ok(db.getTicket(ticket.id).first_human_response_at, "helper reply stamps first human response");

  const note = tickets.addInternalNote({
    ticketId: ticket.id,
    authorId: "U-HELPER",
    body: "suspect power supply",
    programId: "safe-life",
  });
  assert.equal(note.ok, true);
  assert.equal(db.listTicketNotes(ticket.id).length, 1, "internal notes are kept");

  const resolved = await tickets.resolveTicket({ ticketId: ticket.id, actorId: "U-HELPER", programId: "safe-life" });
  assert.equal(resolved.ok, true);
  const done = db.getTicket(ticket.id);
  assert.equal(done.status, "resolved");
  assert.equal(done.resolved_by, "U-HELPER", "responder attribution");
  assert.ok(done.resolved_at, "resolved_at stamped");

  const reopened = await tickets.publicReopenTicket({ ticketId: ticket.id, actorId: "U-asker", client });
  assert.equal(reopened.ok, true);
  const back = db.getTicket(ticket.id);
  assert.equal(back.status, "reopened");
  assert.equal(back.reopen_count, 1);
  assert.ok(back.reopened_at, "reopened_at stamped");
  assert.equal(back.resolved_by, null, "reopen clears responder attribution");

  const kinds = new Set(db.listTicketEvents(ticket.id).map((e) => e.event_type));
  for (const k of ["created", "escalated", "helper_reply", "resolved", "reopened"]) {
    assert.ok(kinds.has(k), `assignment history contains ${k}`);
  }
  assert.ok(kinds.has("helper_assignment_claimed"), "claim enters the assignment trail");
  assert.ok(kinds.has("helper_assignment_offered"), "the epoch offer enters the assignment trail");
});
export {};
import type { TestDb, TestTickets } from "../test.types";
