process.env.PIXIE_DB_PATH = ":memory:";

type TestRow = Record<string, any>;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const health = require("./programHealth");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

function seedProgram(id: string, extra: TestRow = {}) {
  db.saveProgram({ id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`], ...extra });
  programs.invalidate();
}

test("reports 'not enough data' instead of a fake score for a quiet program", () => {
  seedProgram("health-a");
  const res = health.computeHealthScore("health-a");
  assert.equal(res.score, null);
  assert.equal(res.label, "Not enough data");
  assert.equal(res.components, null);
});

test("computes a versioned score with all four components once there's enough volume", () => {
  seedProgram("health-b");
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const id = db.createTicket({ programId: "health-b", channel: "C-health-b", threadTs: `t${i}`, requesterId: `U${i}`, question: "q" });
    db.resolveTicket(id, `U${i}`, "fixed");
  }
  const res = health.computeHealthScore("health-b");
  assert.equal(res.version, health.SCORE_VERSION);
  assert.ok(typeof res.score === "number" && res.score >= 0 && res.score <= 100);
  assert.ok(typeof res.components.ticketBacklog === "number");
  assert.ok(typeof res.components.sourceHealth === "number");
  assert.ok(typeof res.components.knowledgeCoverage === "number");
  assert.ok(typeof res.components.resolutionQuality === "number");
});

test("a failing configured source drags sourceHealth down but never below zero", () => {
  seedProgram("health-c", { sources: [{ name: "Docs", url: "https://example.com/hc", type: "url" }] });
  for (let i = 0; i < 6; i++) db.createTicket({ programId: "health-c", channel: "C-health-c", threadTs: `t${i}`, requesterId: `U${i}`, question: "q" });
  for (let i = 0; i < 10; i++) db.recordSourceFailure("Docs::https://example.com/hc", "down");
  const res = health.computeHealthScore("health-c");
  assert.equal(res.components.sourceHealth, 0);
});

test("reopened tickets pull resolutionQuality down more than a plain escalation", () => {
  seedProgram("health-d");
  for (let i = 0; i < 5; i++) {
    const id = db.createTicket({ programId: "health-d", channel: "C-health-d", threadTs: `t${i}`, requesterId: `U${i}`, question: "q" });
    db.resolveTicket(id, `U${i}`, "fixed");
  }
  const clean = health.computeHealthScore("health-d");

  seedProgram("health-e");
  for (let i = 0; i < 5; i++) {
    const id = db.createTicket({ programId: "health-e", channel: "C-health-e", threadTs: `t${i}`, requesterId: `U${i}`, question: "q" });
    db.resolveTicket(id, `U${i}`, "fixed");
    db.reopenTicket(id, `U${i}`);
  }
  const reopened = health.computeHealthScore("health-e");
  assert.ok(reopened.components.resolutionQuality < clean.components.resolutionQuality);
});
export {};
