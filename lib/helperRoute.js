// Smart routing: transparent helper recommendations from deterministic
// signals. No LLM picks a human — scoring is membership + declared expertise
// + verified resolutions in the ticket's category + current open load +
// recency, with reasons attached so the recommendation is inspectable.
// Stale members (active=0) are never routed. Default is recommend-only;
// auto-assignment runs only when the program explicitly enables it.
//
// Tie-break is roster order: equal scores keep listHelpers() order
// (program_helpers.added_at ASC), so the longest-standing member wins ties.
const db = require("./db");

// WHY: a member with no other signal still outranks nobody — empty rosters
// return [] and every listed helper starts from the same floor.
const BASE_SCORE = 1;
// WHY: self-declared tags alone prove nothing, so the match bonus must clear
// the noise floor of load/recency/role swings combined.
const CATEGORY_MATCH_BASE = 2;
// WHY: one prolific helper must not starve every newcomer forever.
const CATEGORY_SOLVED_CAP = 10;
// WHY: a reply is real evidence someone engages with a topic, but it is not
// proof they closed anything — so it accrues at a fifth of a resolution, and
// the cap keeps a chatty helper from outranking one who actually resolves.
const CATEGORY_REPLY_WEIGHT = 0.2;
const CATEGORY_REPLY_CAP = 15;
// WHY: breadth across categories is weaker evidence than depth in the ticket's
// own category, so it accrues at a fraction of the match rate.
const TOTAL_SOLVED_WEIGHT = 0.2;
// WHY: same anti-monopoly reasoning as the per-category cap.
const TOTAL_SOLVED_CAP = 5;
// WHY: an overloaded helper answers slowly; the penalty must outweigh recency
// and role bonuses combined so load actually reroutes.
const LOAD_WEIGHT = 0.5;
// WHY: beyond a full plate, extra tickets add no new information about slowness.
const LOAD_CAP = 5;
// WHY: recent presence predicts availability, but weakly — it must never beat
// real category experience.
const RECENT_BONUS = 0.5;
// WHY: 7 days separates currently-around helpers from drive-bys without
// punishing a normal week offline.
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// WHY: organizers/owners can unblock process issues a helper cannot, worth a
// nudge but never worth overriding verified expertise.
const ROLE_BONUS = 0.5;
// WHY: the card select the recommendation feeds has no room for a phone book.
const MAX_RECOMMENDATIONS = 10;

// Declaring tags rewrites which categories a helper claims, but it must not
// rewrite what they demonstrably did: counts carry over for a re-declared tag,
// and a tag they never declared yet have real history in is kept rather than
// deleted. Only empty, undeclared rows are dropped.
function setExpertise({ programId, userId, tags = [] }) {
  const clean = [...new Set(tags.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const existing = db.handle().query(
    "SELECT tag, solved_count, reply_count FROM helper_expertise WHERE program_id = ? AND user_id = ?",
  ).all(programId, userId);
  const counts = new Map(existing.map((r) => [r.tag, { solved: r.solved_count || 0, replies: r.reply_count || 0 }]));
  const observed = existing
    .filter((r) => !clean.includes(r.tag) && ((r.solved_count || 0) > 0 || (r.reply_count || 0) > 0))
    .map((r) => r.tag);

  db.handle().query("DELETE FROM helper_expertise WHERE program_id = ? AND user_id = ?").run(programId, userId);
  const t = Date.now();
  for (const tag of [...clean, ...observed]) {
    const prior = counts.get(tag) || { solved: 0, replies: 0 };
    db.handle().query(
      "INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, reply_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(programId, userId, tag, prior.solved, prior.replies, t);
  }
  return clean;
}

function getExpertise(programId, userId) {
  return db.handle().query("SELECT tag, solved_count, reply_count FROM helper_expertise WHERE program_id = ? AND user_id = ?").all(programId, userId);
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

// Called whenever a helper answers in a ticket's thread. Separate from
// recordResolution because answering is not closing: most helpers reply far
// more often than they are ever marked the assignee, and without this the
// person who reliably fields every review question scores nothing.
function recordReply({ programId, userId, category = null }) {
  if (!programId || !userId) return;
  const tag = String(category || "general").trim().toLowerCase().slice(0, 60);
  const t = Date.now();
  db.handle().query(
    `INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, reply_count, updated_at) VALUES (?, ?, ?, 0, 1, ?)
     ON CONFLICT(program_id, user_id, tag) DO UPDATE SET reply_count = reply_count + 1, updated_at = excluded.updated_at`,
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

function normalizeCategory(category) {
  if (!category) return null;
  return String(category).trim().toLowerCase();
}

function matchBonus(expertise, tag) {
  if (!tag) return null;
  const match = expertise.find((e) => e.tag === tag);
  if (!match) return null;
  const solved = match.solved_count || 0;
  const replies = match.reply_count || 0;
  return {
    match,
    solved,
    replies,
    pts:
      CATEGORY_MATCH_BASE +
      Math.min(solved, CATEGORY_SOLVED_CAP) +
      Math.min(replies, CATEGORY_REPLY_CAP) * CATEGORY_REPLY_WEIGHT,
  };
}

function breadthBonus(expertise) {
  const total = expertise.reduce((n, e) => n + e.solved_count, 0);
  if (total <= 0) return null;
  return { total, pts: Math.min(total, TOTAL_SOLVED_CAP) * TOTAL_SOLVED_WEIGHT };
}

function loadPenalty(load) {
  return Math.min(load, LOAD_CAP) * LOAD_WEIGHT;
}

function isRecentlyActive(lastActiveAt, now) {
  if (!lastActiveAt) return false;
  return now - lastActiveAt < RECENT_WINDOW_MS;
}

function hasRoleBonus(role) {
  return role === "organizer" || role === "owner";
}

// Pure scorer: no DB, no clock — every signal arrives via ctx, so tests can
// pin weights without a database. helper is { user_id, role };
// ctx is { tag, expertise, load, lastActiveAt, now }.
function scoreHelper(helper, ctx = {}) {
  const { tag = null, expertise = [], load = 0, lastActiveAt = null, now = Date.now() } = ctx;
  const reasons = ["active program member"];
  let score = BASE_SCORE;

  const hit = matchBonus(expertise, tag);
  if (hit) {
    score += hit.pts;
    // Resolutions and replies are named separately so the reason never passes
    // off "answered a few of these" as "closed a few of these".
    const evidence = [];
    if (hit.solved > 0) evidence.push(`${hit.solved} verified ${tag} resolution${hit.solved === 1 ? "" : "s"}`);
    if (hit.replies > 0) evidence.push(`${hit.replies} ${tag} repl${hit.replies === 1 ? "y" : "ies"}`);
    reasons.push(evidence.length > 0 ? evidence.join(" · ") : `declared ${tag} expertise`);
  }

  const breadth = breadthBonus(expertise);
  if (breadth) {
    score += breadth.pts;
    reasons.push(`${breadth.total} total verified resolutions`);
  }

  score -= loadPenalty(load);
  reasons.push(load === 0 ? "no open assigned tickets" : `${load} open assigned ticket${load === 1 ? "" : "s"}`);

  if (isRecentlyActive(lastActiveAt, now)) {
    score += RECENT_BONUS;
    reasons.push("active in the last 7 days");
  }

  if (hasRoleBonus(helper.role)) {
    score += ROLE_BONUS;
    reasons.push(`program ${helper.role}`);
  }

  return { userId: helper.user_id, role: helper.role, score: Number(score.toFixed(2)), load, reasons };
}

function clampLimit(limit) {
  return Math.min(Math.max(limit, 1), MAX_RECOMMENDATIONS);
}

function recommend({ programId, category = null, limit = 3 }) {
  const helpers = db.listHelpers(programId, true);
  if (helpers.length === 0) return [];
  const tag = normalizeCategory(category);
  const now = Date.now();
  const ranked = helpers.map((h, rosterIndex) => ({
    entry: scoreHelper(
      h,
      {
        tag,
        expertise: getExpertise(programId, h.user_id),
        load: openLoad(programId, h.user_id),
        lastActiveAt: recentActivity(programId, h.user_id),
        now,
      },
    ),
    rosterIndex,
  }));
  ranked.sort((a, b) => b.entry.score - a.entry.score || a.rosterIndex - b.rosterIndex);
  return ranked.slice(0, clampLimit(limit)).map((r) => r.entry);
}

module.exports = { setExpertise, getExpertise, recordResolution, recordReply, openLoad, recommend, scoreHelper };
