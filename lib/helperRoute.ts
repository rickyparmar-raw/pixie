import db = require("./db");

interface DbRow {
  program_id?: string;
  user_id?: string;
  role?: string;
  tag?: string;
  solved_count?: number;
  reply_count?: number;
  ping_eligible?: number;
  n?: number;
  at?: number;
  created_at?: number;
  detail?: unknown;
  [key: string]: unknown;
}

interface ExpertiseRow extends DbRow {
  tag: string;
  solved_count: number;
  reply_count: number;
}

interface HelperRow extends DbRow {
  user_id: string;
  role: string;
  ping_eligible?: number;
}

interface Fatigue {
  count: number;
  lastPingAt: number | null;
}

interface ScoringContext {
  tag?: string | null;
  expertise?: ExpertiseRow[];
  load?: number;
  lastActiveAt?: number | null;
  fatigue?: Fatigue | null;
  now?: number;
}

// A member with no other signal still outranks nobody — empty rosters
// return [] and every listed helper starts from the same floor.
const BASE_SCORE = 1;
// Self-declared tags alone prove nothing, so the match bonus must clear
// the noise floor of load/recency/role swings combined.
const CATEGORY_MATCH_BASE = 2;
// One prolific helper must not starve every newcomer forever.
const CATEGORY_SOLVED_CAP = 10;
const CATEGORY_REPLY_WEIGHT = 0.2;
const CATEGORY_REPLY_CAP = 15;
// Breadth across categories is weaker evidence than depth in the ticket's
// own category, so it accrues at a fraction of the match rate.
const TOTAL_SOLVED_WEIGHT = 0.2;
// Same anti-monopoly reasoning as the per-category cap.
const TOTAL_SOLVED_CAP = 5;
// An overloaded helper answers slowly; the penalty must outweigh recency
// and role bonuses combined so load actually reroutes.
const LOAD_WEIGHT = 0.5;
// Beyond a full plate, extra tickets add no new information about slowness.
const LOAD_CAP = 5;
// Recent presence predicts availability, but weakly — it must never beat
// real category experience.
const RECENT_BONUS = 0.5;
// 7 days separates currently-around helpers from drive-bys without
// punishing a normal week offline.
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Organizers/owners can unblock process issues a helper cannot, worth a
// nudge but never worth overriding verified expertise.
const ROLE_BONUS = 0.5;
// The card select the recommendation feeds has no room for a phone book.
const MAX_RECOMMENDATIONS = 10;

const PING_FATIGUE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PING_FATIGUE_WEIGHT = 0.15;
const PING_FATIGUE_CAP = 5;
const PING_FATIGUE_RECENT_MS = 60 * 60 * 1000;
const PING_FATIGUE_RECENT_PENALTY = 0.25;

function setExpertise({
  programId,
  userId,
  tags = [],
}: {
  programId: string;
  userId: string;
  tags?: unknown[];
}): string[] {
  const clean = [
    ...new Set(
      tags
        .map((t) =>
          String(t || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ].slice(0, 20);
  const existing = db
    .handle()
    .query("SELECT tag, solved_count, reply_count FROM helper_expertise WHERE program_id = ? AND user_id = ?")
    .all(programId, userId) as ExpertiseRow[];
  const counts = new Map<string, { solved: number; replies: number }>(
    existing.map((r) => [r.tag, { solved: r.solved_count || 0, replies: r.reply_count || 0 }]),
  );
  const observed = existing
    .filter((r) => !clean.includes(r.tag) && ((r.solved_count || 0) > 0 || (r.reply_count || 0) > 0))
    .map((r) => r.tag);

  db.handle().query("DELETE FROM helper_expertise WHERE program_id = ? AND user_id = ?").run(programId, userId);
  const t = Date.now();
  for (const tag of [...clean, ...observed]) {
    const prior = counts.get(tag) || { solved: 0, replies: 0 };
    db.handle()
      .query(
        "INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, reply_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(programId, userId, tag, prior.solved, prior.replies, t);
  }
  return clean;
}

function getExpertise(programId: string | undefined, userId: string): ExpertiseRow[] {
  return db
    .handle()
    .query("SELECT tag, solved_count, reply_count FROM helper_expertise WHERE program_id = ? AND user_id = ?")
    .all(programId, userId) as ExpertiseRow[];
}

function recordResolution({
  programId,
  userId,
  category = null,
}: {
  programId?: string;
  userId?: string;
  category?: unknown;
}): void {
  if (!programId || !userId) return;
  const tag = String(category || "general")
    .trim()
    .toLowerCase()
    .slice(0, 60);
  const t = Date.now();
  db.handle()
    .query(
      `INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(program_id, user_id, tag) DO UPDATE SET solved_count = solved_count + 1, updated_at = excluded.updated_at`,
    )
    .run(programId, userId, tag, t);
}

function recordReply({
  programId,
  userId,
  category = null,
}: {
  programId?: string;
  userId?: string;
  category?: unknown;
}): void {
  if (!programId || !userId) return;
  const tag = String(category || "general")
    .trim()
    .toLowerCase()
    .slice(0, 60);
  const t = Date.now();
  db.handle()
    .query(
      `INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, reply_count, updated_at) VALUES (?, ?, ?, 0, 1, ?)
     ON CONFLICT(program_id, user_id, tag) DO UPDATE SET reply_count = reply_count + 1, updated_at = excluded.updated_at`,
    )
    .run(programId, userId, tag, t);
}

function openLoad(programId: string | undefined, userId: string): number {
  const row = db
    .handle()
    .query(
      "SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND assignee_id = ? AND status IN ('claimed','assigned','waiting_for_helper','escalated','reopened')",
    )
    .get(programId, userId);
  return row ? Number((row as DbRow).n || 0) : 0;
}

function recentActivity(programId: string | undefined, userId: string): number | null {
  const row = db
    .handle()
    .query("SELECT MAX(created_at) AS at FROM ticket_events WHERE program_id = ? AND actor_id = ?")
    .get(programId, userId);
  return row ? Number((row as DbRow).at) : null;
}

function pingFatigue(programId: string | undefined, userId: string, now = Date.now()): Fatigue {
  const rows = db
    .handle()
    .query(
      `SELECT created_at, detail FROM ticket_events
      WHERE program_id = ? AND event_type = 'helper_assignment_offered' AND created_at >= ?
      ORDER BY created_at DESC`,
    )
    .all(programId, now - PING_FATIGUE_WINDOW_MS) as DbRow[];
  let count = 0;
  let lastPingAt = null;
  for (const row of rows) {
    let detail;
    try {
      detail = row.detail ? JSON.parse(String(row.detail)) : {};
    } catch (_) {
      detail = {};
    }
    if (detail.to !== userId) continue;
    count += 1;
    if (lastPingAt === null || Number(row.created_at) > lastPingAt) lastPingAt = Number(row.created_at);
  }
  return { count, lastPingAt };
}

function normalizeCategory(category: unknown): string | null {
  if (!category) return null;
  return String(category).trim().toLowerCase();
}

function matchBonus(
  expertise: ExpertiseRow[],
  tag: string | null,
): { match: ExpertiseRow; solved: number; replies: number; pts: number } | null {
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

function breadthBonus(expertise: ExpertiseRow[]): { total: number; pts: number } | null {
  const total = expertise.reduce((n, e) => n + e.solved_count, 0);
  if (total <= 0) return null;
  return { total, pts: Math.min(total, TOTAL_SOLVED_CAP) * TOTAL_SOLVED_WEIGHT };
}

function loadPenalty(load: number): number {
  return Math.min(load, LOAD_CAP) * LOAD_WEIGHT;
}

function isRecentlyActive(lastActiveAt: number | null, now: number): boolean {
  if (!lastActiveAt) return false;
  return now - lastActiveAt < RECENT_WINDOW_MS;
}

function hasRoleBonus(role: string): boolean {
  return role === "organizer" || role === "owner";
}

function scoreHelper(
  helper: HelperRow,
  ctx: ScoringContext = {},
): { userId: string; role: string; score: number; load: number; reasons: string[] } {
  const { tag = null, expertise = [], load = 0, lastActiveAt = null, fatigue = null, now = Date.now() } = ctx;
  const reasons = ["active program member"];
  let score = BASE_SCORE;

  const hit = matchBonus(expertise, tag);
  if (hit) {
    score += hit.pts;
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

  if (fatigue && fatigue.count > 0) {
    score -= Math.min(fatigue.count, PING_FATIGUE_CAP) * PING_FATIGUE_WEIGHT;
    reasons.push(`${fatigue.count} automated ping${fatigue.count === 1 ? "" : "s"} in the last 24h`);
    if (fatigue.lastPingAt !== null && now - fatigue.lastPingAt < PING_FATIGUE_RECENT_MS) {
      score -= PING_FATIGUE_RECENT_PENALTY;
      reasons.push("pinged within the last hour");
    }
  }

  return { userId: helper.user_id, role: helper.role, score: Number(score.toFixed(2)), load, reasons };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), MAX_RECOMMENDATIONS);
}

function botUserId() {
  try {
    return require("./config").config?.slack?.botUserId || null;
  } catch (_) {
    return null;
  }
}

function scoreWorkload(
  helper: HelperRow,
  load: number,
): { userId: string; role: string; score: number; load: number; reasons: string[] } {
  return {
    userId: helper.user_id,
    role: helper.role,
    score: Number((BASE_SCORE - loadPenalty(load)).toFixed(2)),
    load,
    reasons: [load === 0 ? "no open assigned tickets" : `${load} open assigned ticket${load === 1 ? "" : "s"}`],
  };
}

function recommend({
  programId,
  category = null,
  limit = 3,
  exclude = [],
  expertiseRouting = true,
  now = Date.now(),
}: {
  programId?: string;
  category?: string | null;
  limit?: number;
  exclude?: string[];
  expertiseRouting?: boolean;
  now?: number;
} = {}): Array<{ userId: string; role: string; score: number; load: number; reasons: string[] }> {
  const helpers = db.listHelpers(programId, true) as HelperRow[];
  if (helpers.length === 0) return [];
  const skip = new Set((exclude || []).filter(Boolean));
  const bot = botUserId();
  if (bot) skip.add(bot);
  const eligible = helpers.filter((h) => !skip.has(h.user_id) && h.ping_eligible !== 0);
  if (eligible.length === 0) return [];
  const tag = normalizeCategory(category);
  const baseOrder = new Map(helpers.map((h, i) => [h.user_id, i]));
  const ranked = eligible.map((h) => ({
    entry: expertiseRouting
      ? scoreHelper(h, {
          tag,
          expertise: getExpertise(programId, h.user_id),
          load: openLoad(programId, h.user_id),
          lastActiveAt: recentActivity(programId, h.user_id),
          fatigue: pingFatigue(programId, h.user_id, now),
          now,
        })
      : scoreWorkload(h, openLoad(programId, h.user_id)),
    rosterIndex: baseOrder.get(h.user_id) ?? 0,
  }));
  ranked.sort((a, b) => b.entry.score - a.entry.score || a.rosterIndex - b.rosterIndex);
  return ranked.slice(0, clampLimit(limit)).map((r) => r.entry);
}

export = {
  setExpertise,
  getExpertise,
  recordResolution,
  recordReply,
  openLoad,
  pingFatigue,
  recommend,
  scoreHelper,
  scoreWorkload,
};
