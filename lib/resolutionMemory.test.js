process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const memory = require("./resolutionMemory");
const api = require("./web/api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
  knowledge.invalidate();
});

function seedProgram() {
  db.saveProgram({ id: "rm-hwy", name: "Highway", helpChannel: "C-HWY", channels: ["C-HWY"] });
  programs.invalidate();
  db.syncHelper({ programId: "rm-hwy", userId: "U-helper", source: "manual" });
}

function resolvedTicket() {
  const id = db.createTicket({ programId: "rm-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: `rm-t-${Date.now()}-${Math.random()}`, requesterId: "U1", question: "pcb order stuck" });
  db.resolveTicket(id, "reorder from the approved vendor list");
  return db.getTicket(id);
}

test("unresolved tickets yield no candidates; resolved ones do (deduped)", async () => {
  seedProgram();
  const open = db.createTicket({ programId: "rm-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: "rm-open", requesterId: "U1", question: "q" });
  const refused = await memory.proposeFromTicket({ ticketId: open, actorId: "U-helper" });
  assert.match(refused.error, /only resolved/);

  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => ({ text: '{"problem": "pcb order stuck", "cause": "wrong vendor", "solution": "reorder approved", "category": "ordering"}' });
  try {
    const first = await memory.proposeFromTicket({ ticketId: resolvedTicket().id, actorId: "U-helper" });
    assert.equal(first.ok, true);
    assert.equal(first.candidate.status, "candidate");
    assert.equal(first.aiExtracted, true);
    const again = await memory.proposeFromTicket({ ticketId: first.candidate.ticket_id, actorId: "U-helper" });
    assert.equal(again.duplicate, true);
  } finally {
    llm.complete = real;
  }
});

test("extraction failure still yields a reviewable candidate, never nothing", async () => {
  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => {
    throw new Error("all providers down");
  };
  try {
    const res = await memory.proposeFromTicket({ ticketId: resolvedTicket().id, actorId: "U-helper" });
    assert.equal(res.ok, true);
    assert.equal(res.aiExtracted, false);
    assert.ok(res.candidate.question);
  } finally {
    llm.complete = real;
  }
});

test("approval enters the corpus with verification; rejection excludes", async () => {
  const id = db.createTicket({ programId: "rm-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: "rm-appr", requesterId: "U1", question: "unique rm question" });
  db.resolveTicket(id, "unique rm resolution");
  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => ({ text: "not json at all" });
  let candidate;
  try {
    const res = await memory.proposeFromTicket({ ticketId: id, actorId: "U-helper" });
    candidate = res.candidate;
  } finally {
    llm.complete = real;
  }
  const approved = memory.approveCandidate({ id: candidate.id, actorId: "U-helper", edits: { category: "ordering" } });
  assert.equal(approved.ok, true);
  assert.equal(approved.fact.status, "approved");
  assert.ok(approved.fact.verified_at);
  const facts = db.approvedFacts(200, "rm-hwy").map((f) => f.question);
  assert.ok(facts.includes(candidate.question));

  const id2 = db.createTicket({ programId: "rm-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: "rm-rej", requesterId: "U1", question: "bad idea" });
  db.resolveTicket(id2, "do the bad thing");
  const prop = await memory.proposeFromTicket({ ticketId: id2, actorId: "U-helper" });
  const rej = memory.rejectCandidate({ id: prop.candidate.id, actorId: "U-helper" });
  assert.equal(rej.ok, true);
  const factsAfter = db.approvedFacts(200, "rm-hwy").map((f) => f.question);
  assert.ok(!factsAfter.includes("bad idea"));
});

test("candidate API is tenant- and actor-gated", async () => {
  const stranger = await api.internalKnowledgePropose("rm-hwy", { actorId: "U-stranger", ticketId: 1 });
  assert.match(stranger.error, /not a helper/);
  const wrongProgram = await api.internalKnowledgePropose("rm-hwy", { actorId: "U-helper", ticketId: 999999 });
  assert.match(wrongProgram.error, /not found in this program/);
  const listed = api.internalKnowledgeCandidates("rm-hwy");
  assert.ok(Array.isArray(listed));
});
