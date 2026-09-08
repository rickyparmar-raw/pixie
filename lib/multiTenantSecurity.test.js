process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "test-internal-token-sec";

const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const cache = require("./cache");
const tickets = require("./tickets");
const api = require("./web/api");
const respond = require("./respond");
const answer = require("./answer");
const intent = require("./intent");
const learn = require("./learn");

before(() => {
  db.close();
  db.open(":memory:");
});

beforeEach(() => {
  programs.invalidate();
});

/* -------------------------------------------------------------------------- */
/* 1. Multi-Tenant Ticket Separation & IDOR Checks                            */
/* -------------------------------------------------------------------------- */

test("multi-tenant ticket separation: Program A tickets never leak to Program B", () => {
  const wsA = "WORKSPACE_A";
  const wsB = "WORKSPACE_B";

  // Bootstrap helpers for two programs
  db.syncHelper({ programId: "prog-alpha", userId: "U_HELPER_ALPHA", source: "manual" });
  db.syncHelper({ programId: "prog-beta", userId: "U_HELPER_BETA", source: "manual" });

  const ticketA = db.createTicket({
    programId: "prog-alpha",
    workspaceId: wsA,
    channel: "C_ALPHA_HELP",
    threadTs: "t-alpha-001",
    requesterId: "U_USER_A",
    question: "How do I submit project Alpha?",
  });

  const ticketB = db.createTicket({
    programId: "prog-beta",
    workspaceId: wsB,
    channel: "C_BETA_HELP",
    threadTs: "t-beta-001",
    requesterId: "U_USER_B",
    question: "How do I submit project Beta?",
  });

  assert.ok(ticketA);
  assert.ok(ticketB);

  // 1.1 Search isolation: Program A search returns ONLY Program A tickets
  const searchA = api.internalTicketSearch({ programId: "prog-alpha" });
  assert.equal(searchA.total, 1);
  assert.equal(searchA.rows[0].id, ticketA);
  assert.equal(searchA.rows[0].program_id, "prog-alpha");

  const searchB = api.internalTicketSearch({ programId: "prog-beta" });
  assert.equal(searchB.total, 1);
  assert.equal(searchB.rows[0].id, ticketB);
  assert.equal(searchB.rows[0].program_id, "prog-beta");

  // 1.2 IDOR check: Helper of Program B cannot view/detail Program A's ticket with programId constraint
  const detailA = api.ticketDetail(ticketA);
  assert.equal(detailA.ticket.program_id, "prog-alpha");

  // 1.3 IDOR check: Helper of Program B cannot claim Program A's ticket
  const claimAttempt = api.internalTicketAction(ticketA, "claim", {
    programId: "prog-alpha",
    actorId: "U_HELPER_BETA", // Not a helper of prog-alpha!
  });
  assert.match(claimAttempt.error, /not a helper of this program/i);
  assert.equal(db.getTicket(ticketA).status, "open");

  // 1.4 IDOR check: Helper of Program B cannot claim Program A's ticket even if claiming with programId=prog-beta
  const mismatchAttempt = api.internalTicketAction(ticketA, "claim", {
    programId: "prog-beta", // spoofed programId
    actorId: "U_HELPER_BETA",
  });
  assert.match(mismatchAttempt.error, /program mismatch/i);
  assert.equal(db.getTicket(ticketA).status, "open");

  // 1.5 IDOR check: Helper of Program B cannot add internal note to Program A's ticket
  const noteAttempt = api.internalTicketNote(ticketA, {
    programId: "prog-alpha",
    actorId: "U_HELPER_BETA",
    body: "Malicious note from Beta helper",
  });
  assert.match(noteAttempt.error, /not a helper of this program/i);
  assert.equal(db.listTicketNotes(ticketA).length, 0);

  // 1.6 IDOR check: Cross-program duplicate linking is denied
  const dupAttempt = api.internalTicketAction(ticketB, "duplicate", {
    programId: "prog-beta",
    actorId: "U_HELPER_BETA",
    canonicalId: ticketA, // Ticket A belongs to prog-alpha!
  });
  assert.match(dupAttempt.error, /same program/i);
  assert.equal(db.getTicket(ticketB).status, "open");

  // 1.7 Workspace-scoped retrieval: thread in workspace A cannot be looked up in workspace B
  const foundInA = db.getTicketByThreadTs("t-alpha-001", wsA);
  assert.ok(foundInA);
  assert.equal(foundInA.id, ticketA);

  const foundInB = db.getTicketByThreadTs("t-alpha-001", wsB);
  assert.equal(foundInB, null, "Ticket from Workspace A must not be found by threadTs in Workspace B");
});

/* -------------------------------------------------------------------------- */
/* 2. Slack Channel Delivery & Privacy: Ticket Cards & Internal Notes         */
/* -------------------------------------------------------------------------- */

test("ticket cards NEVER go to public help channels — only organizer channels", async () => {
  const postedMessages = [];
  const fakeSlackClient = {
    chat: {
      postMessage: async (payload) => {
        postedMessages.push(payload);
        return { ts: `ts-${Date.now()}-${Math.random()}` };
      },
      update: async (payload) => {
        postedMessages.push({ ...payload, isUpdate: true });
        return { ts: payload.ts };
      },
    },
  };

  const progWithOrg = {
    id: "prog-secure",
    name: "Secure Program",
    posture: "active",
    helpChannel: "C_PUBLIC_HELP",
    organizerChannel: "C_PRIVATE_ORGANIZERS",
    channels: ["C_PUBLIC_HELP", "C_PRIVATE_ORGANIZERS"],
  };

  // Verify getTicketCardDestination / getOrganizerChannel
  assert.equal(
    tickets.getTicketCardDestination(progWithOrg),
    "C_PRIVATE_ORGANIZERS",
    "Ticket card destination MUST be the organizer channel",
  );
  assert.equal(
    tickets.getOrganizerChannel(progWithOrg),
    "C_PRIVATE_ORGANIZERS",
    "Organizer channel must be returned",
  );

  const ticket = await tickets.escalateTicket({
    program: progWithOrg,
    channel: "C_PUBLIC_HELP",
    threadTs: "thread-sec-1",
    requesterId: "U_REQUESTER_1",
    question: "Where do I report bugs?",
    client: fakeSlackClient,
  });

  assert.ok(ticket);

  // Analyze posted messages:
  // Message 1: In-thread user ack sent to C_PUBLIC_HELP (in thread-sec-1)
  // Message 2: Ticket triage card with action buttons sent ONLY to C_PRIVATE_ORGANIZERS
  assert.equal(postedMessages.length, 2);

  const ackMsg = postedMessages.find((m) => m.channel === "C_PUBLIC_HELP");
  assert.ok(ackMsg, "Ack message should be sent to help channel thread");
  assert.equal(ackMsg.threadTs || ackMsg.thread_ts, "thread-sec-1");
  assert.match(ackMsg.text, /flagged this for/i);
  // The ack's only interactive element is the requester/helper self-resolve
  // button — no organizer triage actions (claim/assign/reassign/close/notes)
  // may ever reach the public channel.
  const ackActionIds = (ackMsg.blocks || [])
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements.map((e) => e.action_id));
  assert.deepEqual(ackActionIds, ["public_resolve_ticket"], "Ack message must carry only the public resolve button, no organizer triage actions");

  const cardMsg = postedMessages.find((m) => m.channel === "C_PRIVATE_ORGANIZERS");
  assert.ok(cardMsg, "Ticket card MUST be sent to organizer channel");
  assert.notEqual(cardMsg.channel, "C_PUBLIC_HELP", "Ticket card must NEVER be sent to public help channel");
  assert.ok(cardMsg.blocks && cardMsg.blocks.length > 0, "Card message must contain ticket blocks");
  assert.match(cardMsg.text, /\[Ticket #/);

  // Helper claims ticket -> verify card update goes ONLY to organizer channel
  const claimRes = db.claimTicket(ticket.id, "U_HELPER_SEC");
  assert.equal(claimRes, true);
});

test("internal helper notes NEVER leak to requester threads or public channels", async () => {
  const postedMessages = [];
  const fakeSlackClient = {
    chat: {
      postMessage: async (payload) => {
        postedMessages.push(payload);
        return { ts: "msg-ts" };
      },
    },
  };

  const prog = {
    id: "prog-privacy",
    name: "Privacy Program",
    posture: "active",
    helpChannel: "C_PRIV_HELP",
    organizerChannel: "C_PRIV_ORG",
  };

  const ticketId = db.createTicket({
    programId: "prog-privacy",
    channel: "C_PRIV_HELP",
    threadTs: "thread-priv-1",
    requesterId: "U_STUDENT",
    question: "Can I get an extension?",
  });

  // Helper adds an internal note
  const noteResult = tickets.addInternalNote({
    ticketId,
    authorId: "U_INTERNAL_STAFF",
    body: "Confidential: User has already used 2 extensions, allow 1 day maximum.",
  });

  assert.ok(noteResult.ok);
  assert.ok(noteResult.noteId);

  // Verify that NO Slack message was posted anywhere when adding an internal note
  assert.equal(postedMessages.length, 0, "Internal note must NEVER call Slack postMessage");

  // Verify note is recorded in DB and only visible via ticket detail
  const notes = db.listTicketNotes(ticketId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].author_id, "U_INTERNAL_STAFF");
  assert.match(notes[0].body, /Confidential/);

  // Verify other tickets do not see this note
  const otherTicketId = db.createTicket({
    programId: "prog-privacy",
    channel: "C_PRIV_HELP",
    threadTs: "thread-priv-2",
    requesterId: "U_OTHER_STUDENT",
    question: "When is grading done?",
  });
  assert.equal(db.listTicketNotes(otherTicketId).length, 0);
});

/* -------------------------------------------------------------------------- */
/* 3. Idempotency & Concurrency Races                                         */
/* -------------------------------------------------------------------------- */

test("idempotent message claiming: redelivered Slack messages are rejected", () => {
  const ts = "1725700000.000100";
  const channel = "C_CHANNEL_IDEMPOTENT";

  // First delivery succeeds
  const firstClaim = db.claimMessage(ts, channel);
  assert.equal(firstClaim, true, "First message delivery must be claimed successfully");

  // Redelivery 1 (same ts, same channel)
  const redelivery1 = db.claimMessage(ts, channel);
  assert.equal(redelivery1, false, "Redelivered message must be rejected");

  // Redelivery 2 (subsequent attempt)
  const redelivery2 = db.claimMessage(ts, channel);
  assert.equal(redelivery2, false, "Subsequent redelivery must also be rejected");

  // Claiming the same timestamp again even in another channel is rejected (ts is globally unique)
  assert.equal(db.claimMessage(ts, "C_OTHER_CHANNEL"), false, "Same ts cannot be re-claimed in another channel");

  // Different message timestamp succeeds
  assert.equal(db.claimMessage("1725700000.000200", channel), true);
  assert.equal(db.claimMessage("1725700000.000300", "C_OTHER_CHANNEL"), true);
});

test("escalateTicket is idempotent on threadTs duplicate calls", async () => {
  const posted = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posted.push(p);
        return { ts: `card-${Date.now()}` };
      },
    },
  };

  const prog = {
    id: "prog-idem",
    name: "Idem Program",
    posture: "active",
    helpChannel: "C_HELP_IDEM",
    organizerChannel: "C_ORG_IDEM",
  };

  // Call escalateTicket 3 times concurrently / consecutively for the exact same thread
  const t1 = await tickets.escalateTicket({
    program: prog,
    channel: "C_HELP_IDEM",
    threadTs: "thread-idem-dup",
    requesterId: "U_REQ_1",
    question: "Need help!",
    client,
  });

  const t2 = await tickets.escalateTicket({
    program: prog,
    channel: "C_HELP_IDEM",
    threadTs: "thread-idem-dup",
    requesterId: "U_REQ_1",
    question: "Need help!",
    client,
  });

  const t3 = await tickets.escalateTicket({
    program: prog,
    channel: "C_HELP_IDEM",
    threadTs: "thread-idem-dup",
    requesterId: "U_REQ_1",
    question: "Need help!",
    client,
  });

  assert.equal(t1.id, t2.id, "Second call must return identical ticket ID");
  assert.equal(t1.id, t3.id, "Third call must return identical ticket ID");

  // Only 1 ack and 1 card should be posted across all 3 calls
  assert.equal(posted.length, 2, "Only initial escalation should post to Slack");
});

/* -------------------------------------------------------------------------- */
/* 4. Grounded Answer vs Escalation Mutual Exclusion                          */
/* -------------------------------------------------------------------------- */

test("grounded answer and escalation are mutually exclusive (grounded -> no escalation)", async () => {
  const client = {
    calls: { posts: [], updates: [] },
    chat: {
      postMessage: async (p) => {
        client.calls.posts.push(p.text || "");
        return { ts: "ts-grounded-reply" };
      },
      update: async (p) => {
        client.calls.updates.push(p.text || "");
        return { ts: p.ts };
      },
      delete: async () => ({ ok: true }),
    },
    reactions: {
      add: async () => {
        throw new Error("Reaction must NOT be added when grounded answer exists!");
      },
    },
  };

  const origGetAnswer = answer.getAnswerOrChatStream;
  // Mock model returning a grounded answer with valid source
  answer.getAnswerOrChatStream = async () => ({
    source: "Official Guidelines",
    answer: "You can resubmit returned projects once fixes are made.",
  });

  const prog = {
    id: "prog-grounded",
    name: "Grounded Program",
    posture: "active",
    helpChannel: "C_GROUNDED_HELP",
    organizerChannel: "C_GROUNDED_ORG",
    channels: ["C_GROUNDED_HELP"],
  };

  try {
    const replied = await respond.respond({
      client,
      channel: "C_GROUNDED_HELP",
      threadTs: "t-grounded-100",
      userId: "U_GROUNDED_USER",
      question: "can I resubmit my project if returned?",
      mode: respond.ALWAYS,
      program: prog,
    });

    assert.equal(replied, true);
    // Verified: Answer was posted to thread
    const allText = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(allText, /resubmit returned projects/i);

    // Verified: Mutual exclusion — NO ticket opened in DB for this thread!
    const ticket = db.getTicketByThreadTs("t-grounded-100");
    assert.equal(ticket, null, "Ticket MUST NOT be created when a grounded answer is delivered");
  } finally {
    answer.getAnswerOrChatStream = origGetAnswer;
  }
});

test("grounded answer and escalation are mutually exclusive (unanswerable -> escalates, no hallucination)", async () => {
  const posted = [];
  const reactions = [];
  const client = {
    calls: { posts: [], updates: [] },
    chat: {
      postMessage: async (p) => {
        posted.push(p);
        return { ts: `ts-${Date.now()}` };
      },
      update: async (p) => {
        posted.push(p);
        return { ts: p.ts };
      },
      delete: async () => ({ ok: true }),
    },
    reactions: {
      add: async (r) => {
        reactions.push(r.name);
        return { ok: true };
      },
    },
  };

  const origGetAnswer = answer.getAnswerOrChatStream;
  const origIntent = intent.classifyIntent;

  // Mock model saying it cannot answer (unclear / unknown)
  answer.getAnswerOrChatStream = async () => ({
    source: null,
    answer: "",
    unclear: true,
  });
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  const prog = {
    id: "prog-gap",
    name: "Gap Program",
    posture: "active",
    helpChannel: "C_GAP_HELP",
    organizerChannel: "C_GAP_ORG",
    channels: ["C_GAP_HELP", "C_GAP_ORG"],
  };

  // Register program and claim channels in program_channels
  db.saveProgram(prog);
  db.claimProgramChannel({ programId: "prog-gap", channelId: "C_GAP_HELP", kind: "help" });
  db.claimProgramChannel({ programId: "prog-gap", channelId: "C_GAP_ORG", kind: "organizer" });
  programs.invalidate();

  try {
    // In HELP_ONLY mode (unprompted student in help channel):
    // Bot must not chat hallucinated answers, but MUST escalate ticket to organizers
    const handled = await respond.respond({
      client,
      channel: "C_GAP_HELP",
      threadTs: "t-gap-200",
      userId: "U_STUDENT_GAP",
      question: "My custom FPGA board has error code 0x8899, what does it mean?",
      mode: respond.HELP_ONLY,
      program: prog,
    });

    assert.equal(handled, true, "Authoritative terminal action: ESCALATE handles the request");
    // Help channel receives only the in-thread helper ack, never ticket action blocks or AI chat hallucination
    const helpChannelMsgs = posted.filter((p) => p.channel === "C_GAP_HELP");
    assert.equal(helpChannelMsgs.length, 1, "Only 1 message in help channel (the ack)");
    assert.match(helpChannelMsgs[0].text, /flagged this for/i, "Help channel message is the helper ack");
    const ackActionIds = (helpChannelMsgs[0].blocks || [])
      .filter((b) => b.type === "actions")
      .flatMap((b) => b.elements.map((e) => e.action_id));
    assert.deepEqual(ackActionIds, ["public_resolve_ticket"], "Ack message must not contain ticket triage action buttons — only the public resolve button");

    // Verified: Ticket was opened
    const ticket = db.getTicketByThreadTs("t-gap-200");
    assert.ok(ticket, "Ticket MUST be created for unanswered help request");
    assert.equal(ticket.program_id, "prog-gap");

    // Verified: Ticket card was sent to organizer channel, NOT help channel
    const cardMsg = posted.find((p) => p.channel === "C_GAP_ORG");
    assert.ok(cardMsg, "Ticket card must be sent to organizer channel");
    const organizerOnlyActionIds = ["claim_ticket", "resolve_ticket", "unclaim_ticket", "close_ticket", "reopen_ticket", "reassign_select", "reply_ticket_button"];
    const helpChannelOrganizerActions = posted
      .filter((p) => p.channel === "C_GAP_HELP")
      .flatMap((p) => (p.blocks || []).filter((b) => b.type === "actions").flatMap((b) => b.elements.map((e) => e.action_id)))
      .filter((id) => organizerOnlyActionIds.includes(id));
    assert.equal(helpChannelOrganizerActions.length, 0, "Organizer-only ticket triage actions must never appear in the help channel");
  } finally {
    answer.getAnswerOrChatStream = origGetAnswer;
    intent.classifyIntent = origIntent;
    db.deleteProgram("prog-gap");
    programs.invalidate();
  }
});

/* -------------------------------------------------------------------------- */
/* 5. Cache Tenancy Isolation                                                 */
/* -------------------------------------------------------------------------- */

test("cache tenancy isolation: Program A and Program B cache keys never collide", () => {
  const question = "what is the stipend amount?";

  // Program A cache put
  cache.put(question, { source: "Alpha Docs", answer: "$100 stipend for Alpha" }, "tenant-alpha");

  // Program B cache put for same question with different answer
  cache.put(question, { source: "Beta Docs", answer: "$250 stipend for Beta" }, "tenant-beta");

  // Retrieve Program A -> gets Alpha answer
  const hitA = cache.get(question, "tenant-alpha");
  assert.ok(hitA);
  assert.equal(hitA.source, "Alpha Docs");
  assert.equal(hitA.answer, "$100 stipend for Alpha");

  // Retrieve Program B -> gets Beta answer
  const hitB = cache.get(question, "tenant-beta");
  assert.ok(hitB);
  assert.equal(hitB.source, "Beta Docs");
  assert.equal(hitB.answer, "$250 stipend for Beta");

  // Unscoped query -> gets null (no cross-tenant leakage to unscoped caller)
  const hitUnscoped = cache.get(question, null);
  assert.equal(hitUnscoped, null, "Unscoped cache query must return null");

  // Querying a third tenant with same question -> gets null (cache miss)
  const hitGamma = cache.get(question, "tenant-gamma");
  assert.equal(hitGamma, null, "Third tenant must get a cache miss");
});

test("cache key hashing incorporates programId prefix into SHA1", () => {
  const keyAlpha = cache.keyFor("how do I apply", "tenant-alpha");
  const keyBeta = cache.keyFor("how do I apply", "tenant-beta");
  const keyUnscoped = cache.keyFor("how do I apply", null);

  assert.ok(keyAlpha);
  assert.ok(keyBeta);
  assert.ok(keyUnscoped);

  assert.notEqual(keyAlpha, keyBeta, "Keys for different tenants must not match");
  assert.notEqual(keyAlpha, keyUnscoped, "Tenant key must not match unscoped key");
  assert.notEqual(keyBeta, keyUnscoped, "Tenant key must not match unscoped key");
});

/* -------------------------------------------------------------------------- */
/* 3. !teach tenant isolation                                                 */
/* -------------------------------------------------------------------------- */

// handlers.js resolves workspace_id + channel_id -> an exact program before
// ever calling learn.teach() — these tests exercise the storage/retrieval
// contract that resolution feeds into: a fact taught for one program must
// never surface when another program's corpus is built, and vice versa.
test("!teach stores a fact scoped to exactly one program", () => {
  const idA = learn.teach({ question: "what is the stipend", answer: "$100 for program A", authorId: "U1", channel: "C-A", programId: "teach-prog-a" });
  const idB = learn.teach({ question: "what is the stipend", answer: "$500 for program B", authorId: "U2", channel: "C-B", programId: "teach-prog-b" });
  assert.ok(idA);
  assert.ok(idB);
  assert.notEqual(idA, idB);

  const factsForA = db.approvedFacts(50, "teach-prog-a");
  const factsForB = db.approvedFacts(50, "teach-prog-b");

  assert.ok(factsForA.some((f) => f.answer === "$100 for program A"), "program A sees its own taught fact");
  assert.ok(!factsForA.some((f) => f.answer === "$500 for program B"), "program A must not see program B's fact");

  assert.ok(factsForB.some((f) => f.answer === "$500 for program B"), "program B sees its own taught fact");
  assert.ok(!factsForB.some((f) => f.answer === "$100 for program A"), "program B must not see program A's fact");
});

test("!teach fact scoped to a program is excluded from an unrelated program's corpus section", () => {
  learn.teach({ question: "unique-only-a question", answer: "answer only for A", authorId: "U1", channel: "C-A2", programId: "teach-corpus-a" });

  const corpusForA = learn.corpusSection("teach-corpus-a");
  const corpusForOther = learn.corpusSection("teach-corpus-unrelated");

  assert.ok(corpusForA.includes("answer only for A"), "the teaching program's corpus includes the fact");
  assert.ok(!corpusForOther.includes("answer only for A"), "an unrelated program's corpus must not include another program's taught fact");
});

/* -------------------------------------------------------------------------- */
/* Support Radar & incident lifecycle: cross-program isolation                */
/* -------------------------------------------------------------------------- */

test("radar signals list only ever returns the requested program's own rows", () => {
  db.saveProgram({ id: "radar-sec-a", name: "RadarSecA" });
  db.saveProgram({ id: "radar-sec-b", name: "RadarSecB" });
  programs.invalidate();
  const radar = require("./radar");
  radar.upsertSignal({ programId: "radar-sec-a", type: "STALE_TICKETS", severity: "HIGH", title: "A's backlog", summary: "s", evidence: {}, fingerprint: "backlog" });
  radar.upsertSignal({ programId: "radar-sec-b", type: "STALE_TICKETS", severity: "HIGH", title: "B's backlog", summary: "s", evidence: {}, fingerprint: "backlog" });

  const forA = api.internalRadarList("radar-sec-a").signals;
  assert.equal(forA.length, 1);
  assert.equal(forA[0].title, "A's backlog");
  assert.ok(!forA.some((s) => s.title.includes("B's backlog")));
});

test("a helper of Program A cannot acknowledge, resolve, or suppress a Program B radar signal", () => {
  db.saveProgram({ id: "radar-sec-c", name: "RadarSecC" });
  db.saveProgram({ id: "radar-sec-d", name: "RadarSecD" });
  programs.invalidate();
  db.syncHelper({ programId: "radar-sec-c", userId: "U-helper-c", source: "manual" });
  const radar = require("./radar");
  const signalD = radar.upsertSignal({ programId: "radar-sec-d", type: "REOPEN_SPIKE", severity: "MEDIUM", title: "D's spike", summary: "s", evidence: {}, fingerprint: "reopen" });

  for (const action of ["acknowledge", "resolve"]) {
    const res = api.internalRadarAction(signalD.id, { actorId: "U-helper-c", action });
    assert.ok(res.error, `${action} should be rejected across programs`);
  }
  const suppressRes = api.internalRadarAction(signalD.id, { actorId: "U-helper-c", action: "suppress", duration: "1h" });
  assert.ok(suppressRes.error);
  assert.equal(radar.getSignal(signalD.id).status, "active"); // untouched
});

test("changing programId in a radar evaluate request cannot reach across tenants — a non-helper of the target program is refused", () => {
  db.saveProgram({ id: "radar-sec-e", name: "RadarSecE" });
  db.saveProgram({ id: "radar-sec-f", name: "RadarSecF" });
  programs.invalidate();
  db.syncHelper({ programId: "radar-sec-e", userId: "U-helper-e", source: "manual" });

  const res = api.internalRadarEvaluate("radar-sec-f", { actorId: "U-helper-e" });
  assert.ok(res.error);
});

test("a Program A helper cannot declare, dismiss, resolve, or notify affected users on a Program B incident", async () => {
  db.saveProgram({ id: "inc-sec-a", name: "IncSecA" });
  db.saveProgram({ id: "inc-sec-b", name: "IncSecB" });
  programs.invalidate();
  db.syncHelper({ programId: "inc-sec-a", userId: "U-helper-a", source: "manual" });
  const incB = Number(
    db.handle().query("INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'candidate', ?, ?)")
      .run("inc-sec-b", "B's outage", Date.now(), Date.now()).lastInsertRowid,
  );

  for (const action of ["declare", "confirmed", "dismissed", "resolved"]) {
    const res = api.internalIncidentAction(incB, { actorId: "U-helper-a", action });
    assert.ok(res.error, `action ${action} should be rejected across programs`);
  }
  const notifyRes = await api.internalIncidentNotify(incB, { actorId: "U-helper-a" });
  assert.ok(notifyRes.error);
});
