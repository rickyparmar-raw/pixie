process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const clusters = require("./gapClusters");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

test("equivalent phrasings cluster; distinct questions do not", () => {
  const groups = clusters.clusterQuestions([
    "can pcbway be used",
    "do yall allow pcbway",
    "can i order from pcb way",
    "what color is the sky",
  ]);
  assert.equal(groups.length, 2);
  const pcb = groups.find((g) => g.some((q) => q.includes("pcbway") || q.includes("pcb way")));
  assert.equal(pcb.length, 3);
});

test("clusterGaps aggregates asks, askers, and coverage per program", () => {
  db.saveProgram({ id: "gc-hwy", name: "Highway", helpChannel: "C-HWY", channels: ["C-HWY"] });
  programs.invalidate();
  for (const [q, u] of [["can pcbway be used", "U1"], ["do yall allow pcbway", "U2"], ["can i order from pcb way", "U3"], ["lonely ask", "U1"]]) {
    db.recordGap(q, u, "C-HWY", `ts-${u}-${q.length}`, "gc-hwy");
  }
  const res = clusters.clusterGaps({ programId: "gc-hwy", minAskers: 1 });
  assert.ok(!res.error);
  const pcb = res.clusters.find((c) => c.representative.includes("pcbway") || c.variants > 1);
  assert.ok(pcb, JSON.stringify(res.clusters.map((c) => c.representative)));
  assert.equal(pcb.askers, 3);
  assert.equal(pcb.askCount, 3);
  assert.equal(pcb.covered, false);

  // Another program sees none of it.
  const other = clusters.clusterGaps({ programId: "gc-elsewhere", minAskers: 1 });
  assert.equal(other.clusters.length, 0);
});

test("coverage flips once an approved fact answers the cluster", async () => {
  db.addLearnedFact({ question: "can pcbway be used", answer: "yes, allowed", status: "approved", programId: "gc-hwy" });
  const res = clusters.clusterGaps({ programId: "gc-hwy", minAskers: 1 });
  const pcb = res.clusters.find((c) => c.variants > 1);
  assert.equal(pcb.covered, true);
});

test("proposeFaq stores a candidate without AI when providers are down", async () => {
  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => {
    throw new Error("down");
  };
  try {
    const res = await clusters.proposeFaq({ programId: "gc-hwy", actorId: "U-helper", question: "can pcbway be used" });
    assert.equal(res.ok, true);
    assert.equal(res.candidate.status, "candidate");
    assert.equal(res.grounded, false);
    assert.match(res.candidate.answer, /write the approved answer/);
  } finally {
    llm.complete = real;
  }
});
