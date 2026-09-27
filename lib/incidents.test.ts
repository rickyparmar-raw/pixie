// @ts-nocheck
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const incidents = require("./incidents");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

function makeCandidate(programId, title) {
  const res = db.handle().query(
    "INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'candidate', ?, ?)",
  ).run(programId, title, Date.now(), Date.now());
  return Number(res.lastInsertRowid);
}

test("declareIncident moves a candidate to confirmed with description, declared_by, and public_message, and it's audited", () => {
  db.saveProgram({ id: "dec-a", name: "DecA" });
  programs.invalidate();
  const id = makeCandidate("dec-a", "checkout failing");

  const res = incidents.declareIncident({ incidentId: id, actorId: "U-organizer", description: "Stripe webhook outage", publicMessage: "We know checkout is down and are working on it." });
  assert.equal(res.ok, true);
  assert.equal(res.incident.status, "confirmed");
  assert.equal(res.incident.description, "Stripe webhook outage");
  assert.equal(res.incident.declared_by, "U-organizer");
  assert.ok(res.incident.confirmed_at);

  const audits = db.listAuditEvents({ programId: "dec-a" });
  assert.ok(audits.some((a) => a.action === "incident.declared"));
});

test("matchActiveIncident only considers confirmed incidents, never candidates or resolved ones", () => {
  db.saveProgram({ id: "dec-b", name: "DecB" });
  programs.invalidate();
  const candidateId = makeCandidate("dec-b", "login is broken for everyone");
  assert.equal(incidents.matchActiveIncident({ programId: "dec-b", question: "login broken for me too" }), null);

  incidents.declareIncident({ incidentId: candidateId, actorId: "U1" });
  const matched = incidents.matchActiveIncident({ programId: "dec-b", question: "login broken for me too" });
  assert.equal(matched.id, candidateId);

  incidents.setIncidentStatus({ incidentId: candidateId, status: "resolved", actorId: "U1" });
  assert.equal(incidents.matchActiveIncident({ programId: "dec-b", question: "login broken for me too" }), null);
});

test("manual incidents are confirmed immediately and outage paraphrases match without matching unrelated questions", () => {
  db.saveProgram({ id: "dec-manual", name: "Manual" });
  programs.invalidate();
  const created = incidents.createIncident({
    programId: "dec-manual",
    title: "Pixl site is currently down",
    description: "People cannot access the website",
    publicMessage: "Heads up — the Pixl site is currently down; the team is on it.",
    actorId: "U-organizer",
  });
  assert.equal(created.ok, true);
  assert.equal(created.incident.status, "confirmed");
  assert.equal(created.incident.declared_by, "U-organizer");
  assert.ok(incidents.matchActiveIncident({ programId: "dec-manual", question: "is the site down?" }));
  assert.ok(incidents.matchActiveIncident({ programId: "dec-manual", question: "pixl won't load" }));
  assert.ok(incidents.matchActiveIncident({ programId: "dec-manual", question: "cant open the website" }));
  assert.equal(incidents.matchActiveIncident({ programId: "dec-manual", question: "when does review finish?" }), null);
});

test("notifyAffectedUsers is idempotent and retry-safe: only unnotified reports are messaged, failures don't block the rest", async () => {
  db.saveProgram({ id: "dec-c", name: "DecC" });
  programs.invalidate();
  const id = makeCandidate("dec-c", "payouts delayed");
  incidents.declareIncident({ incidentId: id, actorId: "U1" });
  incidents.recordAffectedReport({ incidentId: id, programId: "dec-c", requesterId: "U-a", channel: "C1", threadTs: "t1" });
  incidents.recordAffectedReport({ incidentId: id, programId: "dec-c", requesterId: "U-b", channel: "C1", threadTs: "t2" });

  const sent = [];
  const flakyClient = {
    chat: {
      postMessage: async (payload) => {
        if (payload.thread_ts === "t2") throw Object.assign(new Error("channel_not_found"), { code: "channel_not_found" });
        sent.push(payload);
        return { ts: "9.0" };
      },
    },
  };

  const res = await incidents.notifyAffectedUsers({ incidentId: id, actorId: "U1", client: flakyClient });
  assert.equal(res.notified, 1);
  assert.equal(res.failed, 1);
  assert.equal(sent.length, 1);

  const reports = incidents.affectedReports(id);
  const t1 = reports.find((r) => r.thread_ts === "t1");
  const t2 = reports.find((r) => r.thread_ts === "t2");
  assert.ok(t1.notified_at);
  assert.equal(t2.notified_at, null);

  // Re-running only reaches the still-pending report — t1 is never messaged twice.
  const workingClient = { chat: { postMessage: async (payload) => { sent.push(payload); return { ts: "9.1" }; } } };
  const retry = await incidents.notifyAffectedUsers({ incidentId: id, actorId: "U1", client: workingClient });
  assert.equal(retry.notified, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].thread_ts, "t2");
});

test("notifyAffectedUsers never touches another program's reports", async () => {
  db.saveProgram({ id: "dec-d1", name: "D1" });
  db.saveProgram({ id: "dec-d2", name: "D2" });
  programs.invalidate();
  const id1 = makeCandidate("dec-d1", "outage one");
  const id2 = makeCandidate("dec-d2", "outage two");
  incidents.declareIncident({ incidentId: id1, actorId: "U1" });
  incidents.declareIncident({ incidentId: id2, actorId: "U1" });
  incidents.recordAffectedReport({ incidentId: id1, programId: "dec-d1", requesterId: "U-a", channel: "C1", threadTs: "t1" });
  incidents.recordAffectedReport({ incidentId: id2, programId: "dec-d2", requesterId: "U-b", channel: "C2", threadTs: "t2" });

  const client = { chat: { postMessage: async () => ({ ts: "1.0" }) } };
  await incidents.notifyAffectedUsers({ incidentId: id1, actorId: "U1", client });

  assert.ok(incidents.affectedReports(id1)[0].notified_at);
  assert.equal(incidents.affectedReports(id2)[0].notified_at, null);
});

// WHY: similarity is the rounded pairOverlap, gated at 0.35 — pins the exact
// scoring contract suggestDuplicates, detectBursts and matchActiveIncident share.
test("char: suggestDuplicates reports exact rounded overlap, filters <0.35, excludes self, sorts desc", () => {
  const gapClusters = require("./gapClusters");
  const prog = "char-sug-exact";
  db.saveProgram({ id: prog, name: "SugExact" });
  const q = "checkout keeps failing for me too";
  const closeId = db.createTicket({ programId: prog, channel: "C-sug", threadTs: "char-sug-t1", requesterId: "U1", question: "checkout is failing for everyone" });
  const exactId = db.createTicket({ programId: prog, channel: "C-sug", threadTs: "char-sug-t2", requesterId: "U2", question: "checkout keeps failing for me too" });
  db.createTicket({ programId: prog, channel: "C-sug", threadTs: "char-sug-t3", requesterId: "U3", question: "how do i water my garden plants today" });

  const res = incidents.suggestDuplicates({ programId: prog, question: q });
  assert.ok(res.candidates.length >= 2);
  // Exact rounding contract.
  for (const c of res.candidates) {
    const expected = Number(gapClusters.pairOverlap(q, c.question).toFixed(3));
    assert.equal(c.similarity, expected);
    assert.ok(c.similarity >= 0.35);
  }
  // Sorted best-first: the identical question (1.0) outranks the partial one.
  assert.equal(res.candidates[0].ticketId, exactId);
  assert.ok(res.candidates[0].similarity >= res.candidates[1].similarity);

  // Self-exclusion: asking from exactId's own ticket hides that row.
  const withoutSelf = incidents.suggestDuplicates({ programId: prog, ticketId: exactId, question: q });
  assert.ok(withoutSelf.candidates.every((c) => c.ticketId !== exactId));
  assert.ok(withoutSelf.candidates.some((c) => c.ticketId === closeId));

  // Required-args contract.
  assert.equal(incidents.suggestDuplicates({ question: q }).error, "programId and question required");
  assert.equal(incidents.suggestDuplicates({ programId: prog }).error, "programId and question required");
});

// WHY: duplicates are same-program and same-30d only — cross-program wording
// matches and stale tickets must never surface.
test("char: suggestDuplicates is program-scoped and drops tickets older than 30d", () => {
  const prog = "char-sug-scope";
  const other = "char-sug-other";
  db.saveProgram({ id: prog, name: "Scope" });
  db.saveProgram({ id: other, name: "Other" });
  const question = "checkout is failing for everyone";
  db.createTicket({ programId: other, channel: "C-sug", threadTs: "char-scope-other-1", requesterId: "U1", question });
  const oldId = db.createTicket({ programId: prog, channel: "C-sug", threadTs: "char-scope-old-1", requesterId: "U1", question });
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(Date.now() - 31 * 24 * 60 * 60 * 1000, oldId);
  const freshId = db.createTicket({ programId: prog, channel: "C-sug", threadTs: "char-scope-fresh-1", requesterId: "U1", question });

  const res = incidents.suggestDuplicates({ programId: prog, question });
  const ids = res.candidates.map((c) => c.ticketId);
  assert.ok(ids.includes(freshId));
  assert.ok(!ids.includes(oldId));
  // The other program's identical ticket is invisible here; it is visible there.
  const otherRes = incidents.suggestDuplicates({ programId: other, question });
  assert.ok(otherRes.candidates.length >= 1);
  assert.ok(!ids.some((id) => otherRes.candidates.some((c) => c.ticketId === id && c.ticketId !== freshId)));
});

// WHY: closed/spam/duplicate tickets are not "similar open work" — duplicates
// must not suggest corpses.
test("char: suggestDuplicates never suggests closed tickets", () => {
  const prog = "char-sug-closed";
  db.saveProgram({ id: prog, name: "Closed" });
  const question = "payouts delayed for everyone today";
  const closedId = db.createTicket({ programId: prog, channel: "C-sug", threadTs: "char-closed-1", requesterId: "U1", question });
  db.handle().query("UPDATE tickets SET status = 'closed' WHERE id = ?").run(closedId);
  const res = incidents.suggestDuplicates({ programId: prog, question });
  assert.ok(res.candidates.every((c) => c.ticketId !== closedId));
});

// WHY: threshold=4 in a 1h window is the burst definition — fewer than 4
// similar tickets is noise, 4 is a candidate with the exact reason/confidence shape.
test("char: detectBursts needs 4 similar tickets in window; candidate shape is exact", () => {
  const prog = "char-burst-threshold";
  db.saveProgram({ id: prog, name: "BurstT" });
  const q = "checkout is failing for everyone right now";
  for (let i = 0; i < 3; i++) {
    db.createTicket({ programId: prog, channel: "C-b", threadTs: `char-bt-${i}`, requesterId: "U1", question: q });
  }
  assert.deepEqual(incidents.detectBursts({ programId: prog }).candidates, []);
  assert.equal(incidents.detectBursts({}).error, "programId required");

  db.createTicket({ programId: prog, channel: "C-b", threadTs: "char-bt-3", requesterId: "U1", question: q });
  const out = incidents.detectBursts({ programId: prog });
  assert.equal(out.candidates.length, 1);
  const c = out.candidates[0];
  assert.equal(c.status, "candidate");
  assert.equal(c.deduped, false);
  assert.equal(c.linked, 4);
  assert.equal(c.title, q.slice(0, 200));
  const stored = incidents.getIncident(c.incidentId);
  assert.equal(stored.status, "candidate");
  assert.equal(stored.reason, "4 similar tickets in 60m");
  assert.equal(stored.confidence, 0.7);
  assert.equal(incidents.incidentTickets(c.incidentId).length, 4);
});

// WHY: custom threshold/window params are honored — callers (and tests) can
// shrink the burst definition without touching globals.
test("char: detectBursts honors explicit threshold and windowMs", () => {
  const prog = "char-burst-params";
  db.saveProgram({ id: prog, name: "BurstP" });
  const q = "alpha beta gamma delta epsilon zeta";
  for (let i = 0; i < 2; i++) {
    db.createTicket({ programId: prog, channel: "C-b", threadTs: `char-bp-${i}`, requesterId: "U1", question: q });
  }
  const out = incidents.detectBursts({ programId: prog, threshold: 2 });
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].linked, 2);
  assert.equal(incidents.getIncident(out.candidates[0].incidentId).reason, "2 similar tickets in 60m");
});

// WHY: the 1h window is a recency gate — yesterday's outage must not re-fire
// today's burst detector.
test("char: detectBursts ignores tickets older than the window", () => {
  const prog = "char-burst-window";
  db.saveProgram({ id: prog, name: "BurstW" });
  const q = "login is broken for everyone right now";
  for (let i = 0; i < 4; i++) {
    const id = db.createTicket({ programId: prog, channel: "C-b", threadTs: `char-bw-${i}`, requesterId: "U1", question: q });
    db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 60 * 60 * 1000, id);
  }
  assert.deepEqual(incidents.detectBursts({ programId: prog }).candidates, []);
});

// WHY: the 6h cooldown links into the live candidate instead of spawning a
// second incident for the same burst — one outage, one incident.
test("char: detectBursts cooldown links into the live incident instead of opening a second", () => {
  const prog = "char-burst-cooldown";
  db.saveProgram({ id: prog, name: "BurstC" });
  const q = "payouts delayed for everyone right now";
  for (let i = 0; i < 4; i++) {
    db.createTicket({ programId: prog, channel: "C-b", threadTs: `char-bc-${i}`, requesterId: "U1", question: q });
  }
  const first = incidents.detectBursts({ programId: prog });
  assert.equal(first.candidates.length, 1);
  assert.equal(first.candidates[0].deduped, false);
  const second = incidents.detectBursts({ programId: prog });
  assert.equal(second.candidates.length, 1);
  assert.equal(second.candidates[0].incidentId, first.candidates[0].incidentId);
  assert.equal(second.candidates[0].deduped, true);
  assert.equal(second.candidates[0].linked, 0);
  assert.equal(incidents.listIncidents(prog).length, 1);
});

// WHY: bursts never cross programs — identical wording in another tenant is a
// different outage until a human says otherwise.
test("char: detectBursts is program-isolated", () => {
  const progA = "char-burst-iso-a";
  const progB = "char-burst-iso-b";
  db.saveProgram({ id: progA, name: "IsoA" });
  db.saveProgram({ id: progB, name: "IsoB" });
  const q = "isolated burst wording checkout failing now";
  for (let i = 0; i < 4; i++) {
    db.createTicket({ programId: progA, channel: "C-b", threadTs: `char-iso-a-${i}`, requesterId: "U1", question: q });
  }
  db.createTicket({ programId: progB, channel: "C-b", threadTs: "char-iso-b-0", requesterId: "U1", question: q });
  const outA = incidents.detectBursts({ programId: progA });
  assert.equal(outA.candidates.length, 1);
  assert.deepEqual(incidents.detectBursts({ programId: progB }).candidates, []);
  assert.equal(incidents.listIncidents(progB).length, 0);
});

// WHY: the full lifecycle is candidate→confirmed→resolved/dismissed with one
// audit row per step — pins error strings callers match on.
test("char: lifecycle transitions, error shapes, link/unlink, and audit writes", () => {
  const prog = "char-lifecycle";
  db.saveProgram({ id: prog, name: "Life" });
  assert.equal(incidents.getIncident(999999999), null);
  assert.equal(incidents.declareIncident({ incidentId: 999999999 }).error, "incident not found");
  assert.equal(incidents.setIncidentStatus({ incidentId: 999999999, status: "confirmed" }).error, "incident not found");
  assert.equal(incidents.draftAnnouncement({ incidentId: 999999999 }).error, "incident not found");
  assert.equal(incidents.linkTicket({ incidentId: 999999999, ticketId: 999999999 }).error, "incident or ticket not found");

  const id = makeCandidate(prog, "lifecycle outage title");
  assert.equal(incidents.setIncidentStatus({ incidentId: id, status: "bogus" }).error, "invalid status");

  const baseAudit = db.listAuditEvents({ programId: prog }).length;
  const declared = incidents.declareIncident({ incidentId: id, actorId: "U-org", description: "d", publicMessage: "pm" });
  assert.equal(declared.ok, true);
  assert.equal(declared.incident.status, "confirmed");
  assert.ok(declared.incident.confirmed_at);

  const resolved = incidents.setIncidentStatus({ incidentId: id, status: "resolved", actorId: "U-org" });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.incident.status, "resolved");
  assert.ok(resolved.incident.resolved_at);
  const audits = db.listAuditEvents({ programId: prog });
  assert.ok(audits.some((a) => a.action === "incident.declared"));
  assert.ok(audits.some((a) => a.action === "incident.resolved"));
  assert.ok(audits.length >= baseAudit + 2);

  // Link guards program scope; unlink removes; draft counts linked tickets.
  const ticketId = db.createTicket({ programId: prog, channel: "C-l", threadTs: "char-life-t1", requesterId: "U1", question: "lifecycle outage title" });
  db.saveProgram({ id: "char-life-other", name: "Other" });
  const otherId = makeCandidate("char-life-other", "lifecycle outage title");
  assert.equal(incidents.linkTicket({ incidentId: otherId, ticketId }).error, "program mismatch");
  assert.equal(incidents.linkTicket({ incidentId: id, ticketId }).ok, true);
  assert.equal(incidents.incidentTickets(id).length, 1);
  assert.equal(incidents.draftAnnouncement({ incidentId: id }).ticketCount, 1);
  assert.match(incidents.draftAnnouncement({ incidentId: id }).draft, /1 similar report[^s]/);
  assert.equal(incidents.unlinkTicket({ incidentId: id, ticketId }).ok, true);
  assert.equal(incidents.incidentTickets(id).length, 0);

  // Status-filtered listing is exact; dismissed is terminal and listed.
  incidents.setIncidentStatus({ incidentId: id, status: "dismissed", actorId: "U-org" });
  assert.equal(incidents.listIncidents(prog, "resolved").length, 0);
  assert.equal(incidents.listIncidents(prog, "dismissed").length, 1);
  assert.equal(incidents.listIncidents("char-life-other").length, 1);
});

// WHY: 0.35 is the shared "same incident" line — 1/3 overlap (0.333) misses,
// 2/3 (0.667) hits, best overlap wins, and other programs never match.
test("char: matchActiveIncident honors the 0.35 boundary, best-match, and program scope", () => {
  const prog = "char-match-bound";
  db.saveProgram({ id: prog, name: "Match" });
  const id = makeCandidate(prog, "alpha beta outage");
  incidents.declareIncident({ incidentId: id, actorId: "U1" });
  assert.equal(incidents.matchActiveIncident({ programId: prog, question: "delta offline" }), null);
  assert.equal(incidents.matchActiveIncident({ programId: prog, question: "alpha beta outage" }).id, id);
  // Missing args never throw, never match.
  assert.equal(incidents.matchActiveIncident({ question: "alpha beta delta" }), null);
  assert.equal(incidents.matchActiveIncident({ programId: prog }), null);
  assert.equal(incidents.matchActiveIncident({ programId: prog, question: "" }), null);
  // Best-match: exact title beats partial title.
  const partialId = makeCandidate(prog, "alpha beta outage zeta eta theta iota");
  incidents.declareIncident({ incidentId: partialId, actorId: "U1" });
  assert.equal(incidents.matchActiveIncident({ programId: prog, question: "alpha beta offline" }).id, id);
  // Cross-program isolation.
  db.saveProgram({ id: "char-match-other", name: "Other" });
  assert.equal(incidents.matchActiveIncident({ programId: "char-match-other", question: "alpha beta offline" }), null);
});

// WHY: the affected-report dedupe key is exactly (incident, channel, thread) —
// program and ticket are payload, not identity. Pins the current key so any
// future widening is a deliberate, reviewed change.
test("char: recordAffectedReport dedupes on (incident, channel, thread) only", () => {
  const prog = "char-aff-dedupe";
  db.saveProgram({ id: prog, name: "Aff" });
  const id = makeCandidate(prog, "aff outage");
  incidents.declareIncident({ incidentId: id, actorId: "U1" });
  assert.deepEqual(incidents.recordAffectedReport({ incidentId: id, programId: prog, requesterId: "U-a", channel: "C1", threadTs: "t1" }), { ok: true, deduped: false });
  // Same triple, different program/requester -> still deduped (key ignores them).
  assert.deepEqual(incidents.recordAffectedReport({ incidentId: id, programId: "other-prog", requesterId: "U-b", channel: "C1", threadTs: "t1" }), { ok: true, deduped: true });
  assert.equal(incidents.affectedReports(id).length, 1);
  // Same incident, different thread or channel -> new row.
  assert.deepEqual(incidents.recordAffectedReport({ incidentId: id, programId: prog, requesterId: "U-a", channel: "C1", threadTs: "t2" }), { ok: true, deduped: false });
  assert.deepEqual(incidents.recordAffectedReport({ incidentId: id, programId: prog, requesterId: "U-a", channel: "C2", threadTs: "t1" }), { ok: true, deduped: false });
  assert.equal(incidents.affectedReports(id).length, 3);
  // Different incident, same channel+thread -> new row (incident is in the key).
  const id2 = makeCandidate(prog, "aff outage two");
  incidents.declareIncident({ incidentId: id2, actorId: "U1" });
  assert.deepEqual(incidents.recordAffectedReport({ incidentId: id2, programId: prog, requesterId: "U-a", channel: "C1", threadTs: "t1" }), { ok: true, deduped: false });
});

// WHY: notify is explicit-only and idempotent — error strings, default vs
// custom message, onlyUnnotified filter, and the audit row are the contract
// frozen callers (serve.js incidentNotifyRoute) depend on.
test("char: notifyAffectedUsers contract — errors, messages, filter, audit", async () => {
  const prog = "char-notify-contract";
  db.saveProgram({ id: prog, name: "Notify" });
  programs.invalidate();
  const id = makeCandidate(prog, "checkout broken now");
  incidents.declareIncident({ incidentId: id, actorId: "U1" });
  assert.equal((await incidents.notifyAffectedUsers({ incidentId: 999999999, client: {} })).error, "incident not found");
  assert.equal((await incidents.notifyAffectedUsers({ incidentId: id })).error, "slack client unavailable");

  incidents.recordAffectedReport({ incidentId: id, programId: prog, requesterId: "U-a", channel: "C1", threadTs: "char-nc-t1" });
  const sent = [];
  const client = { chat: { postMessage: async (p) => { sent.push(p); return { ts: "1.0" }; } } };
  const baseAudit = db.listAuditEvents({ programId: prog }).length;
  const res = await incidents.notifyAffectedUsers({ incidentId: id, actorId: "U1", client });
  assert.deepEqual({ ok: res.ok, notified: res.notified, failed: res.failed }, { ok: true, notified: 1, failed: 0 });
  assert.match(sent[0].text, /checkout broken now/);
  const audits = db.listAuditEvents({ programId: prog });
  assert.ok(audits.length >= baseAudit + 1);
  assert.ok(audits.some((a) => a.action === "incident.notified_affected"));

  // Second run sends nothing (idempotent); onlyUnnotified filter agrees.
  const again = await incidents.notifyAffectedUsers({ incidentId: id, actorId: "U1", client });
  assert.equal(again.notified, 0);
  assert.equal(incidents.affectedReports(id, true).length, 0);
  assert.equal(incidents.affectedReports(id, false).length, 1);

  // Custom resolutionMessage replaces the default text verbatim.
  incidents.recordAffectedReport({ incidentId: id, programId: prog, requesterId: "U-b", channel: "C1", threadTs: "char-nc-t2" });
  sent.length = 0;
  const custom = await incidents.notifyAffectedUsers({ incidentId: id, actorId: "U1", client, resolutionMessage: "custom fix live" });
  assert.equal(custom.notified, 1);
  assert.equal(sent[0].text, "custom fix live");
});
export {};
