process.env.PIXIE_DB_PATH = ":memory:";

interface TicketOverrides {
  status?: string;
  category?: string;
  confidence?: number;
}
interface SignalRow { suppressed_until: number; type: string; program_id: string; status: string; }

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const radar = require("./radar");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

function seedProgram(id: string, extra: Record<string, unknown> = {}) {
  db.saveProgram({ id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`], ...extra });
  programs.invalidate();
}

test("upsertSignal inserts once, then updates the same row on re-detection", () => {
  seedProgram("radar-a");
  const first = radar.upsertSignal({ programId: "radar-a", type: "STALE_TICKETS", severity: "MEDIUM", title: "t1", summary: "s1", evidence: { count: 1 }, fingerprint: "backlog", now: 1000 });
  const second = radar.upsertSignal({ programId: "radar-a", type: "STALE_TICKETS", severity: "HIGH", title: "t2", summary: "s2", evidence: { count: 2 }, fingerprint: "backlog", now: 2000 });
  assert.equal(second.id, first.id);
  assert.equal(second.severity, "HIGH");
  assert.equal(second.first_detected_at, 1000);
  assert.equal(second.last_detected_at, 2000);
  assert.equal(radar.listSignals("radar-a").length, 1);
});

test("a suppressed signal stays suppressed through re-detection until it expires", () => {
  seedProgram("radar-b");
  const sig = radar.upsertSignal({ programId: "radar-b", type: "REOPEN_SPIKE", severity: "MEDIUM", title: "t", summary: "s", evidence: {}, fingerprint: "reopen", now: 1000 });
  radar.suppressSignal({ id: sig.id, actorId: "U1", duration: "1h" });
  const suppressed = radar.getSignal(sig.id) as SignalRow;
  assert.equal(suppressed.status, "suppressed");

  const stillSuppressed = radar.upsertSignal({ programId: "radar-b", type: "REOPEN_SPIKE", severity: "CRITICAL", title: "worse", summary: "s2", evidence: {}, fingerprint: "reopen", now: suppressed.suppressed_until - 1 });
  assert.equal(stillSuppressed.status, "suppressed");
  assert.equal(stillSuppressed.severity, "CRITICAL"); // evidence still updates

  const reactivated = radar.upsertSignal({ programId: "radar-b", type: "REOPEN_SPIKE", severity: "MEDIUM", title: "t3", summary: "s3", evidence: {}, fingerprint: "reopen", now: suppressed.suppressed_until + 1 });
  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.first_detected_at, suppressed.suppressed_until + 1);
});

test("acknowledgeSignal and resolveSignal are program-scoped through requireHelper", () => {
  seedProgram("radar-c1");
  seedProgram("radar-c2");
  const sig = radar.upsertSignal({ programId: "radar-c1", type: "ESCALATION_SPIKE", severity: "HIGH", title: "t", summary: "s", evidence: {}, fingerprint: "spike", now: 1000 });
  const requireHelper = (programId: string) => programId === "radar-c1";

  const denied = radar.acknowledgeSignal({ id: sig.id, actorId: "U1", requireHelper: () => false });
  assert.ok(denied.error);

  const ok = radar.acknowledgeSignal({ id: sig.id, actorId: "U1", requireHelper });
  assert.equal(ok.signal.status, "acknowledged");
  assert.equal(ok.signal.acknowledged_by, "U1");

  const resolved = radar.resolveSignal({ id: sig.id, actorId: "U1", requireHelper });
  assert.equal(resolved.signal.status, "resolved");
  assert.ok(resolved.signal.resolved_at);
});

test("evaluateProgram auto-resolves a signal whose condition cleared", () => {
  seedProgram("radar-d");
  const stale = radar.upsertSignal({ programId: "radar-d", type: "STALE_TICKETS", severity: "HIGH", title: "old", summary: "s", evidence: {}, fingerprint: "backlog", now: 1000 });
  radar.evaluateProgram("radar-d");
  const after = radar.getSignal(stale.id);
  assert.equal(after.status, "resolved");
});

test("detectStaleTickets flags open tickets past the 12h/24h thresholds with evidence", () => {
  seedProgram("radar-e");
  const now = Date.now();
  db.createTicket({ programId: "radar-e", channel: "C-radar-e", threadTs: "t1", requesterId: "U1", question: "q1" });
  const id = db.createTicket({ programId: "radar-e", channel: "C-radar-e", threadTs: "t2", requesterId: "U2", question: "q2" });
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(now - 25 * 60 * 60 * 1000, id);
  const found = radar.detectStaleTickets("radar-e", now);
  assert.ok(found);
  assert.equal(found.severity, "HIGH");
  assert.equal(found.evidence.count, 1);
  assert.deepEqual(found.evidence.sampleTicketIds, [id]);
});

test("detectStaleTickets ignores resolved/closed/duplicate/spam tickets", () => {
  seedProgram("radar-f");
  const now = Date.now();
  const id = db.createTicket({ programId: "radar-f", channel: "C-radar-f", threadTs: "t1", requesterId: "U1", question: "q1" });
  db.handle().query("UPDATE tickets SET created_at = ?, status = 'resolved' WHERE id = ?").run(now - 30 * 60 * 60 * 1000, id);
  assert.equal(radar.detectStaleTickets("radar-f", now), null);
});

test("detectEscalationSpike requires both a minimum count and a real jump over baseline", () => {
  seedProgram("radar-g");
  const now = Date.now();
  db.createTicket({ programId: "radar-g", channel: "C-radar-g", threadTs: "a", requesterId: "U1", question: "q" });
  db.createTicket({ programId: "radar-g", channel: "C-radar-g", threadTs: "b", requesterId: "U2", question: "q" });
  assert.equal(radar.detectEscalationSpike("radar-g", now), null);

  for (const t of ["c", "d", "e"]) {
    db.createTicket({ programId: "radar-g", channel: "C-radar-g", threadTs: t, requesterId: "U3", question: "q" });
  }
  const found = radar.detectEscalationSpike("radar-g", now);
  assert.ok(found);
  assert.equal(found.type, "ESCALATION_SPIKE");
});

test("detectSourceFailures reports consecutive failures with no fabricated success", () => {
  seedProgram("radar-h", { sources: [{ name: "Docs", url: "https://example.com/docs", type: "url" }] });
  db.recordSourceFailure("Docs::https://example.com/docs", "timeout");
  db.recordSourceFailure("Docs::https://example.com/docs", "timeout");
  db.recordSourceFailure("Docs::https://example.com/docs", "timeout");
  const found = radar.detectSourceFailures("radar-h");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "HIGH");
  assert.equal(found[0].evidence.failCount, 3);
  assert.equal(found[0].evidence.lastSuccessAt, null);
});

test("detectSourceFailures reports nothing once a source has since succeeded", () => {
  seedProgram("radar-i", { sources: [{ name: "Docs", url: "https://example.com/i", type: "url" }] });
  db.saveSourceText("Docs::https://example.com/i", "fresh text");
  assert.deepEqual(radar.detectSourceFailures("radar-i"), []);
});


function charTicket(programId: string, threadTs: string, ageMs: number, extra: TicketOverrides = {}) {
  const id = db.createTicket({ programId, channel: `C-${programId}`, threadTs, requesterId: "U1", question: "q" });
  const sets = ["created_at = ?"];
  const params: Array<string | number> = [Date.now() - ageMs];
  if (extra.status) { sets.push("status = ?"); params.push(extra.status); }
  if (extra.category !== undefined) { sets.push("category = ?"); params.push(extra.category); }
  if (extra.confidence !== undefined) { sets.push("ai_confidence = ?"); params.push(extra.confidence); }
  params.push(id);
  db.handle().query(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return id;
}

test("char: STALE pins the 12h warn / 24h high boundary and the 'backlog' fingerprint", () => {
  seedProgram("char-stale-fresh");
  seedProgram("char-stale-med");
  seedProgram("char-stale-high");
  const now = Date.now();
  charTicket("char-stale-fresh", "csf-1", 11 * 60 * 60 * 1000);
  assert.equal(radar.detectStaleTickets("char-stale-fresh", now), null);
  charTicket("char-stale-med", "csm-1", 13 * 60 * 60 * 1000);
  const med = radar.detectStaleTickets("char-stale-med", now);
  assert.ok(med);
  assert.equal(med.type, "STALE_TICKETS");
  assert.equal(med.severity, "MEDIUM");
  assert.equal(med.fingerprint, "backlog");
  assert.match(med.title, />12h/);
  charTicket("char-stale-high", "csh-1", 25 * 60 * 60 * 1000);
  const high = radar.detectStaleTickets("char-stale-high", now);
  assert.ok(high);
  assert.equal(high.severity, "HIGH");
  assert.equal(high.fingerprint, "backlog");
  assert.ok(high.evidence.oldestWaitMs > 24 * 60 * 60 * 1000);
});

test("char: ESCALATION pins min-3, 1h window, 6h baseline, 2x jump", () => {
  seedProgram("char-esc-fire");
  seedProgram("char-esc-base");
  const now = Date.now();
  for (const t of ["e1", "e2", "e3", "e4", "e5"]) {
    db.createTicket({ programId: "char-esc-fire", channel: "C-char-esc-fire", threadTs: t, requesterId: "U1", question: "q" });
  }
  const fired = radar.detectEscalationSpike("char-esc-fire", now);
  assert.ok(fired);
  assert.equal(fired.fingerprint, "spike");
  assert.equal(fired.evidence.windowMs, 60 * 60 * 1000);
  assert.equal(fired.severity, "CRITICAL");
  for (let i = 0; i < 30; i++) charTicket("char-esc-base", `cb-old-${i}`, 2 * 60 * 60 * 1000);
  for (const t of ["cb-n1", "cb-n2", "cb-n3"]) {
    db.createTicket({ programId: "char-esc-base", channel: "C-char-esc-base", threadTs: t, requesterId: "U1", question: "q" });
  }
  assert.equal(radar.detectEscalationSpike("char-esc-base", now), null);
});

test("char: FAQ pins 24h window, min-5 askers, sha1 fingerprint", () => {
  const crypto = require("crypto");
  seedProgram("char-faq-fire");
  seedProgram("char-faq-few");
  const q = "char how do reimbursements work";
  for (let i = 1; i <= 5; i++) db.recordGap(q, `U${i}`, "C-char-faq-fire", `char-faq-ts-${i}`, "char-faq-fire");
  const found = radar.detectFaqClusters("char-faq-fire");
  assert.equal(found.length, 1);
  assert.equal(found[0].type, "FAQ_CLUSTER");
  assert.equal(found[0].severity, "MEDIUM"); // 5 askers < 15 HIGH bar
  const expected = crypto.createHash("sha1").update(q.toLowerCase()).digest("hex").slice(0, 16);
  assert.equal(found[0].fingerprint, expected);
  for (let i = 1; i <= 4; i++) db.recordGap(q, `U${i}`, "C-char-faq-few", `char-few-ts-${i}`, "char-faq-few");
  assert.deepEqual(radar.detectFaqClusters("char-faq-few"), []);
});

test("char: LOW_CONF pins 7d window, n>=5, mean<0.5, HIGH below 0.3", () => {
  seedProgram("char-lc-high");
  seedProgram("char-lc-med");
  seedProgram("char-lc-few");
  seedProgram("char-lc-ok");
  for (let i = 0; i < 5; i++) charTicket("char-lc-high", `lch-${i}`, 1000, { category: "billing", confidence: 0.2 });
  for (let i = 0; i < 5; i++) charTicket("char-lc-med", `lcm-${i}`, 1000, { category: "billing", confidence: 0.4 });
  for (let i = 0; i < 4; i++) charTicket("char-lc-few", `lcf-${i}`, 1000, { category: "billing", confidence: 0.1 });
  for (let i = 0; i < 5; i++) charTicket("char-lc-ok", `lco-${i}`, 1000, { category: "billing", confidence: 0.9 });
  const high = radar.detectLowConfidenceTopics("char-lc-high", Date.now());
  assert.equal(high.length, 1);
  assert.equal(high[0].severity, "HIGH");
  assert.equal(high[0].fingerprint, "billing");
  const med = radar.detectLowConfidenceTopics("char-lc-med", Date.now());
  assert.equal(med.length, 1);
  assert.equal(med[0].severity, "MEDIUM");
  assert.deepEqual(radar.detectLowConfidenceTopics("char-lc-few", Date.now()), []);
  assert.deepEqual(radar.detectLowConfidenceTopics("char-lc-ok", Date.now()), []);
});

test("char: REOPEN pins n>=3, rate>=0.2, HIGH at 0.4, 'reopen' fingerprint", () => {
  seedProgram("char-re-low");
  seedProgram("char-re-high");
  seedProgram("char-re-rate");
  const idsLow = [];
  for (let i = 0; i < 5; i++) idsLow.push(db.createTicket({ programId: "char-re-low", channel: "C-char-re-low", threadTs: `rl-${i}`, requesterId: "U1", question: "q" }));
  db.reopenTicket(idsLow[0]); db.reopenTicket(idsLow[1]);
  assert.equal(radar.detectReopenSpike("char-re-low", Date.now()), null);
  const idsHigh = [];
  for (let i = 0; i < 5; i++) idsHigh.push(db.createTicket({ programId: "char-re-high", channel: "C-char-re-high", threadTs: `rh-${i}`, requesterId: "U1", question: "q" }));
  for (let i = 0; i < 3; i++) db.reopenTicket(idsHigh[i]);
  const high = radar.detectReopenSpike("char-re-high", Date.now());
  assert.ok(high);
  assert.equal(high.severity, "HIGH"); // 3/5 = 0.6 >= 0.4
  assert.equal(high.fingerprint, "reopen");
  assert.equal(high.evidence.rate, 0.6);
  const idsRate = [];
  for (let i = 0; i < 20; i++) idsRate.push(db.createTicket({ programId: "char-re-rate", channel: "C-char-re-rate", threadTs: `rr-${i}`, requesterId: "U1", question: "q" }));
  for (let i = 0; i < 3; i++) db.reopenTicket(idsRate[i]);
  assert.equal(radar.detectReopenSpike("char-re-rate", Date.now()), null); // 3/20 = 0.15 < 0.2
});

test("char: fingerprints dedup by (program,type,fingerprint) only", () => {
  seedProgram("char-dd-a");
  seedProgram("char-dd-b");
  const a1 = radar.upsertSignal({ programId: "char-dd-a", type: "STALE_TICKETS", severity: "MEDIUM", title: "t", summary: "s", evidence: {}, fingerprint: "backlog", now: 1000 });
  const a2 = radar.upsertSignal({ programId: "char-dd-a", type: "STALE_TICKETS", severity: "MEDIUM", title: "t", summary: "s", evidence: {}, fingerprint: "backlog", now: 2000 });
  assert.equal(a2.id, a1.id);
  const b = radar.upsertSignal({ programId: "char-dd-b", type: "STALE_TICKETS", severity: "MEDIUM", title: "t", summary: "s", evidence: {}, fingerprint: "backlog", now: 1000 });
  assert.notEqual(b.id, a1.id); // same fingerprint, other program -> separate row
  const otherType = radar.upsertSignal({ programId: "char-dd-a", type: "REOPEN_SPIKE", severity: "MEDIUM", title: "t", summary: "s", evidence: {}, fingerprint: "backlog", now: 1000 });
  assert.notEqual(otherType.id, a1.id); // same program+fingerprint, other type -> separate row
});

test("char: acknowledged re-fire stays acknowledged; resolved re-fires fresh", () => {
  seedProgram("char-life");
  const sig = radar.upsertSignal({ programId: "char-life", type: "STALE_TICKETS", severity: "MEDIUM", title: "t", summary: "s", evidence: {}, fingerprint: "backlog", now: 1000 });
  radar.acknowledgeSignal({ id: sig.id, actorId: "U1" });
  const refired = radar.upsertSignal({ programId: "char-life", type: "STALE_TICKETS", severity: "HIGH", title: "t2", summary: "s2", evidence: {}, fingerprint: "backlog", now: 2000 });
  assert.equal(refired.status, "acknowledged");
  assert.equal(refired.first_detected_at, 1000);
  radar.resolveSignal({ id: sig.id, actorId: "U1" });
  const fresh = radar.upsertSignal({ programId: "char-life", type: "STALE_TICKETS", severity: "MEDIUM", title: "t3", summary: "s3", evidence: {}, fingerprint: "backlog", now: 3000 });
  assert.equal(fresh.status, "active");
  assert.equal(fresh.first_detected_at, 3000);
  assert.equal(fresh.resolved_at, null);
});

test("char: suppress rejects unknown durations; evaluate auto-resolves active+acknowledged but never suppressed", () => {
  seedProgram("char-auto");
  const active = radar.upsertSignal({ programId: "char-auto", type: "STALE_TICKETS", severity: "HIGH", title: "t", summary: "s", evidence: {}, fingerprint: "backlog", now: 1000 });
  const acked = radar.upsertSignal({ programId: "char-auto", type: "ESCALATION_SPIKE", severity: "HIGH", title: "t", summary: "s", evidence: {}, fingerprint: "spike", now: 1000 });
  radar.acknowledgeSignal({ id: acked.id, actorId: "U1" });
  const supp = radar.upsertSignal({ programId: "char-auto", type: "REOPEN_SPIKE", severity: "MEDIUM", title: "t", summary: "s", evidence: {}, fingerprint: "reopen", now: 1000 });
  assert.ok(radar.suppressSignal({ id: supp.id, actorId: "U1", duration: "bogus" }).error);
  radar.suppressSignal({ id: supp.id, actorId: "U1", duration: "24h" });
  radar.evaluateProgram("char-auto");
  assert.equal(radar.getSignal(active.id).status, "resolved");
  assert.equal(radar.getSignal(acked.id).status, "resolved");
  assert.equal(radar.getSignal(supp.id).status, "suppressed");
});

test("char: evaluateProgram is program-scoped — no cross-program leakage", () => {
  seedProgram("char-leak-a");
  seedProgram("char-leak-b");
  charTicket("char-leak-a", "leak-1", 25 * 60 * 60 * 1000);
  const resB = radar.evaluateProgram("char-leak-b");
  assert.deepEqual(resB.signals, []);
  assert.deepEqual(radar.listSignals("char-leak-b"), []);
  const resA = radar.evaluateProgram("char-leak-a");
  assert.ok(resA.signals.some((s: SignalRow) => s.type === "STALE_TICKETS" && s.program_id === "char-leak-a"));
  assert.deepEqual(radar.listSignals("char-leak-b"), []);
});

test("char: KNOWLEDGE_GAP is a listed type no detector emits", () => {
  assert.ok(radar.TYPES.includes("KNOWLEDGE_GAP"));
  seedProgram("char-kg");
  const { signals } = radar.evaluateProgram("char-kg");
  assert.ok(!signals.some((s: SignalRow) => s.type === "KNOWLEDGE_GAP"));
});

test("char: startRadarLoop guards non-positive intervals", () => {
  assert.equal(radar.startRadarLoop(0), null);
  assert.equal(radar.startRadarLoop(-1), null);
  const timer = radar.startRadarLoop(100000);
  assert.ok(timer);
  clearInterval(timer);
});
export {};
