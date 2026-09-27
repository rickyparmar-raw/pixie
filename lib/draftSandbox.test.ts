process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_PROGRAMS_JSON = "[]";

interface PostedMessage { channel?: string; [key: string]: unknown; }

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const sandbox = require("./draftSandbox");
const knowledge = require("./knowledge");
const programs = require("./programs");

beforeEach(() => {
  db.close();
  db.open(":memory:");
  sandbox.clear();
  process.env.PIXIE_PROGRAMS_JSON = "[]";
  programs.invalidate();
});

test("draft bindings are explicit and do not become production channel claims", () => {
  sandbox.register({ id: "jame-gam", status: "suspended", privateSandboxOnly: true, sandboxBindings: [{ channelId: "C-JAME", role: "help" }], sourceTexts: { docs: "Jame Gam docs" } });
  assert.equal(sandbox.getForChannel("C-JAME")?.draftProgramId, "jame-gam");
  assert.equal(db.getChannelOwner("default", "C-JAME"), null);
  assert.equal(db.listProgramChannels("jame-gam").length, 0);
});

test("draft knowledge is isolated and uses draft-specific storage", () => {
  sandbox.register({ id: "live-ysws", status: "suspended", privateSandboxOnly: true, sandboxBindings: [], sourceTexts: { docs: "Live has a 10 minute multiplier." }, faqContent: "Q: How does Live work?\nA: Live supports streaming." });
  const result = knowledge.registerDraftKnowledge({ id: "live-ysws", status: "suspended", privateSandboxOnly: true, sandboxBindings: [], sourceTexts: { docs: "Live has a 10 minute multiplier." }, faqContent: "Q: How does Live work?\nA: Live supports streaming." }, { docs: "Live has a 10 minute multiplier." });
  assert.equal(result.sources, 2, "Live drafts include their canonical Live-owned knowledge source alongside supplied sources");
  assert.match(knowledge.getDraftContext("live-ysws", "how much time does one hour add"), /10 minute/i);
  assert.doesNotMatch(knowledge.getDraftContext("live-ysws", "Hardwire tiers"), /T1 Digital Logic|iCE40|T2 ASIC Tapeout|T3 Custom Carrier Board/);
});

test("canonical Jame Gam draft docs are persisted as owned source rows", () => {
  const draft = { id: "jame-gam", status: "suspended", privateSandboxOnly: true, sandboxBindings: [] };
  knowledge.registerDraftKnowledge(draft, {});
  const row = db.handle().query("SELECT source_name, length(text) AS chars FROM draft_sandbox_sources WHERE program_id = ?").get("jame-gam");
  assert.equal(row?.source_name, "Jame Gam Complete Docs");
  assert.ok(row?.chars > 1000, "canonical Jame Gam docs must survive draft persistence");
});

test("draft binding resolves across workspaces (production PIXIE_WORKSPACE_ID unset)", () => {
  sandbox.register({ id: "jame-gam", status: "suspended", privateSandboxOnly: true, workspaceId: "T0266FRGM", sandboxBindings: [{ channelId: "C0C14QK28LD", role: "help" }], sourceTexts: { docs: "Jame Gam docs" } });
  assert.equal(sandbox.getForChannel("C0C14QK28LD", null)?.draftProgramId, "jame-gam");
  assert.equal(sandbox.getForChannel("C0C14QK28LD", "T-OTHER")?.draftProgramId, "jame-gam");
});

test("suspended draft sandbox answers without production claim; muted posture and tickets_enabled=false do not suppress", async () => {
  const handlers = require("./handlers");
  const answer = require("./answer");
  const slackMessages = require("./slackMessages");
  const programs = require("./programs");
  sandbox.register({
    id: "jame-gam",
    name: "Jame Gam",
    status: "suspended",
    privateSandboxOnly: true,
    autoAssign: false,
    workspaceId: "T0266FRGM",
    sandboxBindings: [{ channelId: "C-DRAFT-HELP", role: "help" }],
    sourceTexts: { docs: "Jame Gam prize selection DM arrives in Slack." },
  });
  knowledge.registerDraftKnowledge(
    { id: "jame-gam", status: "suspended", privateSandboxOnly: true, sandboxBindings: [] },
    { docs: "Jame Gam prize selection DM arrives in Slack." },
  );
  assert.equal(db.getChannelOwner("T0266FRGM", "C-DRAFT-HELP"), null);
  const prog = programs.forChannel("C-DRAFT-HELP", null);
  assert.equal(prog.id, "ysws-global");
  const savedAnswer = answer.getGroundedAnswer;
  const savedSend = slackMessages.sendProgramMessage;
  const posted: PostedMessage[] = [];
  answer.getGroundedAnswer = async () => ({ answer: "draft answer", source: "docs" });
  slackMessages.sendProgramMessage = async (args: PostedMessage) => { posted.push(args); return { ts: "1" }; };
  try {
    await handlers.onMessage({
      event: { channel: "C-DRAFT-HELP", user: "U-TESTER", text: "where do i get the prize selection dm for jame gam?", ts: "1789202762.605789" },
      client: {},
    });
  } finally {
    answer.getGroundedAnswer = savedAnswer;
    slackMessages.sendProgramMessage = savedSend;
  }
  assert.equal(posted.length, 1);
  assert.equal(posted[0].channel, "C-DRAFT-HELP");
  assert.equal(db.getChannelOwner("T0266FRGM", "C-DRAFT-HELP"), null);
  assert.equal(db.getChannelOwner("default", "C-DRAFT-HELP"), null);
});

test("draft help question creates one sandbox ticket in its bound sink without a production ticket", async () => {
  const handlers = require("./handlers");
  const answer = require("./answer");
  const slackMessages = require("./slackMessages");
  sandbox.register({
    id: "jame-gam",
    name: "Jame Gam",
    status: "suspended",
    privateSandboxOnly: true,
    autoAssign: false,
    workspaceId: "T0266FRGM",
    sandboxBindings: [
      { channelId: "C-DRAFT-HELP", role: "help" },
      { channelId: "C-DRAFT-SINK", role: "ticket" },
    ],
    sourceTexts: { docs: "Jame Gam prize selection DMs arrive in Slack." },
  });
  knowledge.registerDraftKnowledge(
    { id: "jame-gam", status: "suspended", privateSandboxOnly: true, sandboxBindings: [] },
    { docs: "Jame Gam prize selection DMs arrive in Slack." },
  );
  const savedAnswer = answer.getGroundedAnswer;
  const savedSend = slackMessages.sendProgramMessage;
  const posted: PostedMessage[] = [];
  answer.getGroundedAnswer = async () => ({ answer: "draft answer", source: "docs" });
  slackMessages.sendProgramMessage = async (args: PostedMessage) => { posted.push(args); return { ts: `post-${posted.length}` }; };
  const event = { channel: "C-DRAFT-HELP", user: "U-TESTER", text: "where do i get the prize selection dm?", ts: "draft-ticket-1", team: "T0266FRGM" };
  try {
    await handlers.onMessage({ event, client: {} });
    await handlers.onMessage({ event, client: {} });
  } finally {
    answer.getGroundedAnswer = savedAnswer;
    slackMessages.sendProgramMessage = savedSend;
  }
  const ticket = sandbox.getTicketForThread("jame-gam", "T0266FRGM", "draft-ticket-1");
  assert.ok(ticket, "a draft help question must create a sandbox ticket");
  assert.equal(ticket.sink_channel, "C-DRAFT-SINK");
  assert.equal(db.getTicketByThreadTs("draft-ticket-1", "T0266FRGM", "jame-gam"), null, "draft tickets must not enter the production tickets table");
  assert.equal(posted.filter((post: PostedMessage) => post.channel === "C-DRAFT-SINK").length, 1, "Slack retries must not duplicate the sink card");
  assert.equal(posted.filter((post: PostedMessage) => post.channel === "C-DRAFT-HELP").length, 1, "Slack retries must not duplicate the same-thread answer");
});

test("unanswerable draft question posts scoped fallback instead of silence", async () => {
  const handlers = require("./handlers");
  const answer = require("./answer");
  const slackMessages = require("./slackMessages");
  sandbox.register({
    id: "jame-gam",
    name: "Jame Gam",
    status: "suspended",
    privateSandboxOnly: true,
    autoAssign: false,
    workspaceId: "T0266FRGM",
    sandboxBindings: [{ channelId: "C-DRAFT-HELP", role: "help" }],
    sourceTexts: { docs: "Jame Gam prize list." },
  });
  knowledge.registerDraftKnowledge(
    { id: "jame-gam", status: "suspended", privateSandboxOnly: true, sandboxBindings: [] },
    { docs: "Jame Gam prize list." },
  );
  const savedAnswer = answer.getGroundedAnswer;
  const savedSend = slackMessages.sendProgramMessage;
  const posted: PostedMessage[] = [];
  answer.getGroundedAnswer = async () => null;
  slackMessages.sendProgramMessage = async (args: PostedMessage) => { posted.push(args); return { ts: "1" }; };
  try {
    await handlers.onMessage({
      event: { channel: "C-DRAFT-HELP", user: "U-TESTER", text: "something not in draft docs?", ts: "1789203999.000001" },
      client: {},
    });
  } finally {
    answer.getGroundedAnswer = savedAnswer;
    slackMessages.sendProgramMessage = savedSend;
  }
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /scoped to jame-gam/i);
});

test("public non-bound channel gets no draft response and foreign query stays draft-scoped", () => {
  sandbox.register({ id: "jame-gam", status: "suspended", privateSandboxOnly: true, sandboxBindings: [{ channelId: "C-DRAFT-HELP", role: "help" }], sourceTexts: { docs: "Jame Gam docs" } });
  assert.equal(sandbox.getForChannel("C-PUBLIC", null), null);
  knowledge.registerDraftKnowledge(
    { id: "jame-gam", status: "suspended", privateSandboxOnly: true, sandboxBindings: [] },
    { docs: "Jame Gam docs" },
  );
  assert.doesNotMatch(knowledge.getDraftContext("jame-gam", "what are Hardwire tiers"), /T1 Digital Logic|iCE40|T2 ASIC Tapeout|T3 Custom Carrier Board/i);
});
export {};
