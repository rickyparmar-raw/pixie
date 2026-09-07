process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const tickets = require("./tickets");

before(() => {
  db.close();
  db.open(":memory:");
});

test("escalateTicket creates a ticket in DB and builds card blocks", async () => {
  const posted = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: "card-ts-123" };
      },
    },
  };

  const activeProg = { id: "sprig", name: "Sprig", posture: "active", helpChannel: "C-sprig", organizerChannel: "C-sprig-organizers" };

  const ticket = await tickets.escalateTicket({
    program: activeProg,
    channel: "C-sprig",
    threadTs: "thread-100",
    requesterId: "U-requester",
    question: "how do i solder the screen",
    client,
  });

  assert.ok(ticket);
  assert.equal(ticket.program_id, "sprig");
  assert.equal(ticket.question, "how do i solder the screen");
  // In-thread ack first, organizer-channel card second.
  assert.equal(posted.length, 2);
  assert.match(posted[0].text, /flagged this for/);
  assert.equal(posted[0].channel, "C-sprig");
  assert.equal(posted[0].thread_ts, "thread-100");
  assert.equal(posted[1].channel, "C-sprig-organizers");

  const fetched = db.getTicket(ticket.id);
  assert.equal(fetched.card_ts, "card-ts-123");
});

test("escalateTicket returns existing ticket if thread already escalated", async () => {
  const activeProg = { id: "sprig", name: "Sprig", posture: "active", helpChannel: "C-sprig" };

  const first = await tickets.escalateTicket({
    program: activeProg,
    channel: "C-sprig",
    threadTs: "thread-100",
    requesterId: "U-requester",
    question: "how do i solder the screen",
  });

  const second = await tickets.escalateTicket({
    program: activeProg,
    channel: "C-sprig",
    threadTs: "thread-100",
    requesterId: "U-requester",
    question: "how do i solder the screen",
  });

  assert.equal(first.id, second.id);
});

test("escalateTicket skips passive programs for unprompted tickets", async () => {
  const passiveProg = { id: "pixl", name: "Pixl", posture: "passive", helpChannel: "C-pixl" };

  const result = await tickets.escalateTicket({
    program: passiveProg,
    channel: "C-pixl",
    threadTs: "thread-passive-1",
    requesterId: "U-requester",
    question: "whats pixl",
  });

  assert.equal(result, null);
});

test("buildTicketCardBlocks reflects status changes, unclaiming, and reopening", () => {
  const ticket = { id: 5, program_id: "sprig", requester_id: "U1", channel: "C1", question: "help", status: "open" };
  let blocks = tickets.buildTicketCardBlocks(ticket, { name: "Sprig" });
  assert.ok(blocks.length >= 3);
  assert.equal(blocks[0].text.text, "[Sprig] Ticket #5");

  ticket.status = "claimed";
  ticket.assignee_id = "U-helper";
  blocks = tickets.buildTicketCardBlocks(ticket, { name: "Sprig" });
  assert.match(blocks[2].text.text, /Claimed by <@U-helper>/);
  assert.ok(blocks[3].elements.some((e) => e.action_id === "unclaim_ticket"));

  ticket.status = "resolved";
  blocks = tickets.buildTicketCardBlocks(ticket, { name: "Sprig" });
  assert.ok(blocks[3].elements.some((e) => e.action_id === "reopen_ticket"));
});

test("ticket cards neutralize channel-wide mentions in questions", () => {
  const blocks = require("./tickets").buildTicketCardBlocks(
    { id: 9, program_id: "sprig", requester_id: "U1", channel: "C1", question: "hello <!channel> check <http://evil|x>", status: "open" },
    { name: "Sprig" },
  );
  const body = JSON.stringify(blocks);
  assert.ok(!body.includes("<!channel>"));
  assert.ok(body.includes("&lt;!channel&gt;"));
});

test("cross-program routing: Program A and Program B cards route strictly to their respective organizer channels", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `card-${posts.length}` };
      },
    },
  };

  const progA = {
    id: "prog-a",
    name: "Program A",
    posture: "active",
    helpChannel: "C-help-a",
    organizerChannel: "C-org-a",
  };
  const progB = {
    id: "prog-b",
    name: "Program B",
    posture: "active",
    helpChannel: "C-help-b",
    organizerChannel: "C-org-b",
  };

  const ticketA = await tickets.escalateTicket({
    program: progA,
    channel: "C-help-a",
    threadTs: "t-a-1",
    requesterId: "U-asker-a",
    question: "how to do A",
    client,
  });

  assert.ok(ticketA);
  assert.equal(ticketA.program_id, "prog-a");

  const ticketB = await tickets.escalateTicket({
    program: progB,
    channel: "C-help-b",
    threadTs: "t-b-1",
    requesterId: "U-asker-b",
    question: "how to do B",
    client,
  });

  assert.ok(ticketB);
  assert.equal(ticketB.program_id, "prog-b");

  // 4 posts total: 2 in-thread acks + 2 organizer cards
  assert.equal(posts.length, 4);

  // Program A in-thread ack goes to C-help-a thread
  assert.equal(posts[0].channel, "C-help-a");
  assert.equal(posts[0].thread_ts, "t-a-1");
  assert.match(posts[0].text, /flagged this for a Program A helper/);

  // Program A card goes ONLY to C-org-a
  assert.equal(posts[1].channel, "C-org-a");
  assert.notEqual(posts[1].channel, "C-help-a");
  assert.notEqual(posts[1].channel, "C-org-b");
  assert.match(posts[1].text, /\[Ticket #\d+\]/);

  // Program B in-thread ack goes to C-help-b thread
  assert.equal(posts[2].channel, "C-help-b");
  assert.equal(posts[2].thread_ts, "t-b-1");
  assert.match(posts[2].text, /flagged this for a Program B helper/);

  // Program B card goes ONLY to C-org-b
  assert.equal(posts[3].channel, "C-org-b");
  assert.notEqual(posts[3].channel, "C-help-b");
  assert.notEqual(posts[3].channel, "C-org-a");
  assert.match(posts[3].text, /\[Ticket #\d+\]/);
});

test("never fall back to public help channel if no organizer channel is configured", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `card-${posts.length}` };
      },
    },
  };

  const progNoOrg = {
    id: "prog-no-org",
    name: "No Org Prog",
    posture: "active",
    helpChannel: "C-public-help",
    organizerChannel: null,
  };

  const ticket = await tickets.escalateTicket({
    program: progNoOrg,
    channel: "C-public-help",
    threadTs: "t-no-org",
    requesterId: "U-asker",
    question: "no organizer channel test",
    client,
  });

  assert.ok(ticket);
  // Only the in-thread ack is posted into C-public-help; no ticket card is ever posted to C-public-help
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-public-help");
  assert.equal(posts[0].thread_ts, "t-no-org");
  assert.match(posts[0].text, /flagged this for/);

  const fetched = db.getTicket(ticket.id);
  assert.equal(fetched.card_ts, null);
});

test("never fall back to public help channel if delivery to organizer channel fails", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        if (payload.channel === "C-failing-org") {
          throw new Error("channel_not_found");
        }
        posts.push(payload);
        return { ts: "ack-ts-1" };
      },
    },
  };

  const progFailingOrg = {
    id: "prog-fail",
    name: "Failing Org Prog",
    posture: "active",
    helpChannel: "C-public-help-2",
    organizerChannel: "C-failing-org",
  };

  const ticket = await tickets.escalateTicket({
    program: progFailingOrg,
    channel: "C-public-help-2",
    threadTs: "t-fail-org",
    requesterId: "U-asker",
    question: "fail org test",
    client,
  });

  assert.ok(ticket);
  // Only the in-thread ack was posted in C-public-help-2; no fallback card posted
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-public-help-2");
  assert.equal(posts[0].thread_ts, "t-fail-org");

  const fetched = db.getTicket(ticket.id);
  assert.equal(fetched.card_ts, null);
});

test("multi-tenant routing contract: incoming help channel resolves program from DB claims", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: "claim-card-ts" };
      },
    },
  };

  const prog1 = { id: "hosted-p1", name: "Hosted 1", posture: "active", workspaceId: "WS-H1", helpChannel: "C-H1-HELP", organizerChannel: "C-H1-ORG" };
  const prog2 = { id: "hosted-p2", name: "Hosted 2", posture: "active", workspaceId: "WS-H2", helpChannel: "C-H2-HELP", organizerChannel: "C-H2-ORG" };
  db.saveProgram(prog1);
  db.saveProgram(prog2);
  db.claimProgramChannel({ workspaceId: "WS-H1", channelId: "C-H1-HELP", programId: "hosted-p1", kind: "help" });
  db.claimProgramChannel({ workspaceId: "WS-H1", channelId: "C-H1-ORG", programId: "hosted-p1", kind: "organizer" });
  db.claimProgramChannel({ workspaceId: "WS-H2", channelId: "C-H2-HELP", programId: "hosted-p2", kind: "help" });
  db.claimProgramChannel({ workspaceId: "WS-H2", channelId: "C-H2-ORG", programId: "hosted-p2", kind: "organizer" });
  require("./programs").invalidate();

  const ticket1 = await tickets.escalateTicket({
    channel: "C-H1-HELP",
    threadTs: "t-h1",
    requesterId: "U-asker-h1",
    question: "question for h1",
    client,
    workspaceId: "WS-H1",
  });

  assert.ok(ticket1);
  assert.equal(ticket1.program_id, "hosted-p1");
  assert.equal(ticket1.workspace_id, "WS-H1");

  const ticket2 = await tickets.escalateTicket({
    channel: "C-H2-HELP",
    threadTs: "t-h2",
    requesterId: "U-asker-h2",
    question: "question for h2",
    client,
    workspaceId: "WS-H2",
  });

  assert.ok(ticket2);
  assert.equal(ticket2.program_id, "hosted-p2");
  assert.equal(ticket2.workspace_id, "WS-H2");

  assert.equal(posts[0].channel, "C-H1-HELP");
  assert.equal(posts[1].channel, "C-H1-ORG");
  assert.equal(posts[2].channel, "C-H2-HELP");
  assert.equal(posts[3].channel, "C-H2-ORG");
});

test("tenant isolation on claim, assign, snooze, resolve, and unclaim", async () => {
  const progAlpha = { id: "alpha", name: "Alpha", workspaceId: "WS-ALPHA", helpChannel: "C-alpha-help", organizerChannel: "C-alpha-org" };
  const progBeta = { id: "beta", name: "Beta", workspaceId: "WS-BETA", helpChannel: "C-beta-help", organizerChannel: "C-beta-org" };
  db.saveProgram(progAlpha);
  db.saveProgram(progBeta);
  db.claimProgramChannel({ workspaceId: "WS-ALPHA", channelId: "C-alpha-org", programId: "alpha", kind: "organizer" });
  db.claimProgramChannel({ workspaceId: "WS-BETA", channelId: "C-beta-org", programId: "beta", kind: "organizer" });
  require("./programs").invalidate();
  db.syncHelper({ programId: "alpha", userId: "U-helper-alpha", source: "manual" });
  db.syncHelper({ programId: "beta", userId: "U-helper-beta", source: "manual" });

  const ticketAlphaId = db.createTicket({
    programId: "alpha",
    workspaceId: "WS-ALPHA",
    channel: "C-alpha-help",
    threadTs: "thread-alpha",
    requesterId: "U-req-alpha",
    question: "alpha issue",
  });

  // 1. Cross-program mismatch rejection
  const progMismatchClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    programId: "beta",
  });
  assert.equal(progMismatchClaim.error, "program mismatch");

  // 2. Cross-workspace mismatch rejection
  const wsMismatchClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    workspaceId: "WS-BETA",
  });
  assert.equal(wsMismatchClaim.error, "workspace mismatch");

  // 3. Non-helper actor rejection
  const foreignActorClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-beta",
    programId: "alpha",
    workspaceId: "WS-ALPHA",
  });
  assert.equal(foreignActorClaim.error, "actor is not a helper of this program");

  // 4. Authorized helper claim succeeds
  const updates = [];
  const client = {
    chat: {
      update: async (payload) => {
        updates.push(payload);
        return { ok: true };
      },
    },
  };
  db.updateTicketCardTs(ticketAlphaId, "card-alpha-ts");

  const goodClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    programId: "alpha",
    workspaceId: "WS-ALPHA",
    client,
  });
  assert.equal(goodClaim.ok, true);
  assert.equal(goodClaim.ticket.status, "claimed");
  assert.equal(goodClaim.ticket.assignee_id, "U-helper-alpha");
  // Card update went to alpha's organizer channel
  assert.equal(updates.length, 1);
  assert.equal(updates[0].channel, "C-alpha-org");

  // 5. Tenant isolation on snooze
  const badSnooze = tickets.snoozeTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    until: Date.now() + 60000,
    programId: "beta",
  });
  assert.equal(badSnooze.error, "program mismatch");

  const goodSnooze = tickets.snoozeTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    until: Date.now() + 60000,
    programId: "alpha",
    workspaceId: "WS-ALPHA",
  });
  assert.equal(goodSnooze.ok, true);
  assert.equal(goodSnooze.ticket.status, "snoozed");

  // 6. Tenant isolation on assign
  const badAssign = await tickets.assignTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    assigneeId: "U-helper-beta",
    programId: "alpha",
  });
  assert.equal(badAssign.error, "assignee is not a helper of this program");

  // 7. Tenant isolation on resolve
  const badResolve = await tickets.resolveTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-beta",
    programId: "alpha",
  });
  assert.equal(badResolve.error, "actor is not a helper of this program");

  const goodResolve = await tickets.resolveTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    programId: "alpha",
    workspaceId: "WS-ALPHA",
    client,
  });
  assert.equal(goodResolve.ok, true);
  assert.equal(goodResolve.ticket.status, "resolved");
});

test("replyToTicket and addInternalNote: tenant isolation, in-thread replies, and zero notes leakage", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: "reply-ts-1" };
      },
    },
  };

  const progA = { id: "sec-a", name: "Security A", supportName: "SecA Support", workspaceId: "WS-A", helpChannel: "C-sec-help", organizerChannel: "C-sec-org" };
  db.saveProgram(progA);
  require("./programs").invalidate();
  db.syncHelper({ programId: "sec-a", userId: "U-helper-sec", source: "manual" });

  const ticketId = db.createTicket({
    programId: "sec-a",
    workspaceId: "WS-A",
    channel: "C-sec-help",
    threadTs: "thread-user-1",
    requesterId: "U-asker-sec",
    question: "secret issue",
  });

  // 1. Add internal note
  const noteMismatch = tickets.addInternalNote({
    ticketId,
    authorId: "U-helper-sec",
    body: "Confidential investigative note",
    programId: "sec-b",
  });
  assert.equal(noteMismatch.error, "program mismatch");

  const noteSuccess = tickets.addInternalNote({
    ticketId,
    authorId: "U-helper-sec",
    body: "Confidential investigative note",
    programId: "sec-a",
    workspaceId: "WS-A",
  });
  assert.equal(noteSuccess.ok, true);
  assert.ok(noteSuccess.noteId);

  // Internal note must NEVER touch Slack
  assert.equal(posts.length, 0);

  // 2. replyToTicket tenant mismatch
  const replyMismatch = await tickets.replyToTicket({
    ticketId,
    authorId: "U-helper-sec",
    text: "Public response to user",
    client,
    programId: "sec-b",
  });
  assert.equal(replyMismatch.error, "program mismatch");

  const replyWsMismatch = await tickets.replyToTicket({
    ticketId,
    authorId: "U-helper-sec",
    text: "Public response to user",
    client,
    workspaceId: "WS-OTHER",
  });
  assert.equal(replyWsMismatch.error, "workspace mismatch");

  // 3. Authorized replyToTicket posts to user thread with program branding
  const replyOk = await tickets.replyToTicket({
    ticketId,
    authorId: "U-helper-sec",
    text: "We have fixed your issue!",
    client,
    programId: "sec-a",
    workspaceId: "WS-A",
  });
  assert.equal(replyOk.ok, true);

  // Delivered into requester's original channel and thread
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-sec-help");
  assert.equal(posts[0].thread_ts, "thread-user-1");
  assert.equal(posts[0].text, "We have fixed your issue!");
  assert.equal(posts[0].username, "SecA Support");

  // Ensure internal note is NEVER leaked into the post or reply return value
  assert.ok(!posts[0].text.includes("Confidential"));
  assert.ok(!JSON.stringify(replyOk).includes("Confidential"));

  // Verify internal notes remain strictly in database
  const notes = db.listTicketNotes(ticketId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, "Confidential investigative note");
});
