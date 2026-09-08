// Support Radar: deterministic actionable signals computed from telemetry
// already stored by tickets/gapClusters/incidents/sla/source_cache.
// No LLM ever decides a signal fires — every detector below is a plain
// query plus an explicit threshold, and every signal carries the evidence
// that produced it so the UI can show organizers why.
//
// One row per ongoing condition: re-running evaluateProgram() updates the
// same radar_signals row (see idx_radar_program_type_fingerprint) instead of
// piling up duplicates, and a condition that clears gets auto-resolved.
const crypto = require("crypto");
const db = require("./db");
const audit = require("./audit");
const gapClusters = require("./gapClusters");
const incidents = require("./incidents");

const TYPES = [
  "STALE_TICKETS",
  "ESCALATION_SPIKE",
  "FAQ_CLUSTER",
  "LOW_CONFIDENCE_TOPIC",
  "SOURCE_FAILURE",
  "KNOWLEDGE_GAP",
  "INCIDENT_CANDIDATE",
  "ACTIVE_INCIDENT",
  "REOPEN_SPIKE",
];
const SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUSES = ["active", "acknowledged", "resolved", "suppressed"];
const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
const SUPPRESS_DURATIONS_MS = { "1h": 3600000, "24h": 86400000, "7d": 7 * 86400000 };

// WHY: a ticket with an owner or a pending state still needs someone to act,
// so every not-yet-closed state counts as open for staleness.
const OPEN_STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
// WHY: 12h is the nudge point (something is waiting), 24h is the escalation
// point (a whole day with no movement means the requester is stuck).
const STALE_WARN_MS = 12 * 60 * 60 * 1000;
const STALE_HIGH_MS = 24 * 60 * 60 * 1000;
// WHY: fewer than 3 tickets in an hour is normal noise, not a spike; the
// 6h baseline absorbs time-of-day effects so lunch rushes don't page anyone.
const ESCALATION_MIN_RECENT = 3;
const ESCALATION_WINDOW_MS = 60 * 60 * 1000;
const ESCALATION_BASELINE_WINDOW_MS = 6 * 60 * 60 * 1000;
// WHY: the recent hour must at least double the baseline rate — a smaller
// jump is indistinguishable from ordinary variance.
const ESCALATION_BASELINE_MULTIPLIER = 2;
// WHY: 4x baseline is paging-worthy, 2.5x deserves eyes, anything above the
// 2x trigger is still worth a MEDIUM note.
const ESCALATION_CRITICAL_RATIO = 4;
const ESCALATION_HIGH_RATIO = 2.5;
// WHY: a 24h window matches the organizer's daily rhythm; 5 distinct askers
// filters one-off confusion while still catching a bad morning early.
const FAQ_WINDOW_MS = 24 * 60 * 60 * 1000;
const FAQ_MIN_ASKERS = 5;
// WHY: 15 askers in a day means the docs are actively misleading a crowd.
const FAQ_HIGH_ASKERS = 15;
// WHY: a 7d window smooths single bad days; 5 questions is the smallest
// sample whose mean isn't dominated by one outlier.
const LOW_CONFIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOW_CONFIDENCE_MIN_QUESTIONS = 5;
// WHY: below 0.5 the answers are wrong more often than right, so the topic
// needs human review; below 0.3 they are nearly always wrong.
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const LOW_CONFIDENCE_HIGH_MEAN = 0.3;
// WHY: 3 consecutive refresh failures means the source is down, not
// flapping — one failure is retried silently.
const SOURCE_HIGH_FAILS = 3;
// WHY: 3 reopens in 24h is a pattern, not coincidence; a 20% reopen rate
// means one in five resolutions fails the requester.
const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const REOPEN_MIN_COUNT = 3;
const REOPEN_RATE_THRESHOLD = 0.2;
// WHY: at 40% the resolution path itself is broken, not just unlucky.
const REOPEN_HIGH_RATE = 0.4;
// WHY: the radar mirrors at most a screenful of live incidents per program.
const ACTIVE_INCIDENT_LIST_LIMIT = 20;
// WHY: 10m keeps signals fresh without hammering the DB on idle programs.
const RADAR_LOOP_DEFAULT_MIN = 10;
const RADAR_LEASE_NAME = "radar-eval";
// WHY: the platform-wide program has no owning organizers to notify.
const SKIPPED_PROGRAM_ID = "ysws-global";

function assertValid(type, severity) {
  if (!TYPES.includes(type)) throw new Error(`invalid radar signal type: ${type}`);
  if (!SEVERITIES.includes(severity)) throw new Error(`invalid radar severity: ${severity}`);
}

function row(id) {
  return db.handle().query("SELECT * FROM radar_signals WHERE id = ?").get(id) || null;
}

function listSignals(programId, { status = null, severity = null, limit = 100 } = {}) {
  if (!programId) return { error: "programId required" };
  const clauses = ["program_id = ?"];
  const params = [programId];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(severity);
  }
  const rows = db
    .handle()
    .query(`SELECT * FROM radar_signals WHERE ${clauses.join(" AND ")} ORDER BY last_detected_at DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(Number(limit) || 100, 1), 500));
  return rows
    .map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null }))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.last_detected_at - a.last_detected_at);
}

// Insert-or-update by (program_id, type, fingerprint). A signal already
// suppressed stays suppressed until its window expires — even if the
// underlying condition worsens — because a deterministic radar that
// overrides an organizer's own suppression on every noisy re-check is not
// actually less noisy than the alert it was built to replace. Documented
// trade-off, not an oversight.
function upsertSignal({ programId, type, severity, title, summary, evidence, fingerprint, now = Date.now() }) {
  assertValid(type, severity);
  if (!programId || !fingerprint) throw new Error("programId and fingerprint required");
  const existing = db
    .handle()
    .query("SELECT * FROM radar_signals WHERE program_id = ? AND type = ? AND fingerprint = ?")
    .get(programId, type, fingerprint);
  const evidenceJson = JSON.stringify(evidence || {});

  if (!existing) {
    const res = db
      .handle()
      .query(
        `INSERT INTO radar_signals (program_id, type, severity, status, title, summary, evidence, fingerprint, first_detected_at, last_detected_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(programId, type, severity, title, summary || null, evidenceJson, fingerprint, now, now, now, now);
    return row(Number(res.lastInsertRowid));
  }

  if (existing.status === "suppressed" && existing.suppressed_until && existing.suppressed_until > now) {
    db.handle()
      .query("UPDATE radar_signals SET severity = ?, title = ?, summary = ?, evidence = ?, last_detected_at = ?, updated_at = ? WHERE id = ?")
      .run(severity, title, summary || null, evidenceJson, now, now, existing.id);
    return row(existing.id);
  }

  // A resolved/expired-suppression/acknowledged signal re-firing is treated
  // as a fresh occurrence of the same condition: status returns to active
  // and the detection clock restarts, but the row (and its history) is reused
  // rather than duplicated.
  const wasClosed = existing.status === "resolved" || (existing.status === "suppressed" && existing.suppressed_until && existing.suppressed_until <= now);
  const nextStatus = existing.status === "acknowledged" ? "acknowledged" : "active";
  const firstDetectedAt = wasClosed ? now : existing.first_detected_at;
  db.handle()
    .query(
      `UPDATE radar_signals SET severity = ?, status = ?, title = ?, summary = ?, evidence = ?,
       first_detected_at = ?, last_detected_at = ?, resolved_at = ?, suppressed_until = ?, updated_at = ? WHERE id = ?`,
    )
    .run(severity, nextStatus, title, summary || null, evidenceJson, firstDetectedAt, now, wasClosed ? null : existing.resolved_at, wasClosed ? null : existing.suppressed_until, now, existing.id);
  return row(existing.id);
}

// Conditions that cleared: any active/acknowledged signal of `type` whose
// fingerprint wasn't re-detected this pass gets auto-resolved. Manual
// resolutions and suppressions are left alone — this only closes out
// signals the detector itself would otherwise leave stale.
function autoResolveMissing(programId, type, seenFingerprints, now = Date.now()) {
  const stale = db
    .handle()
    .query("SELECT id, fingerprint FROM radar_signals WHERE program_id = ? AND type = ? AND status IN ('active','acknowledged')")
    .all(programId, type);
  for (const s of stale) {
    if (seenFingerprints.has(s.fingerprint)) continue;
    db.handle().query("UPDATE radar_signals SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(now, now, s.id);
  }
}

function programScoped(id, actorId, requireHelper) {
  const inc = row(id);
  if (!inc) return { error: "signal not found" };
  if (requireHelper && !requireHelper(inc.program_id, actorId)) return { error: "actor is not a helper of this program" };
  return { signal: inc };
}

function acknowledgeSignal({ id, actorId = null, requireHelper = null } = {}) {
  const scoped = programScoped(id, actorId, requireHelper);
  if (scoped.error) return scoped;
  const now = Date.now();
  db.handle().query("UPDATE radar_signals SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?").run(now, actorId, now, id);
  audit.record({ programId: scoped.signal.program_id, actorId, action: "radar.acknowledged", entityType: "radar_signal", entityId: id });
  return { ok: true, signal: row(id) };
}

function resolveSignal({ id, actorId = null, requireHelper = null } = {}) {
  const scoped = programScoped(id, actorId, requireHelper);
  if (scoped.error) return scoped;
  const now = Date.now();
  db.handle().query("UPDATE radar_signals SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  audit.record({ programId: scoped.signal.program_id, actorId, action: "radar.resolved", entityType: "radar_signal", entityId: id });
  return { ok: true, signal: row(id) };
}

function suppressSignal({ id, actorId = null, duration, requireHelper = null } = {}) {
  const scoped = programScoped(id, actorId, requireHelper);
  if (scoped.error) return scoped;
  const durationMs = SUPPRESS_DURATIONS_MS[duration];
  if (!durationMs) return { error: `duration must be one of ${Object.keys(SUPPRESS_DURATIONS_MS).join(", ")}` };
  const now = Date.now();
  db.handle().query("UPDATE radar_signals SET status = 'suppressed', suppressed_until = ?, updated_at = ? WHERE id = ?").run(now + durationMs, now, id);
  audit.record({ programId: scoped.signal.program_id, actorId, action: "radar.suppressed", entityType: "radar_signal", entityId: id, metadata: { duration } });
  return { ok: true, signal: row(id) };
}

/* ------------------------------------------------------------- detectors -- */

function staleSeverity(oldestMs) {
  return oldestMs > STALE_HIGH_MS ? "HIGH" : "MEDIUM";
}

function fetchOpenTickets(programId) {
  return db
    .handle()
    .query(
      `SELECT id, status, created_at FROM tickets
       WHERE program_id = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`,
    )
    .all(programId, ...OPEN_STATUSES);
}

function decideStaleTickets(openRows, now) {
  if (openRows.length === 0) return null;
  const stale = openRows.filter((t) => now - t.created_at > STALE_WARN_MS).sort((a, b) => a.created_at - b.created_at);
  if (stale.length === 0) return null;
  const oldestMs = now - stale[0].created_at;
  const hours = Math.round(oldestMs / 3600000);
  return {
    type: "STALE_TICKETS",
    severity: staleSeverity(oldestMs),
    title: `${stale.length} ticket${stale.length === 1 ? "" : "s"} waiting >12h`,
    summary: `Oldest has waited ${hours}h.`,
    fingerprint: "backlog",
    evidence: {
      count: stale.length,
      oldestWaitMs: oldestMs,
      sampleTicketIds: stale.slice(0, 5).map((t) => t.id),
      statuses: [...new Set(stale.map((t) => t.status))],
    },
  };
}

function detectStaleTickets(programId, now) {
  return decideStaleTickets(fetchOpenTickets(programId), now);
}

function escalationSeverity(ratio) {
  if (ratio >= ESCALATION_CRITICAL_RATIO) return "CRITICAL";
  if (ratio >= ESCALATION_HIGH_RATIO) return "HIGH";
  return "MEDIUM";
}

function decideEscalationSpike(recent, baselineTotal) {
  if (recent < ESCALATION_MIN_RECENT) return null;
  const baselineBuckets = ESCALATION_BASELINE_WINDOW_MS / ESCALATION_WINDOW_MS;
  const baselinePerWindow = baselineTotal / baselineBuckets;
  const threshold = Math.max(ESCALATION_MIN_RECENT, baselinePerWindow * ESCALATION_BASELINE_MULTIPLIER);
  if (recent < threshold) return null;
  const ratio = baselinePerWindow > 0 ? recent / baselinePerWindow : recent;
  return { baselinePerWindow, severity: escalationSeverity(ratio) };
}

function detectEscalationSpike(programId, now) {
  const recentCutoff = now - ESCALATION_WINDOW_MS;
  const baselineCutoff = now - ESCALATION_BASELINE_WINDOW_MS;
  const recent = db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ?").get(programId, recentCutoff).n;
  const baselineTotal = db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ? AND created_at <= ?").get(programId, baselineCutoff, recentCutoff).n;
  const decided = decideEscalationSpike(recent, baselineTotal);
  if (!decided) return null;
  return {
    type: "ESCALATION_SPIKE",
    severity: decided.severity,
    title: `${recent} new tickets in the last hour`,
    summary: `Baseline is ~${decided.baselinePerWindow.toFixed(1)}/hour over the prior 6h.`,
    fingerprint: "spike",
    evidence: { recentCount: recent, baselinePerWindow: Number(decided.baselinePerWindow.toFixed(2)), windowMs: ESCALATION_WINDOW_MS },
  };
}

function faqSeverity(askers) {
  return askers >= FAQ_HIGH_ASKERS ? "HIGH" : "MEDIUM";
}

function faqFingerprint(representative) {
  return crypto.createHash("sha1").update(representative.toLowerCase()).digest("hex").slice(0, 16);
}

function detectFaqClusters(programId) {
  const { clusters, error } = gapClusters.clusterGaps({ programId, sinceMs: FAQ_WINDOW_MS, minAskers: FAQ_MIN_ASKERS });
  if (error || !clusters) return [];
  return clusters.map((c) => ({
    type: "FAQ_CLUSTER",
    severity: faqSeverity(c.askers),
    title: `${c.askers} askers about "${c.representative.slice(0, 80)}"`,
    summary: `${c.askCount} question${c.askCount === 1 ? "" : "s"} in 24h${c.covered ? " (docs already cover this)" : ""}.`,
    fingerprint: faqFingerprint(c.representative),
    evidence: { askers: c.askers, askCount: c.askCount, escalated: c.escalated, covered: c.covered, sampleThreads: c.threads },
  }));
}

function lowConfidenceSeverity(mean) {
  return mean < LOW_CONFIDENCE_HIGH_MEAN ? "HIGH" : "MEDIUM";
}

function decideLowConfidenceFinding(category, group) {
  if (group.length < LOW_CONFIDENCE_MIN_QUESTIONS) return null;
  const mean = group.reduce((sum, r) => sum + r.ai_confidence, 0) / group.length;
  if (mean >= LOW_CONFIDENCE_THRESHOLD) return null;
  const escalated = group.filter((r) => r.status === "escalated" || r.status === "reopened").length;
  return {
    type: "LOW_CONFIDENCE_TOPIC",
    severity: lowConfidenceSeverity(mean),
    title: `Low answer confidence: ${category}`,
    summary: `${group.length} questions, mean confidence ${Math.round(mean * 100)}%.`,
    fingerprint: category,
    evidence: { questionCount: group.length, meanConfidence: Number(mean.toFixed(2)), escalatedCount: escalated },
  };
}

function detectLowConfidenceTopics(programId, now) {
  const cutoff = now - LOW_CONFIDENCE_WINDOW_MS;
  const rows = db
    .handle()
    .query(
      `SELECT COALESCE(category, 'uncategorized') AS category, ai_confidence, status FROM tickets
       WHERE program_id = ? AND created_at > ? AND ai_confidence IS NOT NULL`,
    )
    .all(programId, cutoff);
  const byCategory = new Map();
  for (const r of rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }
  const out = [];
  for (const [category, group] of byCategory) {
    const finding = decideLowConfidenceFinding(category, group);
    if (finding) out.push(finding);
  }
  return out;
}

function sourceSeverity(failCount, neverSucceeded) {
  if (failCount >= SOURCE_HIGH_FAILS) return "HIGH";
  if (neverSucceeded) return "MEDIUM";
  return "LOW";
}

function detectSourceFailures(programId) {
  const programs = require("./programs");
  const prog = programs.get(programId);
  const sources = prog && Array.isArray(prog.sources) ? prog.sources : [];
  if (sources.length === 0) return [];
  const knowledge = require("./knowledge");
  const keyed = sources.map((s) => ({ source: s, key: knowledge.sourceCacheKey(s) || s.name })).filter((x) => x.key);
  const health = db.getSourceHealth(keyed.map((x) => x.key));
  const byKey = new Map(health.map((h) => [h.name, h]));
  const out = [];
  for (const { source, key } of keyed) {
    const h = byKey.get(key);
    if (!h || h.fail_count === 0) continue;
    const neverSucceeded = !h.last_success_at;
    const staleness = neverSucceeded ? "never had a successful refresh" : `last succeeded ${Math.round((Date.now() - h.last_success_at) / 3600000)}h ago`;
    out.push({
      type: "SOURCE_FAILURE",
      severity: sourceSeverity(h.fail_count, neverSucceeded),
      title: `Source "${source.name}" failed to refresh`,
      summary: `${h.fail_count} consecutive failure${h.fail_count === 1 ? "" : "s"}, ${staleness}.`,
      fingerprint: key,
      evidence: { source: source.name, failCount: h.fail_count, lastError: h.last_error, lastSuccessAt: h.last_success_at },
    });
  }
  return out;
}

function reopenSeverity(rate) {
  return rate >= REOPEN_HIGH_RATE ? "HIGH" : "MEDIUM";
}

function decideReopenSpike(rows) {
  if (rows.length === 0) return null;
  const reopened = rows.filter((r) => (r.reopen_count || 0) > 0).length;
  if (reopened < REOPEN_MIN_COUNT) return null;
  const rate = reopened / rows.length;
  if (rate < REOPEN_RATE_THRESHOLD) return null;
  return {
    type: "REOPEN_SPIKE",
    severity: reopenSeverity(rate),
    title: `${reopened} tickets reopened in 24h`,
    summary: `${Math.round(rate * 100)}% reopen rate over ${rows.length} tickets.`,
    fingerprint: "reopen",
    evidence: { reopenedCount: reopened, totalCount: rows.length, rate: Number(rate.toFixed(2)) },
  };
}

function detectReopenSpike(programId, now) {
  const cutoff = now - REOPEN_WINDOW_MS;
  const rows = db.handle().query("SELECT reopen_count FROM tickets WHERE program_id = ? AND created_at > ?").all(programId, cutoff);
  return decideReopenSpike(rows);
}

function detectIncidentSignals(programId) {
  const out = [];
  let detected;
  try {
    detected = incidents.detectBursts({ programId });
  } catch (_) {
    detected = { candidates: [] };
  }
  for (const c of detected.candidates || []) {
    out.push({
      type: "INCIDENT_CANDIDATE",
      severity: "MEDIUM",
      title: `Possible incident: ${c.title}`,
      summary: `${c.linked} similar ticket${c.linked === 1 ? "" : "s"} clustered together.`,
      fingerprint: String(c.incidentId),
      evidence: { incidentId: c.incidentId, linked: c.linked },
    });
  }
  const active = incidents.listIncidents(programId, "confirmed", ACTIVE_INCIDENT_LIST_LIMIT);
  for (const inc of active) {
    const affected = db.handle().query("SELECT COUNT(*) AS n FROM incident_reports WHERE incident_id = ?").get(inc.id).n;
    const startedAgoMin = Math.round((Date.now() - inc.started_at) / 60000);
    out.push({
      type: "ACTIVE_INCIDENT",
      severity: "CRITICAL",
      title: `Active incident: ${inc.title}`,
      summary: `Started ~${startedAgoMin}m ago. ${affected} affected report${affected === 1 ? "" : "s"} tracked.`,
      fingerprint: String(inc.id),
      evidence: { incidentId: inc.id, startedAt: inc.started_at, affectedReports: affected },
    });
  }
  return out;
}

// Runs every detector for one program, upserts the resulting signals, and
// auto-resolves anything a detector no longer finds. Cheap and idempotent —
// safe to call from a background loop or an on-demand "refresh" button.
function evaluateProgram(programId) {
  if (!programId) return { error: "programId required" };
  const now = Date.now();
  const findings = [
    detectStaleTickets(programId, now),
    detectEscalationSpike(programId, now),
    ...detectFaqClusters(programId),
    ...detectLowConfidenceTopics(programId, now),
    ...detectSourceFailures(programId),
    detectReopenSpike(programId, now),
    ...detectIncidentSignals(programId),
  ].filter(Boolean);

  const seenByType = new Map();
  const signals = [];
  for (const f of findings) {
    if (!seenByType.has(f.type)) seenByType.set(f.type, new Set());
    seenByType.get(f.type).add(f.fingerprint);
    signals.push(upsertSignal({ programId, now, ...f }));
  }
  for (const type of TYPES) {
    autoResolveMissing(programId, type, seenByType.get(type) || new Set(), now);
  }
  return { signals };
}

// Single-flight background loop, same shape as lib/sla.js's startSlaLoop:
// leased across replicas, quiet unless a program actually has activity.
function startRadarLoop(intervalMin = Number(process.env.PIXIE_RADAR_CHECK_MIN || RADAR_LOOP_DEFAULT_MIN)) {
  if (!intervalMin || intervalMin <= 0) return null;
  const log = require("./log");
  const lease = require("./jobLease");
  const timer = setInterval(() => {
    lease.runOnce(RADAR_LEASE_NAME, intervalMin * 60 * 1000, async () => {
      const programs = require("./programs");
      for (const prog of programs.all()) {
        if (!prog || prog.id === SKIPPED_PROGRAM_ID) continue;
        try {
          evaluateProgram(prog.id);
        } catch (e) {
          log.warn("radar", `evaluate failed for ${prog.id}: ${e.message}`);
        }
      }
    }).catch((e) => log.error("radar", `loop failed: ${e.message}`));
  }, intervalMin * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  TYPES,
  SEVERITIES,
  STATUSES,
  SUPPRESS_DURATIONS_MS,
  listSignals,
  upsertSignal,
  acknowledgeSignal,
  resolveSignal,
  suppressSignal,
  evaluateProgram,
  startRadarLoop,
  getSignal: row,
  // Exposed for targeted testing of one detector without a full evaluate pass.
  detectStaleTickets,
  detectEscalationSpike,
  detectFaqClusters,
  detectLowConfidenceTopics,
  detectSourceFailures,
  detectReopenSpike,
  detectIncidentSignals,
};
