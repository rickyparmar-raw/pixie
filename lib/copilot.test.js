process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const lookup = require("./lookup");
const copilot = require("./copilot");
const api = require("./web/api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
  knowledge.invalidate();
});

const BLOB = JSON.stringify([
  {
    id: "cp-hwy",
    name: "Highway",
    helpChannel: "C-HWY",
    channels: ["C-HWY"],
    sources: [{ name: "CP Highway Docs", type: "text", content: "Highway ships with tracking. PCBs from PCBWay are allowed for Highway builds." }],
  },
]);

async function withCorpus(fn) {
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  const axios = require("axios");
  const realGet = axios.get;
  process.env.PIXIE_PROGRAMS_JSON = BLOB;
  programs.invalidate();
  knowledge.invalidate();
  axios.get = async () => {
    throw new Error("network disabled in test");
  };
  try {
    await knowledge.refreshCorpus();
    return await fn();
  } finally {
    axios.get = realGet;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
}

test("factCheck marks supported claims and flags the rest", async () => {
  await withCorpus(async () => {
    const prog = programs.get("cp-hwy");
    const res = await copilot.factCheck({ program: prog, text: "PCBs from PCBWay are allowed for Highway builds. The moon is made of cheese." });
    const byVerdict = Object.fromEntries(res.verdicts.map((v) => [v.sentence.slice(0, 20), v.verdict]));
    const supported = res.verdicts.find((v) => v.verdict === "supported");
    const unsupported = res.verdicts.find((v) => v.verdict === "unsupported");
    assert.ok(supported, JSON.stringify(byVerdict));
    assert.ok(unsupported, JSON.stringify(byVerdict));
    assert.ok(supported.evidence.length > 0);
    assert.equal(res.counts.supported, 1);
    assert.equal(res.counts.unsupported, 1);
  });
});

test("findSimilar ranks resolved tickets in-program by wording overlap", () => {
  const a = db.createTicket({ programId: "cp-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: "cp-t1", requesterId: "U1", question: "pcbway pcb order allowed" });
  db.resolveTicket(a, "yes, allowed");
  const b = db.createTicket({ programId: "cp-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: "cp-t2", requesterId: "U2", question: "what color is the sky" });
  db.resolveTicket(b, "blue");
  db.syncHelper({ programId: "cp-other", userId: "U9", source: "manual" });
  const c = db.createTicket({ programId: "cp-other", workspaceId: "T1", channel: "CX", threadTs: "cp-t3", requesterId: "U3", question: "pcbway pcb order allowed" });
  db.resolveTicket(c, "other program answer");

  const res = copilot.findSimilar({ programId: "cp-hwy", question: "can I order my pcb from pcbway" });
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.candidates[0].ticketId, a);
  assert.ok(!res.candidates.some((x) => x.ticketId === c), "other programs never leak");
  assert.ok(res.candidates[0].similarity > 0);
});

test("improveReply preserves facts and surfaces token changes", async () => {
  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => ({ text: "Sure — the deadline is October 31, good luck!" });
  try {
    const res = await copilot.improveReply({ text: "deadline october 31" });
    assert.match(res.improved, /October 31/);
    assert.ok(Array.isArray(res.notes));
  } finally {
    llm.complete = real;
  }

  const down = require("./llm");
  const real2 = down.complete;
  down.complete = async () => {
    throw new Error("all providers down");
  };
  try {
    const res = await copilot.improveReply({ text: "deadline october 31" });
    assert.equal(res.improved, "deadline october 31");
    assert.match(res.notes[0], /unavailable/);
  } finally {
    down.complete = real2;
  }
});

test("draftReply reports grounding honestly and never sends", async () => {
  const real = lookup.answerOrChat;
  lookup.answerOrChat = async () => ({ source: "CP Highway Docs", answer: "Yes — allowed." });
  try {
    const res = await copilot.draftReply({ program: { id: "cp-hwy", name: "Highway" }, question: "pcbway?" });
    assert.equal(res.grounded, true);
    assert.equal(res.draft, "Yes — allowed.");
  } finally {
    lookup.answerOrChat = real;
  }
  const real2 = lookup.answerOrChat;
  lookup.answerOrChat = async () => ({ source: null, answer: null });
  try {
    const res = await copilot.draftReply({ program: { id: "cp-hwy", name: "Highway" }, question: "anything?" });
    assert.equal(res.grounded, false);
    assert.equal(res.draft, null);
  } finally {
    lookup.answerOrChat = real2;
  }
});

test("copilot API enforces program scope, actors, and budgets", async () => {
  db.saveProgram({ id: "cp-hwy", name: "Highway", helpChannel: "C-HWY", channels: ["C-HWY"] });
  programs.invalidate();
  db.syncHelper({ programId: "cp-hwy", userId: "U-helper", source: "manual" });
  assert.match((await api.internalCopilot("draft", { programId: "nope", actorId: "U-helper", question: "q" })).error, /unknown program/);
  assert.match((await api.internalCopilot("draft", { programId: "cp-hwy", actorId: "U-stranger", question: "q" })).error, /not a helper/);
  assert.match((await api.internalCopilot("bogus", { programId: "cp-hwy", actorId: "U-helper" })).error, /unknown copilot action/);
  assert.match((await api.internalCopilot("draft", { programId: "cp-hwy", actorId: "U-helper" })).error, /question required/);

  for (let i = 0; i < 25; i++) {
    copilot.checkBudget("U-flood-test");
  }
  db.syncHelper({ programId: "cp-hwy", userId: "U-flood-test", source: "manual" });
  const limited = await api.internalCopilot("ask", { programId: "cp-hwy", actorId: "U-flood-test", question: "q" });
  assert.match(limited.error, /rate limited/);
});
