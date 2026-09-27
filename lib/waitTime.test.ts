process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const wait = require("./waitTime") as typeof import("./waitTime");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

function seedLag(programId, threadTs, createdAgoMs, lagMs, category = null) {
  const id = db.createTicket({
    programId,
    workspaceId: "T1",
    channel: `C-${programId}`,
    threadTs,
    requesterId: "U1",
    question: "q",
    category,
  });
  const created = Date.now() - createdAgoMs;
  db.handle()
    .query("UPDATE tickets SET created_at = ?, first_human_response_at = ?, status = 'resolved' WHERE id = ?")
    .run(created, created + lagMs, id);
  return id;
}

test("wait estimate admits insufficient history (no data, single ticket)", () => {
  db.saveProgram({ id: "char-wait-empty", name: "E", helpChannel: "C-E", channels: ["C-E"] });
  programs.invalidate();
  const empty = wait.estimate({ programId: "char-wait-empty" });
  assert.equal(empty.available, false);
  assert.equal(empty.reason, "insufficient history");
  assert.equal(empty.sampleSize, 0);

  db.saveProgram({ id: "char-wait-one", name: "O", helpChannel: "C-O", channels: ["C-O"] });
  programs.invalidate();
  seedLag("char-wait-one", "char-w1-0", 100000, 60000);
  const one = wait.estimate({ programId: "char-wait-one" });
  assert.equal(one.available, false);
  assert.equal(one.sampleSize, 1);

  assert.equal(wait.estimate({}).error, "programId required");
  assert.equal(wait.formatWait(one), null);
  assert.equal(wait.formatWait(null), null);
});

test("wait median is upper-median over non-negative finite lags", () => {
  assert.equal(wait.median([]), null);
  assert.equal(wait.median([300000, 60000, 180000]), 180000);
  assert.equal(wait.median([1, 2, 3, 4]), 3);

  db.saveProgram({ id: "char-wait-med", name: "M", helpChannel: "C-M", channels: ["C-M"] });
  programs.invalidate();
  const baseAgo = 100000;
  for (let i = 0; i < 4; i++) seedLag("char-wait-med", `char-wm-${i}`, baseAgo, (i + 1) * 60000);
  const est = wait.estimate({ programId: "char-wait-med" });
  assert.equal(est.available, true);
  assert.equal(est.sampleSize, 4);
  assert.equal(est.medianWaitMs, 180000);
  assert.equal(est.scope, "program");
  assert.equal(est.windowDays, 7);
});

test("wait category falls back to program below the category floor", () => {
  db.saveProgram({ id: "char-wait-cat", name: "C", helpChannel: "C-C", channels: ["C-C"] });
  programs.invalidate();
  for (let i = 0; i < 2; i++) seedLag("char-wait-cat", `char-wc-cat-${i}`, 100000, 60000, "billing");
  for (let i = 0; i < 4; i++) seedLag("char-wait-cat", `char-wc-all-${i}`, 100000, 120000);
  const fellBack = wait.estimate({ programId: "char-wait-cat", category: "billing" });
  assert.equal(fellBack.available, true);
  assert.equal(fellBack.scope, "program");
  assert.equal(fellBack.sampleSize, 6);

  db.saveProgram({ id: "char-wait-cat2", name: "C2", helpChannel: "C-C2", channels: ["C-C2"] });
  programs.invalidate();
  for (let i = 0; i < 5; i++) seedLag("char-wait-cat2", `char-wc2-cat-${i}`, 100000, 60000, "billing");
  seedLag("char-wait-cat2", "char-wc2-other", 100000, 600000);
  const scoped = wait.estimate({ programId: "char-wait-cat2", category: "billing" });
  assert.equal(scoped.scope, "category");
  assert.equal(scoped.sampleSize, 5);
  assert.equal(scoped.medianWaitMs, 60000);
});

test("wait never bleeds across programs and ignores stale/negative lags", () => {
  db.saveProgram({ id: "char-wait-iso-a", name: "A", helpChannel: "C-A", channels: ["C-A"] });
  db.saveProgram({ id: "char-wait-iso-b", name: "B", helpChannel: "C-B", channels: ["C-B"] });
  programs.invalidate();
  for (let i = 0; i < 3; i++) seedLag("char-wait-iso-a", `char-wiso-a-${i}`, 100000, 60000);
  for (let i = 0; i < 10; i++) seedLag("char-wait-iso-b", `char-wiso-b-${i}`, 100000, 3600000);
  const a = wait.estimate({ programId: "char-wait-iso-a" });
  assert.equal(a.sampleSize, 3);
  assert.equal(a.medianWaitMs, 60000);

  const stale = db.createTicket({
    programId: "char-wait-iso-a",
    workspaceId: "T1",
    channel: "C-A",
    threadTs: "char-wiso-stale",
    requesterId: "U1",
    question: "q",
  });
  db.handle()
    .query("UPDATE tickets SET created_at = ?, first_human_response_at = ?, status='resolved' WHERE id = ?")
    .run(Date.now() - 8 * 86400000, Date.now() - 8 * 86400000 + 60000, stale);
  const neg = db.createTicket({
    programId: "char-wait-iso-a",
    workspaceId: "T1",
    channel: "C-A",
    threadTs: "char-wiso-neg",
    requesterId: "U1",
    question: "q",
  });
  db.handle()
    .query("UPDATE tickets SET created_at = ?, first_human_response_at = ?, status='resolved' WHERE id = ?")
    .run(Date.now() - 50000, Date.now() - 60000, neg);
  assert.equal(wait.responseLags("char-wait-iso-a").length, 3);
});

test("wait queueAhead counts older open-family tickets in-program only", () => {
  db.saveProgram({ id: "char-wait-q", name: "Q", helpChannel: "C-Q", channels: ["C-Q"] });
  db.saveProgram({ id: "char-wait-q-other", name: "QO", helpChannel: "C-QO", channels: ["C-QO"] });
  programs.invalidate();
  const first = db.createTicket({
    programId: "char-wait-q",
    workspaceId: "T1",
    channel: "C-Q",
    threadTs: "char-wq-1",
    requesterId: "U1",
    question: "q",
  });
  const second = db.createTicket({
    programId: "char-wait-q",
    workspaceId: "T1",
    channel: "C-Q",
    threadTs: "char-wq-2",
    requesterId: "U1",
    question: "q",
  });
  db.createTicket({
    programId: "char-wait-q-other",
    workspaceId: "T1",
    channel: "C-QO",
    threadTs: "char-wq-o",
    requesterId: "U1",
    question: "q",
  });
  db.handle()
    .query("UPDATE tickets SET created_at = ? WHERE id = ?")
    .run(Date.now() - 10000, first);
  const noHist = wait.estimate({ programId: "char-wait-q", ticketId: second });
  assert.equal(noHist.available, false);
  assert.equal("queueAhead" in noHist, false);
  for (let i = 0; i < 3; i++) seedLag("char-wait-q", `char-wq-h-${i}`, 100000, 60000);
  const withHistory = wait.estimate({ programId: "char-wait-q", ticketId: second });
  assert.equal(withHistory.available, true);
  assert.equal(withHistory.queueAhead, 1);
  assert.equal(wait.estimate({ programId: "char-wait-q", ticketId: first }).queueAhead, 0);
  db.resolveTicket(first, "done");
  assert.equal(wait.estimate({ programId: "char-wait-q", ticketId: second }).queueAhead, 0);
});

test("wait formatWait labels minutes/hours, never fake precision", () => {
  assert.equal(wait.formatWait({ available: true, medianWaitMs: 10000 }), "usually under a minute");
  assert.equal(wait.formatWait({ available: true, medianWaitMs: 30000 }), "usually around 1 minute");
  assert.equal(wait.formatWait({ available: true, medianWaitMs: 60000 }), "usually around 1 minute");
  assert.equal(wait.formatWait({ available: true, medianWaitMs: 5 * 60000 }), "usually around 5 minutes");
  assert.equal(wait.formatWait({ available: true, medianWaitMs: 60 * 60000 }), "usually around 1 hour");
  assert.equal(wait.formatWait({ available: true, medianWaitMs: 3 * 60 * 60000 }), "usually around 3 hours");
});
export {};
import type { TestDb } from "./test.types";
