process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const route = require("./helperRoute") as typeof import("./helperRoute");
const incidents = require("./incidents") as unknown as TestIncidentApi;
const wait = require("./waitTime") as typeof import("./waitTime");
const api = require("./web/api") as typeof import("./web/api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

test("routing recommends by expertise and load, never stale members", () => {
  db.saveProgram({ id: "rt-hwy", name: "Highway", helpChannel: "C-HWY", channels: ["C-HWY"] });
  programs.invalidate();
  db.syncHelper({ programId: "rt-hwy", userId: "U-expert", source: "manual" });
  db.syncHelper({ programId: "rt-hwy", userId: "U-new", source: "manual" });
  db.syncHelper({ programId: "rt-hwy", userId: "U-gone", source: "manual" });
  db.removeHelper({ programId: "rt-hwy", userId: "U-gone" });
  route.setExpertise({ programId: "rt-hwy", userId: "U-expert", tags: ["ordering"] });
  route.recordResolution({ programId: "rt-hwy", userId: "U-expert", category: "ordering" });
  route.recordResolution({ programId: "rt-hwy", userId: "U-expert", category: "ordering" });

  const recs = route.recommend({ programId: "rt-hwy", category: "ordering" });
  assert.equal(recs[0].userId, "U-expert");
  assert.ok(recs[0].reasons.some((r) => r.includes("verified ordering")));
  assert.ok(!recs.some((r) => r.userId === "U-gone"), "removed helpers are never routed");

  for (let i = 0; i < 6; i++) {
    const id = db.createTicket({
      programId: "rt-hwy",
      workspaceId: "T1",
      channel: "C-HWY",
      threadTs: `rt-load-${i}`,
      requesterId: "U1",
      question: "q",
    });
    db.assignTicket(id, "U-expert");
  }
  const recs2 = route.recommend({ programId: "rt-hwy" });
  assert.equal(recs2[0].userId, "U-new");
});

test("duplicates rank same-program lookalikes; confirmation links canonically", () => {
  const a = db.createTicket({
    programId: "rt-hwy",
    workspaceId: "T1",
    channel: "C-HWY",
    threadTs: "rt-d1",
    requesterId: "U1",
    question: "github verification keeps failing",
  });
  const b = db.createTicket({
    programId: "rt-hwy",
    workspaceId: "T1",
    channel: "C-HWY",
    threadTs: "rt-d2",
    requesterId: "U2",
    question: "github verification fails again",
  });
  const res = incidents.suggestDuplicates({
    programId: "rt-hwy",
    ticketId: b,
    question: "github verification fails again",
  });
  assert.ok(res.candidates.some((c) => c.ticketId === a));
  assert.ok(!res.candidates.some((c) => c.ticketId === b), "never suggests itself");

  db.syncHelper({ programId: "rt-hwy", userId: "U-helper", source: "manual" });
  const confirmed = api.internalTicketAction(b, "duplicate", {
    programId: "rt-hwy",
    actorId: "U-helper",
    canonicalId: a,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(db.getTicket(b).status, "duplicate");
  assert.equal(db.getTicket(b).duplicate_of, a);
});

test("burst detection opens one candidate and dedupes within cooldown", () => {
  db.saveProgram({ id: "rt-inc", name: "Inc", helpChannel: "C-INC", channels: ["C-INC"] });
  programs.invalidate();
  for (let i = 0; i < 5; i++) {
    db.createTicket({
      programId: "rt-inc",
      workspaceId: "T1",
      channel: "C-INC",
      threadTs: `rt-inc-${i}`,
      requesterId: `U${i}`,
      question: "github verification failing right now",
    });
  }
  const first = incidents.detectBursts({ programId: "rt-inc" });
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0].deduped, false);
  const again = incidents.detectBursts({ programId: "rt-inc" });
  assert.equal(again.candidates.length, 1);
  assert.equal(again.candidates[0].deduped, true);
  assert.equal(again.candidates[0].incidentId, first.candidates[0].incidentId);

  const draft = incidents.draftAnnouncement({ incidentId: first.candidates[0].incidentId });
  assert.equal(draft.ok, true);
  assert.match(draft.draft, /Draft only/);
  assert.equal(draft.ticketCount, 5);
});

test("wait estimates use medians and admit insufficient history", () => {
  const empty = wait.estimate({ programId: "rt-empty" });
  assert.equal(empty.available, false);
  db.saveProgram({ id: "rt-wait", name: "Wait", helpChannel: "C-W", channels: ["C-W"] });
  programs.invalidate();
  const base = Date.now() - 100000;
  for (let i = 0; i < 4; i++) {
    const id = db.createTicket({
      programId: "rt-wait",
      workspaceId: "T1",
      channel: "C-W",
      threadTs: `rt-w-${i}`,
      requesterId: "U1",
      question: "q",
    });
    db.handle()
      .query("UPDATE tickets SET created_at = ?, first_human_response_at = ?, status = 'resolved' WHERE id = ?")
      .run(base + i * 1000, base + i * 1000 + (i + 1) * 60000, id);
  }
  const est = wait.estimate({ programId: "rt-wait" });
  assert.equal(est.available, true);
  assert.equal(est.sampleSize, 4);
  assert.equal(est.medianWaitMs, 180000);
});
export {};
import type { TestDb, TestIncidentApi } from "./test.types";
