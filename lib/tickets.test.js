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

test("public ticket footer shows the canonical number for every lifecycle state", () => {
  const base = { id: 42, program_id: "sprig", channel: "C0ABC123", status: "ai_answered" };

  const answered = tickets.buildTicketFooterBlocks(base);
  assert.equal(answered[0].elements[0].text, "*Ticket #42* · ✓ Answered by Pixie");

  const waiting = tickets.buildTicketFooterBlocks({ ...base, status: "waiting_for_helper" });
  assert.equal(waiting[0].elements[0].text, "*Ticket #42* · Waiting for a helper");

  const resolved = tickets.buildTicketFooterBlocks({ ...base, status: "resolved" });
  assert.equal(resolved[0].elements[0].text, "*Ticket #42* · ✅ Resolved");
});

test("public ticket footer never renders a Slack id in the ticket-number position", () => {
  const ticket = {
    id: 7,
    program_id: "sprig",
    channel: "C0ABC123",
    organizer_channel_id: "G0XYZ123",
    workspace_id: "T0266FRGM",
    status: "waiting_for_helper",
  };
  const body = JSON.stringify(tickets.buildTicketFooterBlocks(ticket));
  assert.ok(body.includes("*Ticket #7*"));
  assert.ok(!body.includes("C0ABC123"));
  assert.ok(!body.includes("G0XYZ123"));
  assert.ok(!body.includes("<#"));
});

test("public ticket footer omits the number rather than emit a channel-shaped id", () => {
  const blocks = tickets.buildTicketFooterBlocks({ id: "C097HD35F8B", channel: "C097HD35F8B", status: "waiting_for_helper" });
  const text = blocks[0].elements[0].text;
  assert.equal(text, "*Ticket* · Waiting for a helper");
  assert.ok(!text.includes("#C097HD35F8B"));
});

test("escalation acknowledgement never names the program support identity", async () => {
  for (const supportName of ["Sandbox Pixie", "Pixl Help"]) {
    const posted = [];
    const client = { chat: { postMessage: async (p) => { posted.push(p); return { ts: `t-${posted.length}` }; } } };
    const prog = { id: `p-${supportName}`, name: supportName, supportName, posture: "active", helpChannel: `C-${supportName}`, organizerChannel: `C-org-${supportName}`, autoEscalate: true };
    await tickets.escalateTicket({
      program: prog,
      channel: `C-${supportName}`,
      threadTs: `thread-${supportName}`,
      requesterId: "U-req",
      question: "I need a human to handle this",
      client,
    });
    assert.ok(posted[0].text.startsWith("Got it, I've flagged this for the support team."));
    assert.ok(posted[0].text.endsWith("I'll update this thread when someone picks it up."));
    assert.ok(!posted[0].text.includes(supportName));
  }
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
  assert.match(posts[0].text, /flagged this for the support team/);

  // Program A card goes ONLY to C-org-a
  assert.equal(posts[1].channel, "C-org-a");
  assert.notEqual(posts[1].channel, "C-help-a");
  assert.notEqual(posts[1].channel, "C-org-b");
  assert.match(posts[1].text, /\[Ticket #\d+\]/);

  // Program B in-thread ack goes to C-help-b thread
  assert.equal(posts[2].channel, "C-help-b");
  assert.equal(posts[2].thread_ts, "t-b-1");
  assert.match(posts[2].text, /flagged this for the support team/);

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

test("incident-aware answering: a question matching an ACTIVE incident gets the known-issue reply instead of a ticket, and is tracked", async () => {
  const incidents = require("./incidents");
  db.saveProgram({ id: "inc-a", name: "IncA", helpChannel: "C-inc-a", channels: ["C-inc-a"] });
  const detected = incidents.detectBursts({ programId: "inc-a" });
  assert.deepEqual(detected.candidates, []); // no bursts yet — build the incident directly for a controlled test
  db.handle().query(
    "INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'confirmed', ?, ?)",
  ).run("inc-a", "checkout is failing for everyone", Date.now(), Date.now());

  const posted = [];
  const client = { chat: { postMessage: async (payload) => { posted.push(payload); return { ts: "1.0" }; } } };
  const prog = { id: "inc-a", name: "IncA", posture: "active", helpChannel: "C-inc-a", organizerChannel: "C-inc-a-org" };

  const result = await tickets.escalateTicket({
    program: prog,
    channel: "C-inc-a",
    threadTs: "thread-inc-1",
    requesterId: "U-affected",
    question: "checkout keeps failing for me too",
    client,
  });

  assert.equal(result, null); // no ticket opened
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /aware of an issue/);
  assert.equal(db.getTicketByThreadTs("thread-inc-1"), null);

  const inc = incidents.listIncidents("inc-a", "confirmed")[0];
  const reports = incidents.affectedReports(inc.id);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].requester_id, "U-affected");
});

test("incident-aware answering never applies to bypassIncidentMatch (sensitive) escalations", async () => {
  const incidents = require("./incidents");
  db.saveProgram({ id: "inc-b", name: "IncB", helpChannel: "C-inc-b", channels: ["C-inc-b"] });
  db.handle().query(
    "INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'confirmed', ?, ?)",
  ).run("inc-b", "payment processing is down", Date.now(), Date.now());

  const client = { chat: { postMessage: async () => ({ ts: "1.0" }) } };
  const prog = { id: "inc-b", name: "IncB", posture: "active", helpChannel: "C-inc-b", organizerChannel: "C-inc-b-org" };

  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-inc-b",
    threadTs: "thread-inc-2",
    requesterId: "U-sensitive",
    question: "my payment processing account got locked, need help",
    client,
    bypassIncidentMatch: true,
  });

  assert.ok(ticket); // a real ticket was opened despite the matching incident title
  assert.equal(ticket.program_id, "inc-b");
});

test("incident_mode = NORMAL_TICKET opts a program out of incident-aware answering entirely", async () => {
  const incidents = require("./incidents");
  db.saveProgram({ id: "inc-c", name: "IncC", helpChannel: "C-inc-c", channels: ["C-inc-c"], incidentMode: "NORMAL_TICKET" });
  require("./programs").invalidate();
  db.handle().query(
    "INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'confirmed', ?, ?)",
  ).run("inc-c", "login is broken for everyone", Date.now(), Date.now());

  const client = { chat: { postMessage: async () => ({ ts: "1.0" }) } };
  const prog = require("./programs").get("inc-c");

  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-inc-c",
    threadTs: "thread-inc-3",
    requesterId: "U-normal",
    question: "login is broken for me too",
    client,
  });

  assert.ok(ticket);
});

test("the public acknowledgement carries a Resolve button and its ts is stored on the ticket", async () => {
  const posted = [];
  const client = { chat: { postMessage: async (payload) => { posted.push(payload); return { ts: "ack-ts-1" }; } } };
  const prog = { id: "pub-a", name: "PubA", posture: "active", helpChannel: "C-pub-a", organizerChannel: "C-pub-a-org" };

  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-pub-a",
    threadTs: "thread-pub-1",
    requesterId: "U-req",
    question: "my board won't boot",
    client,
  });

  const ackMessage = posted.find((p) => p.channel === "C-pub-a");
  assert.ok(ackMessage.blocks.some((b) => b.type === "actions" && b.elements.some((e) => e.action_id === "public_resolve_ticket")));
  assert.equal(db.getTicket(ticket.id).public_ack_ts, "ack-ts-1");
});

test("publicResolveTicket: the requester can resolve their own ticket, a random channel member cannot", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }), update: async () => ({}) } };
  const prog = { id: "pub-b", name: "PubB", posture: "active", helpChannel: "C-pub-b", organizerChannel: "C-pub-b-org" };
  const ticket = await tickets.escalateTicket({ program: prog, channel: "C-pub-b", threadTs: "thread-pub-2", requesterId: "U-owner", question: "help", client });

  const denied = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-stranger", client });
  assert.equal(denied.error, "not_authorized");
  assert.equal(db.getTicket(ticket.id).status, "waiting_for_helper");

  const allowed = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner", client });
  assert.equal(allowed.ok, true);
  assert.equal(db.getTicket(ticket.id).status, "resolved");
});

test("publicResolveTicket: a helper of the program (not the requester) can also resolve it", async () => {
  db.saveProgram({ id: "pub-c", name: "PubC", helpChannel: "C-pub-c", channels: ["C-pub-c"] });
  db.syncHelper({ programId: "pub-c", userId: "U-HELPER-C", source: "manual" });
  require("./programs").invalidate();
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }), update: async () => ({}) } };
  const prog = require("./programs").get("pub-c");
  const ticket = await tickets.escalateTicket({ program: prog, channel: "C-pub-c", threadTs: "thread-pub-3", requesterId: "U-owner-c", question: "help", client });

  const res = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-HELPER-C", client });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(ticket.id).status, "resolved");
});

test("publicResolveTicket is idempotent on an already-resolved ticket", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }), update: async () => ({}) } };
  const prog = { id: "pub-d", name: "PubD", posture: "active", helpChannel: "C-pub-d", organizerChannel: "C-pub-d-org" };
  const ticket = await tickets.escalateTicket({ program: prog, channel: "C-pub-d", threadTs: "thread-pub-4", requesterId: "U-owner-d", question: "help", client });
  await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner-d", client });

  const again = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner-d", client });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true);
});

test("publicTicketsEnabled = false skips ticket creation from the help channel but Pixie still answers (returns null, no throw)", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }) } };
  db.saveProgram({ id: "notix", name: "NoTix", helpChannel: "C-notix", channels: ["C-notix"], publicTicketsEnabled: false });
  require("./programs").invalidate();
  const prog = require("./programs").get("notix");

  const result = await tickets.escalateTicket({ program: prog, channel: "C-notix", threadTs: "thread-notix-1", requesterId: "U1", question: "help", client });
  assert.equal(result, null);
  assert.equal(db.getTicketByThreadTs("thread-notix-1"), null);
});

test("buildTicketCardBlocks includes a Reply button and a Reassign select populated from recommend(), excluding the current assignee", () => {
  const helperRoute = require("./helperRoute");
  db.saveProgram({ id: "card-a", name: "CardA", helpChannel: "C-card-a", channels: ["C-card-a"] });
  db.syncHelper({ programId: "card-a", userId: "U-CARD-1", source: "manual" });
  db.syncHelper({ programId: "card-a", userId: "U-CARD-2", source: "manual" });
  helperRoute.setExpertise({ programId: "card-a", userId: "U-CARD-1", tags: ["pcb"] });
  helperRoute.recordResolution({ programId: "card-a", userId: "U-CARD-1", category: "pcb" });

  const ticketId = db.createTicket({ programId: "card-a", channel: "C-card-a", threadTs: "t-card-a", requesterId: "U-req", question: "pcb issue", category: "pcb" });
  db.assignTicket(ticketId, "U-CARD-1");
  const ticket = db.getTicket(ticketId);

  const blocks = tickets.buildTicketCardBlocks(ticket, { id: "card-a", name: "CardA" });
  const replyBlock = blocks.find((b) => b.type === "actions" && b.elements.some((e) => e.action_id === "reply_ticket_button"));
  assert.ok(replyBlock, "expected a Reply button on the claimed-ticket card");

  const reassignBlock = blocks.find((b) => b.type === "actions" && b.elements.some((e) => e.action_id === "reassign_select"));
  assert.ok(reassignBlock, "expected a Reassign select");
  const options = reassignBlock.elements[0].options;
  assert.ok(options.every((o) => !o.value.endsWith(":U-CARD-1")), "the current assignee must not be offered as a reassign target");
  assert.ok(options.some((o) => o.value.endsWith(":U-CARD-2")));
});

// WHY: unclaim is a demotion back to the queue, not back to waiting — the
// helper's claim is fully relinquished.
test("char: unclaim demotes to open (not waiting_for_helper)", async () => {
  const id = db.createTicket({ programId: "char-unclaim", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-unclaim-1", requesterId: "U-req", question: "q" });
  db.markTicketWaitingForHelper(id);
  assert.equal(db.getTicket(id).status, "waiting_for_helper");
  db.syncHelper({ programId: "char-unclaim", userId: "U-char-h", source: "manual" });
  const claimed = await tickets.claimTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(claimed.ok, true);
  const unclaimed = await tickets.unclaimTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(unclaimed.ok, true);
  assert.equal(db.getTicket(id).status, "open");
  assert.equal(db.getTicket(id).assignee_id, null);
});

// WHY: reopen is unconditional outside the guarded set — even an open ticket
// moves, so the count is the source of truth for how often it bounced.
test("char: reopen from open succeeds and bumps reopen_count", async () => {
  db.syncHelper({ programId: "char-reopen", userId: "U-char-h", source: "manual" });
  const id = db.createTicket({ programId: "char-reopen", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-reopen-1", requesterId: "U-req", question: "q" });
  assert.equal(db.getTicket(id).reopen_count, 0);
  const res = await tickets.reopenTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "reopened");
  assert.equal(db.getTicket(id).reopen_count, 1);
});

test("char: snooze from resolved succeeds", () => {
  db.syncHelper({ programId: "char-snooze", userId: "U-char-h", source: "manual" });
  const id = db.createTicket({ programId: "char-snooze", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-snooze-1", requesterId: "U-req", question: "q" });
  db.resolveTicket(id, "done");
  assert.equal(db.getTicket(id).status, "resolved");
  const res = tickets.snoozeTicket({ ticketId: id, actorId: "U-char-h", until: Date.now() + 60000 });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "snoozed");
});

test("char: close from open succeeds", async () => {
  db.syncHelper({ programId: "char-close", userId: "U-char-h", source: "manual" });
  const id = db.createTicket({ programId: "char-close", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-close-1", requesterId: "U-req", question: "q" });
  const res = await tickets.closeTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "closed");
});

// WHY: the conditional UPDATE is the race guard — exactly one claim can
// leave the assignable state.
test("char: concurrent claim race has exactly one winner", async () => {
  db.syncHelper({ programId: "char-race", userId: "U-race-1", source: "manual" });
  db.syncHelper({ programId: "char-race", userId: "U-race-2", source: "manual" });
  const id = db.createTicket({ programId: "char-race", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-race-1", requesterId: "U-req", question: "q" });
  const r1 = await tickets.claimTicket({ ticketId: id, actorId: "U-race-1" });
  const r2 = await tickets.claimTicket({ ticketId: id, actorId: "U-race-2" });
  assert.equal(r1.ok, true);
  assert.equal(r2.error, "ticket is not open");
  assert.equal(db.getTicket(id).assignee_id, "U-race-1");
});

test("char: getOrCreate sequential race returns one row, no throw", () => {
  db.saveProgram({ id: "char-goc", name: "Goc", helpChannel: "C-char-goc", channels: ["C-char-goc"] });
  require("./programs").invalidate();
  const prog = { id: "char-goc", name: "Goc", posture: "active", helpChannel: "C-char-goc", organizerChannel: "C-char-goc-org" };
  const a = tickets.getOrCreateOpenTicket({ program: prog, channel: "C-char-goc", threadTs: "char-goc-1", requesterId: "U-req", question: "q", workspaceId: "WS-CHAR" });
  const b = tickets.getOrCreateOpenTicket({ program: prog, channel: "C-char-goc", threadTs: "char-goc-1", requesterId: "U-req", question: "q", workspaceId: "WS-CHAR" });
  assert.ok(a && b);
  assert.equal(a.id, b.id);
  const n = db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE thread_ts = ?").get("char-goc-1").n;
  assert.equal(n, 1);
});

// WHY: "still broken" from the requester is a reopen, not a new ticket.
test("char: requester chatter on resolved reopens and bumps reopen_count", () => {
  const id = db.createTicket({ programId: "char-req-re", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-req-re-1", requesterId: "U-req-char", question: "q" });
  db.resolveTicket(id, "done");
  assert.equal(db.getTicket(id).reopen_count, 0);
  const out = tickets.noteThreadActivity({ channel: "C-char", threadTs: "char-req-re-1", userId: "U-req-char", workspaceId: "WS-CHAR" });
  assert.equal(out.status, "reopened");
  assert.equal(db.getTicket(id).reopen_count, 1);
});

test("char: helper chatter never reopens", () => {
  const id = db.createTicket({ programId: "char-help-no", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-help-no-1", requesterId: "U-req-char", question: "q" });
  db.resolveTicket(id, "done");
  const out = tickets.noteThreadActivity({ channel: "C-char", threadTs: "char-help-no-1", userId: "U-helper-other", workspaceId: "WS-CHAR" });
  assert.equal(out.status, "resolved");
  assert.equal(db.getTicket(id).reopen_count, 0);
});

// WHY: per-question record vs human-escalation intentionally disagree on
// passive and non-help — one is the canonical log, the other is a paging decision.
test("char: ticketCreationAllowed (via getOrCreate) vs escalateTicket combos", async () => {
  db.saveProgram({ id: "char-combo", name: "Combo", helpChannel: "C-char-help", channels: ["C-char-help"] });
  require("./programs").invalidate();
  const CASES = [
    { name: "passive-help", prog: { id: "char-combo", name: "Combo", posture: "passive", helpChannel: "C-char-help", organizerChannel: "C-char-org", publicTicketsEnabled: true }, channel: "C-char-help", expectGoc: true, expectEsc: false },
    { name: "active-nonhelp", prog: { id: "char-combo", name: "Combo", posture: "active", helpChannel: "C-char-help", organizerChannel: "C-char-org", publicTicketsEnabled: true }, channel: "C-other", expectGoc: false, expectEsc: true },
    { name: "nopub-help", prog: { id: "char-combo", name: "Combo", posture: "active", helpChannel: "C-char-help", organizerChannel: "C-char-org", publicTicketsEnabled: false }, channel: "C-char-help", expectGoc: false, expectEsc: false },
    { name: "nopub-nonhelp", prog: { id: "char-combo", name: "Combo", posture: "active", helpChannel: "C-char-help", organizerChannel: "C-char-org", publicTicketsEnabled: false }, channel: "C-other", expectGoc: false, expectEsc: true },
  ];
  for (const c of CASES) {
    const g = tickets.getOrCreateOpenTicket({ program: c.prog, channel: c.channel, threadTs: `char-combo-${c.name}-g`, requesterId: "U-req", question: "q", workspaceId: "WS-CHAR" });
    assert.equal(!!g, c.expectGoc, `getOrCreate ${c.name}`);
    const e = await tickets.escalateTicket({ program: c.prog, channel: c.channel, threadTs: `char-combo-${c.name}-e`, requesterId: "U-req", question: "q", workspaceId: "WS-CHAR" });
    assert.equal(!!e, c.expectEsc, `escalate ${c.name}`);
  }
});

// WHY: snooze has no wake path and no card param — the pin is the absence.
test("char: snooze performs no card sync (currently none)", () => {
  const id = db.createTicket({ programId: "char-snoozecard", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-snoozecard-1", requesterId: "U-req", question: "q" });
  db.updateTicketCardTs(id, "card-char-1");
  db.syncHelper({ programId: "char-snoozecard", userId: "U-h", source: "manual" });
  const updates = [];
  const fakeClient = { chat: { update: async (p) => { updates.push(p); return { ok: true }; } } };
  const before = db.getTicket(id).card_ts;
  const res = tickets.snoozeTicket({ ticketId: id, actorId: "U-h", until: Date.now() + 60000, client: fakeClient });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).card_ts, before);
  assert.equal(updates.length, 0);
});

test("char: every transition writes one ticket_event and one audit_event", async () => {
  db.syncHelper({ programId: "char-audit", userId: "U-audit-h", source: "manual" });
  const id = db.createTicket({ programId: "char-audit", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-audit-1", requesterId: "U-req", question: "q" });
  const baseEvents = db.listTicketEvents(id).length;
  const baseAudit = db.listAuditEvents({ programId: "char-audit" }).length;
  await tickets.claimTicket({ ticketId: id, actorId: "U-audit-h" });
  assert.equal(db.listTicketEvents(id).length, baseEvents + 1);
  assert.equal(db.listTicketEvents(id).at(-1).event_type, "claimed");
  await tickets.resolveTicket({ ticketId: id, actorId: "U-audit-h" });
  assert.equal(db.listTicketEvents(id).length, baseEvents + 2);
  assert.ok(db.listAuditEvents({ programId: "char-audit" }).length >= baseAudit + 2);
});

test("char: resolve records helperRoute resolution", async () => {
  const helperRoute = require("./helperRoute");
  db.saveProgram({ id: "char-resmem", name: "R", helpChannel: "C-char", channels: ["C-char"] });
  db.syncHelper({ programId: "char-resmem", userId: "U-res-h", source: "manual" });
  const id = db.createTicket({ programId: "char-resmem", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-resmem-1", requesterId: "U-req", question: "q", category: "pcb" });
  await tickets.claimTicket({ ticketId: id, actorId: "U-res-h" });
  await tickets.resolveTicket({ ticketId: id, actorId: "U-res-h" });
  const exp = helperRoute.getExpertise("char-resmem", "U-res-h");
  assert.ok(exp.some((e) => e.tag === "pcb" || e.tag === "general"));
});

// WHY: Slack must stay usable before any helper syncs; Wizard must deny
// strangers even then — same check, opposite empty-table policy.
test("char: Slack fail-open vs Wizard fail-closed on empty helper list", async () => {
  const api = require("./web/api");
  const id1 = db.createTicket({ programId: "char-empty-slack", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-empty-1", requesterId: "U-req", question: "q" });
  assert.equal(db.listHelpers("char-empty-slack").length, 0);
  const slackRes = await tickets.claimTicket({ ticketId: id1, actorId: "U-stranger" });
  assert.equal(slackRes.ok, true);
  const id2 = db.createTicket({ programId: "char-empty-wiz", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-empty-2", requesterId: "U-req", question: "q" });
  assert.equal(db.listHelpers("char-empty-wiz").length, 0);
  const wizRes = api.internalTicketAction(id2, "claim", { programId: "char-empty-wiz", actorId: "U-stranger" });
  assert.match(wizRes.error, /not a helper/);
});

// WHY: snoozed has no wake path — escalation must not promote it.
test("char: escalate on snoozed returns early with no wake", async () => {
  const prog = { id: "char-snooze-early", name: "S", posture: "active", helpChannel: "C-char", organizerChannel: "C-char-org" };
  const id = db.createTicket({ programId: "char-snooze-early", workspaceId: "WS-CHAR", channel: "C-char", threadTs: "char-snooze-early-1", requesterId: "U-req", question: "q" });
  db.snoozeTicket(id, Date.now() + 60000);
  assert.equal(db.getTicket(id).status, "snoozed");
  const out = await tickets.escalateTicket({ program: prog, channel: "C-char", threadTs: "char-snooze-early-1", requesterId: "U-req", question: "q", workspaceId: "WS-CHAR" });
  assert.equal(out.id, id);
  assert.equal(out.status, "snoozed");
});

// WHY: organizer cards must never route to a public help channel.
test("fix(a): getOrganizerChannel never falls back to helperChannel", () => {
  assert.equal(tickets.getOrganizerChannel({ id: "fix-a", helperChannel: "C-public-help" }), null);
  assert.equal(tickets.getOrganizerChannel({ id: "fix-a", organizerChannel: "C-org", helperChannel: "C-public-help" }), "C-org");
});

// WHY: workspace-scoped lookup must not see null-workspace rows.
test("fix(b): getTicketByThreadTs strict scoped lookup drops IS NULL fallback", () => {
  const id = db.createTicket({ programId: "fix-b", workspaceId: null, channel: "C-fix", threadTs: "fix-b-thread", requesterId: "U-req", question: "q" });
  assert.ok(id);
  assert.equal(db.getTicketByThreadTs("fix-b-thread", "WS-FIX"), null);
  assert.ok(db.getTicketByThreadTs("fix-b-thread", null));
});

// WHY: UNIQUE means a concurrent winner already created — re-read, never throw.
test("fix(c): createTicket returns existing on conflict, never throws", () => {
  const id1 = db.createTicket({ programId: "fix-c", workspaceId: "WS-FIX", channel: "C-fix", threadTs: "fix-c-thread", requesterId: "U-req", question: "q" });
  assert.ok(id1);
  let id2 = null;
  assert.doesNotThrow(() => {
    id2 = db.createTicket({ programId: "fix-c", workspaceId: "WS-FIX", channel: "C-fix", threadTs: "fix-c-thread", requesterId: "U-req", question: "q" });
  });
  assert.equal(id2, id1);
  const n = db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE thread_ts = ? AND workspace_id = ?").get("fix-c-thread", "WS-FIX").n;
  assert.equal(n, 1);
});

test("fix(c): getOrCreate race returns one row, no throw", () => {
  db.saveProgram({ id: "fix-c-goc", name: "G", helpChannel: "C-fix-c", channels: ["C-fix-c"] });
  require("./programs").invalidate();
  const prog = { id: "fix-c-goc", name: "G", posture: "active", helpChannel: "C-fix-c", organizerChannel: "C-fix-c-org" };
  const a = tickets.getOrCreateOpenTicket({ program: prog, channel: "C-fix-c", threadTs: "fix-c-goc-1", requesterId: "U-req", question: "q", workspaceId: "WS-FIX" });
  const b = tickets.getOrCreateOpenTicket({ program: prog, channel: "C-fix-c", threadTs: "fix-c-goc-1", requesterId: "U-req", question: "q", workspaceId: "WS-FIX" });
  assert.equal(a.id, b.id);
});

// WHY: already past open must not touch first response or updated_at.
test("fix(d): markTicketAiAnswered records first response only when changed", () => {
  const id = db.createTicket({ programId: "fix-d", workspaceId: "WS-FIX", channel: "C-fix", threadTs: "fix-d-1", requesterId: "U-req", question: "q" });
  db.markTicketWaitingForHelper(id);
  assert.equal(db.getTicket(id).status, "waiting_for_helper");
  db.handle().query("UPDATE tickets SET updated_at = ?, first_response_at = ? WHERE id = ?").run(1000, 1000, id);
  tickets.markTicketAiAnswered({ ticketId: id });
  const after = db.getTicket(id);
  assert.equal(after.status, "waiting_for_helper");
  assert.equal(after.first_response_at, 1000);
  assert.equal(after.updated_at, 1000);
});

// WHY: refreshed row must exist before the timeline write.
test("fix(e): replyToTicket records helper_reply against refreshed row", async () => {
  db.saveProgram({ id: "fix-e", name: "E", helpChannel: "C-fix-e", channels: ["C-fix-e"] });
  require("./programs").invalidate();
  db.syncHelper({ programId: "fix-e", userId: "U-h", source: "manual" });
  const id = db.createTicket({ programId: "fix-e", workspaceId: "WS-FIX", channel: "C-fix-e", threadTs: "fix-e-1", requesterId: "U-req", question: "q" });
  const order = [];
  const origAdd = db.addTicketEvent;
  const origGet = db.getTicket;
  const origRec = db.recordFirstResponse;
  const slackMessages = require("./slackMessages");
  const origSend = slackMessages.sendProgramMessage;
  try {
    let firstDone = false;
    db.recordFirstResponse = (...a) => {
      const r = origRec(...a);
      firstDone = true;
      order.push("firstResponse");
      return r;
    };
    db.getTicket = (i) => {
      if (firstDone && !order.includes("secondGet")) order.push("secondGet");
      return origGet(i);
    };
    db.addTicketEvent = (a) => {
      order.push("addEvent");
      return origAdd(a);
    };
    slackMessages.sendProgramMessage = async () => ({ ts: "x" });
    const fakeClient = { chat: { postMessage: async () => ({ ts: "x" }) } };
    await tickets.replyToTicket({ ticketId: id, authorId: "U-h", text: "hi", client: fakeClient });
  } finally {
    slackMessages.sendProgramMessage = origSend;
    db.addTicketEvent = origAdd;
    db.getTicket = origGet;
    db.recordFirstResponse = origRec;
  }
  assert.ok(order.includes("secondGet") && order.includes("addEvent"));
  assert.ok(order.indexOf("secondGet") < order.indexOf("addEvent"), `order was ${order.join(",")}`);
});

test("fix(f): internalTicketAction syncs card via canonical", () => {
  const api = require("./web/api");
  db.saveProgram({ id: "fix-f", name: "F", helpChannel: "C-fix-f", channels: ["C-fix-f"] });
  require("./programs").invalidate();
  db.syncHelper({ programId: "fix-f", userId: "U-h", source: "manual" });
  const id = db.createTicket({ programId: "fix-f", workspaceId: "WS-FIX", channel: "C-fix-f", threadTs: "fix-f-1", requesterId: "U-req", question: "q" });
  db.updateTicketCardTs(id, "card-fix-f");
  db.claimProgramChannel({ workspaceId: "WS-FIX", channelId: "C-fix-f-org", programId: "fix-f", kind: "organizer" });
  const updates = [];
  const fakeClient = { chat: { update: async (p) => { updates.push(p); return { ok: true }; } } };
  api.setSlackClient(fakeClient);
  try {
    const baseEvents = db.listTicketEvents(id).length;
    const res = api.internalTicketAction(id, "claim", { programId: "fix-f", actorId: "U-h" });
    assert.equal(res.ok, true);
    assert.equal(db.getTicket(id).status, "claimed");
    assert.ok(db.listTicketEvents(id).length >= baseEvents + 1);
    assert.ok(updates.length >= 1, "dashboard claim must sync card");
  } finally {
    api.setSlackClient(null);
  }
});

// WHY: legacy dashboard must share the control-plane outcome, never silent ok.
test("fix(g): ticketUpdate routes through internalTicketAction, no silent ok", () => {
  const api = require("./web/api");
  db.syncHelper({ programId: "fix-g", userId: "U-h", source: "manual" });
  const id = db.createTicket({ programId: "fix-g", workspaceId: "WS-FIX", channel: "C-fix", threadTs: "fix-g-1", requesterId: "U-req", question: "q" });
  const badId = api.ticketUpdate(999999, "claimed", null, "U-h");
  assert.ok(badId.error, "bad id must not be silent ok");
  const badStatus = api.ticketUpdate(id, "bogus", null, "U-h");
  assert.ok(badStatus.error, "unknown status must not be silent ok");
  const ok = api.ticketUpdate(id, "claimed", "U-h", "U-h");
  assert.equal(ok.ok, true);
});

// WHY: malformed metadata must ack an error, never throw.
test("fix(h): registerActions guards private_metadata JSON.parse", async () => {
  const handlers = {};
  const fakeApp = { action: (n, fn) => { handlers[n] = fn; }, view: (n, fn) => { handlers[n] = fn; } };
  tickets.registerActions(fakeApp);
  const viewHandler = handlers["ticket_reply_modal_submit"];
  assert.ok(viewHandler);
  let acked = null;
  const ack = async (a) => { acked = a || true; };
  await viewHandler({ ack, body: { user: { id: "U-h" }, team: { id: "WS-FIX" } }, view: { private_metadata: "{{{bad", state: { values: {} } }, client: {} });
  assert.ok(acked && acked.response_action === "errors", `acked was ${JSON.stringify(acked)}`);
});

test("fix(i): recordTransition logs audit failure instead of swallowing silently", () => {
  const audit = require("./audit");
  const log = require("./log");
  const origRecord = audit.record;
  const origDebug = log.debug;
  const logged = [];
  try {
    log.debug = (...a) => { logged.push(a.join(" ")); };
    audit.record = () => { throw new Error("audit down"); };
    const id = db.createTicket({ programId: "fix-i", workspaceId: "WS-FIX", channel: "C-fix", threadTs: "fix-i-1", requesterId: "U-req", question: "q" });
    assert.doesNotThrow(() => tickets.claimTicket({ ticketId: id, actorId: "U-x" }));
  } finally {
    audit.record = origRecord;
    log.debug = origDebug;
  }
  assert.ok(logged.some((m) => m.includes("audit")), `logs were ${JSON.stringify(logged)}`);
});

// WHY: second bot touch must not bump updated_at.
test("fix(j): recordFirstResponse no-op touches nothing when already set", () => {
  const id = db.createTicket({ programId: "fix-j", workspaceId: "WS-FIX", channel: "C-fix", threadTs: "fix-j-1", requesterId: "U-req", question: "q" });
  db.recordFirstResponse(id, false);
  const before = db.getTicket(id);
  db.handle().query("UPDATE tickets SET updated_at = ? WHERE id = ?").run(1000, id);
  const mid = db.getTicket(id);
  assert.equal(mid.first_response_at, before.first_response_at);
  assert.equal(mid.updated_at, 1000);
  db.recordFirstResponse(id, false);
  const after = db.getTicket(id);
  assert.equal(after.first_response_at, before.first_response_at);
  assert.equal(after.updated_at, 1000);
});
