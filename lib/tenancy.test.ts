type TestAny = any;
process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "test-internal-token";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const cache = require("./cache");
const api = require("./web/api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
  knowledge.invalidate();
});

const WS = "T1";
const Q = "when is the submission deadline";

function seedPrograms() {
  programs.invalidate();
  db.saveProgram({
    id: "tnt-hwy",
    name: "Highway",
    helpChannel: "C_HIGHWAY",
    channels: ["C_HIGHWAY"],
    sources: [
      { name: "TNT Highway Docs", type: "text", content: "Highway deadline is october 31. Ship by halloween." },
    ],
  });
  db.saveProgram({
    id: "tnt-acme",
    name: "Acme",
    helpChannel: "C_ACME",
    channels: ["C_ACME"],
    sources: [
      { name: "TNT Acme Docs", type: "text", content: "Acme deadline is august 18. Ship before school starts." },
    ],
  });
  programs.invalidate();
}

const TNT_BLOB = JSON.stringify([
  {
    id: "tnt-hwy",
    name: "Highway",
    helpChannel: "C_HIGHWAY",
    channels: ["C_HIGHWAY"],
    sources: [
      { name: "TNT Highway Docs", type: "text", content: "Highway deadline is october 31. Ship by halloween." },
    ],
  },
  {
    id: "tnt-acme",
    name: "Acme",
    helpChannel: "C_ACME",
    channels: ["C_ACME"],
    sources: [
      { name: "TNT Acme Docs", type: "text", content: "Acme deadline is august 18. Ship before school starts." },
    ],
  },
]);

test("two tenants: same question resolves to different programs and knowledge", async () => {
  seedPrograms();

  const savedBlob = process.env.PIXIE_PROGRAMS_JSON;
  const axios = require("axios");
  const realGet = axios.get;
  process.env.PIXIE_PROGRAMS_JSON = TNT_BLOB;
  programs.invalidate();
  knowledge.invalidate();
  axios.get = async () => {
    throw new Error("network disabled in test");
  };
  try {
    await knowledge.refreshCorpus();
  } finally {
    axios.get = realGet;
    if (savedBlob === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = savedBlob;
    programs.invalidate();
    knowledge.invalidate();
  }

  assert.equal(programs.forChannel("C_HIGHWAY", WS).id, "tnt-hwy");
  assert.equal(programs.forChannel("C_ACME", WS).id, "tnt-acme");

  const hwyCtx = knowledge.getContext(Q, "tnt-hwy");
  const acmeCtx = knowledge.getContext(Q, "tnt-acme");
  assert.match(hwyCtx, /october 31/i);
  assert.doesNotMatch(hwyCtx, /august 18/i);
  assert.match(acmeCtx, /august 18/i);
  assert.doesNotMatch(acmeCtx, /october 31/i);
});

test("two tenants: answer caches never bleed", () => {
  cache.put(Q, { source: "TNT Highway Docs", answer: "october 31" }, "tnt-hwy");
  assert.equal(cache.get(Q, "tnt-hwy").answer, "october 31");
  assert.equal(cache.get(Q, "tnt-acme"), null);
  assert.equal(cache.get(Q, null), null);
});

test("two tenants: learned facts and doc gaps stay scoped", () => {
  db.addLearnedFact({ question: "hwy only", answer: "yes", status: "approved", programId: "tnt-hwy" });
  const acmeFacts = db.approvedFacts(50, "tnt-acme").map((f: TestAny) => f.question);
  assert.ok(!acmeFacts.includes("hwy only"));

  db.recordGap("tnt shared wording", "U1", "C_HIGHWAY", "t-hwy-1", "tnt-hwy");
  db.recordGap("tnt shared wording", "U2", "C_HIGHWAY", "t-hwy-2", "tnt-hwy");
  const acmeGaps = db.topGaps(20, 30 * 24 * 60 * 60 * 1000, { programId: "tnt-acme", minAskers: 1 });
  assert.ok(!acmeGaps.some((g: TestAny) => g.question.includes("tnt shared wording")));
  const hwyGaps = db.topGaps(20, 30 * 24 * 60 * 60 * 1000, { programId: "tnt-hwy", minAskers: 1 });
  assert.ok(hwyGaps.some((g: TestAny) => g.question.includes("tnt shared wording")));
});

test("two tenants: tickets, helpers, notes, audit are independent; cross-write denied", () => {
  db.syncHelper({ programId: "tnt-hwy", userId: "U-hwy-helper", source: "manual" });
  db.syncHelper({ programId: "tnt-acme", userId: "U-acme-helper", source: "manual" });

  const hwyId = db.createTicket({
    programId: "tnt-hwy",
    workspaceId: WS,
    channel: "C_HIGHWAY",
    threadTs: "t-hwy-9",
    requesterId: "U1",
    question: Q,
  });
  const acmeId = db.createTicket({
    programId: "tnt-acme",
    workspaceId: WS,
    channel: "C_ACME",
    threadTs: "t-acme-9",
    requesterId: "U2",
    question: Q,
  });

  const denied = api.internalTicketAction(hwyId, "claim", { programId: "tnt-hwy", actorId: "U-acme-helper" });
  assert.match(denied.error, /not a helper/);

  const ok = api.internalTicketAction(hwyId, "claim", { programId: "tnt-hwy", actorId: "U-hwy-helper" });
  assert.equal(ok.ok, true);
  assert.equal(db.getTicket(acmeId).status, "open");

  db.addTicketNote({ ticketId: hwyId, programId: "tnt-hwy", authorId: "U-hwy-helper", body: "hwy secret" });
  assert.equal(db.listTicketNotes(acmeId).length, 0);

  const acmeAudit = db.listAuditEvents({ programId: "tnt-acme" });
  assert.ok(!acmeAudit.some((e: TestAny) => (e.metadata || "").includes("hwy secret")));

  db.resolveTicket(hwyId, "done");
  assert.equal(db.getTicket(acmeId).status, "open");
  db.reopenTicket(hwyId);
  assert.equal(db.getTicket(hwyId).status, "reopened");
});
export {};
