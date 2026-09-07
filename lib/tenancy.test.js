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
    sources: [{ name: "TNT Highway Docs", type: "text", content: "Highway deadline is october 31. Ship by halloween." }],
  });
  db.saveProgram({
    id: "tnt-pixl",
    name: "Pixl",
    helpChannel: "C_PIXL",
    channels: ["C_PIXL"],
    sources: [{ name: "TNT Pixl Docs", type: "text", content: "Pixl deadline is august 18. Ship before school starts." }],
  });
  programs.invalidate();
}

const TNT_BLOB = JSON.stringify([
  {
    id: "tnt-hwy",
    name: "Highway",
    helpChannel: "C_HIGHWAY",
    channels: ["C_HIGHWAY"],
    sources: [{ name: "TNT Highway Docs", type: "text", content: "Highway deadline is october 31. Ship by halloween." }],
  },
  {
    id: "tnt-pixl",
    name: "Pixl",
    helpChannel: "C_PIXL",
    channels: ["C_PIXL"],
    sources: [{ name: "TNT Pixl Docs", type: "text", content: "Pixl deadline is august 18. Ship before school starts." }],
  },
]);

test("two tenants: same question resolves to different programs and knowledge", async () => {
  seedPrograms();
  // Hermetic corpus: the env blob wins over repo sources.json (which would
  // hit the network), and inline text sources need no fetching at all.
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
  assert.equal(programs.forChannel("C_PIXL", WS).id, "tnt-pixl");

  const hwyCtx = knowledge.getContext(Q, "tnt-hwy");
  const pixlCtx = knowledge.getContext(Q, "tnt-pixl");
  assert.match(hwyCtx, /october 31/i);
  assert.doesNotMatch(hwyCtx, /august 18/i);
  assert.match(pixlCtx, /august 18/i);
  assert.doesNotMatch(pixlCtx, /october 31/i);
});

test("two tenants: answer caches never bleed", () => {
  cache.put(Q, { source: "TNT Highway Docs", answer: "october 31" }, "tnt-hwy");
  assert.equal(cache.get(Q, "tnt-hwy").answer, "october 31");
  assert.equal(cache.get(Q, "tnt-pixl"), null);
  assert.equal(cache.get(Q, null), null);
});

test("two tenants: learned facts and doc gaps stay scoped", () => {
  db.addLearnedFact({ question: "hwy only", answer: "yes", status: "approved", programId: "tnt-hwy" });
  const pixlFacts = db.approvedFacts(50, "tnt-pixl").map((f) => f.question);
  assert.ok(!pixlFacts.includes("hwy only"));

  db.recordGap("tnt shared wording", "U1", "C_HIGHWAY", "t-hwy-1", "tnt-hwy");
  db.recordGap("tnt shared wording", "U2", "C_HIGHWAY", "t-hwy-2", "tnt-hwy");
  const pixlGaps = db.topGaps(20, 30 * 24 * 60 * 60 * 1000, { programId: "tnt-pixl", minAskers: 1 });
  assert.ok(!pixlGaps.some((g) => g.question.includes("tnt shared wording")));
  const hwyGaps = db.topGaps(20, 30 * 24 * 60 * 60 * 1000, { programId: "tnt-hwy", minAskers: 1 });
  assert.ok(hwyGaps.some((g) => g.question.includes("tnt shared wording")));
});

test("two tenants: tickets, helpers, notes, audit are independent; cross-write denied", () => {
  db.syncHelper({ programId: "tnt-hwy", userId: "U-hwy-helper", source: "manual" });
  db.syncHelper({ programId: "tnt-pixl", userId: "U-pixl-helper", source: "manual" });

  const hwyId = db.createTicket({ programId: "tnt-hwy", workspaceId: WS, channel: "C_HIGHWAY", threadTs: "t-hwy-9", requesterId: "U1", question: Q });
  const pixlId = db.createTicket({ programId: "tnt-pixl", workspaceId: WS, channel: "C_PIXL", threadTs: "t-pixl-9", requesterId: "U2", question: Q });

  // Cross-tenant claim denied.
  const denied = api.internalTicketAction(hwyId, "claim", { programId: "tnt-hwy", actorId: "U-pixl-helper" });
  assert.match(denied.error, /not a helper/);

  // Same-program claim works and does not touch the other ticket.
  const ok = api.internalTicketAction(hwyId, "claim", { programId: "tnt-hwy", actorId: "U-hwy-helper" });
  assert.equal(ok.ok, true);
  assert.equal(db.getTicket(pixlId).status, "open");

  // Notes are invisible across tenants.
  db.addTicketNote({ ticketId: hwyId, programId: "tnt-hwy", authorId: "U-hwy-helper", body: "hwy secret" });
  assert.equal(db.listTicketNotes(pixlId).length, 0);

  // Audit is tenant-scoped.
  const pixlAudit = db.listAuditEvents({ programId: "tnt-pixl" });
  assert.ok(!pixlAudit.some((e) => (e.metadata || "").includes("hwy secret")));

  // Independent resolve/reopen.
  db.resolveTicket(hwyId, "done");
  assert.equal(db.getTicket(pixlId).status, "open");
  db.reopenTicket(hwyId);
  assert.equal(db.getTicket(hwyId).status, "reopened");
});
