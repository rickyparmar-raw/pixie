// Smart routing: transparent helper recommendations from deterministic
// signals. No LLM picks a human — scoring is membership + declared expertise
// + verified resolutions in the ticket's category + current open load +
// recency, with reasons attached so the recommendation is inspectable.
// Stale members (active=0) are never routed. Default is recommend-only;
// auto-assignment runs only when the program explicitly enables it.
const db = require("./db");

const LOAD_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function setExpertise({ programId, userId, tags = [] }) {
  const clean = [...new Set(tags.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const existing = db.handle().query("SELECT tag, solved_count FROM helper_expertise WHERE program_id = ? AND user_id = ?").all(programId, userId);
  const counts = new Map(existing.map((r) => [r.tag, r.solved_count]));
  db.handle().query("DELETE FROM helper_expertise WHERE program_id = ? AND user_id = ?").run(programId, userId);
  const t = Date.now();
  for (const tag of clean) {
    db.handle().query("INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(programId, userId, tag, counts.get(tag) || 0, t);
  }
  return clean;
}

function getExpertise(programId, userId) {
  return db.handle().query("SELECT tag, solved_count FROM helper_expertise WHERE program_id = ? AND user_id = ?").all(programId, userId);
}

// Called whenever a ticket resolves with an assignee: verified category
// experience accrues only from real outcomes, never self-declared alone.
function recordResolution({ programId, userId, category = null }) {
  if (!programId || !userId) return;
  const tag = String(category || "general").trim().toLowerCase().slice(0, 60);
  const t = Date.now();
  db.handle().query(
    `INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(program_id, user_id, tag) DO UPDATE SET solved_count = solved_count + 1, updated_at = excluded.updated_at`,
  ).run(programId, userId, tag, t);
}

function openLoad(programId, userId) {
  const row = db.handle().query(
    "SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND assignee_id = ? AND status IN ('claimed','assigned','waiting_for_helper','escalated','reopened')",
  ).get(programId, userId);
  return row ? row.n : 0;
}

function recentActivity(programId, userId) {
  const row = db.handle().query(
    "SELECT MAX(created_at) AS at FROM ticket_events WHERE program_id = ? AND actor_id = ?",
  ).get(programId, userId);
  return row ? row.at : null;
}

function recommend({ programId, category = null, limit = 3 }) {
  const helpers = db.listHelpers(programId, true);
  const tag = category ? String(category).trim().toLowerCase() : null;
  const scored = helpers.map((h) => {
    const reasons = ["active program member"];
    let score = 1;
    const expertise = getExpertise(programId, h.user_id);
    if (tag) {
      const match = expertise.find((e) => e.tag === tag);
      if (match) {
        const pts = 2 + Math.min(match.solved_count, 10);
        score += pts;
        reasons.push(`${match.solved_count} verified ${tag} resolution${match.solved_count === 1 ? "" : "s"}`);
      }
    }
    const totalSolved = expertise.reduce((n, e) => n + e.solved_count, 0);
    if (totalSolved > 0) {
      score += Math.min(totalSolved, 5) * 0.2;
      reasons.push(`${totalSolved} total verified resolutions`);
    }
    const load = openLoad(programId, h.user_id);
    score -= Math.min(load, 5) * 0.5;
    reasons.push(load === 0 ? "no open assigned tickets" : `${load} open assigned ticket${load === 1 ? "" : "s"}`);
    const last = recentActivity(programId, h.user_id);
    if (last && Date.now() - last < 7 * 24 * 60 * 60 * 1000) {
      score += 0.5;
      reasons.push("active in the last 7 days");
    }
    if (h.role === "organizer" || h.role === "owner") {
      score += 0.5;
      reasons.push(`program ${h.role}`);
    }
    return { userId: h.user_id, role: h.role, score: Number(score.toFixed(2)), load, reasons };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(Math.max(limit, 1), 10));
}

module.exports = { setExpertise, getExpertise, recordResolution, openLoad, recommend };
