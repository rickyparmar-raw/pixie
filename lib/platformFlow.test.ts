process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "test-internal-token";

interface TestRow {
  program?: { id: string };
  username?: string;
  [key: string]: unknown;
}

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const lookup = require("./lookup");
const respond = require("./respond");
const api = require("./web/api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
  knowledge.invalidate();
});

test("hosted loop end to end for Highway and Pixl", async () => {
  const hwy = api.internalProgramSync("e2e-hwy", {
    name: "Highway",
    workspaceId: "TE2E",
    supportName: "Highway Help",
    helpChannel: "C-E2E-HWY",
    channels: ["C-E2E-HWY"],
    sources: [{ name: "E2E Highway Docs", type: "text", content: "Highway ships October 31." }],
    claimedBy: "U-org",
    programChannels: [{ id: "C-E2E-HWY", kind: "help" }],
  });
  assert.equal(hwy.ok, true);
  assert.equal(db.isHelper("e2e-hwy", "U-org"), true, "creator bootstrapped as organizer");

  const pxl = api.internalProgramSync("e2e-pixl", {
    name: "Pixl",
    workspaceId: "TE2E",
    helpChannel: "C-E2E-PXL",
    channels: ["C-E2E-PXL"],
    sources: [{ name: "E2E Pixl Docs", type: "text", content: "Pixl ships August 18." }],
    claimedBy: "U-org2",
    programChannels: [{ id: "C-E2E-PXL", kind: "help" }],
  });
  assert.equal(pxl.ok, true);

  assert.equal(programs.forChannel("C-E2E-HWY", "TE2E").id, "e2e-hwy");
  assert.equal(programs.forChannel("C-E2E-PXL", "TE2E").id, "e2e-pixl");

  const realAnswer = lookup.answerOrChat;
  lookup.answerOrChat = async (question: string, contextPrompt: string, opts: TestRow = {}) => {
    const pid = opts.program ? opts.program.id : null;
    return pid === "e2e-hwy"
      ? { source: "E2E Highway Docs", answer: "October 31" }
      : { source: "E2E Pixl Docs", answer: "August 18" };
  };
  const posts: TestRow[] = [];
  const client = {
    chat: {
      postMessage: async (p: TestRow) => {
        posts.push(p);
        return { ts: `ts-${posts.length}` };
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: { add: async () => ({}) },
  };
  try {
    await respond.respond({
      client, channel: "C-E2E-HWY", threadTs: "e2e-t1", userId: "U-asker",
      question: "when is the deadline", mode: respond.ALWAYS, workspaceId: "TE2E",
    });
  } finally {
    lookup.answerOrChat = realAnswer;
  }
  assert.ok(posts.length >= 1);
  assert.ok(posts.some((p: TestRow) => p.username === "Highway Help"), "answer carries program branding");

  const realAnswer2 = lookup.answerOrChat;
  lookup.answerOrChat = async () => ({ source: null, answer: null });
  const posts2: TestRow[] = [];
  const client2 = { chat: { postMessage: async (p: TestRow) => { posts2.push(p); return { ts: "x" }; }, update: async () => ({}), delete: async () => ({}) }, reactions: { add: async () => ({}) } };
  const intent = require("./intent");
  const realClassify = intent.classifyIntent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    await respond.respond({
      client: client2, channel: "C-E2E-HWY", threadTs: "e2e-t2", userId: "U-asker",
      question: "can I get a private extension on my grant", mode: respond.HELP_ONLY, workspaceId: "TE2E",
    });
  } finally {
    lookup.answerOrChat = realAnswer2;
    intent.classifyIntent = realClassify;
  }
  const ticket = db.getTicketByThreadTs("e2e-t2", "TE2E");
  assert.ok(ticket, "escalation filed a ticket");
  assert.equal(ticket.program_id, "e2e-hwy");

  db.syncHelper({ programId: "e2e-hwy", userId: "U-helper", source: "manual" });
  assert.equal(api.internalTicketAction(ticket.id, "claim", { programId: "e2e-hwy", actorId: "U-helper" }).ok, true);
  const tickets = require("./tickets");
  const replyRes = await tickets.replyToTicket({ ticketId: ticket.id, authorId: "U-helper", text: "looking into it", client });
  assert.equal(replyRes.ok, true);
  assert.equal(api.internalTicketAction(ticket.id, "resolve", { programId: "e2e-hwy", actorId: "U-helper" }).ok, true);
  assert.equal(db.getTicket(ticket.id).status, "resolved");
  assert.equal(api.internalTicketAction(ticket.id, "reopen", { programId: "e2e-hwy", actorId: "U-helper" }).ok, true);
  assert.equal(db.getTicket(ticket.id).status, "reopened");

  assert.equal(db.searchTickets({ programId: "e2e-pixl" }).total, 0);
});
export {};
