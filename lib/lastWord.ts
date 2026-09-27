import db = require("./db");

interface ThreadRow {
  ts?: unknown;
  userId?: string | null;
  isBot?: boolean;
}

const LAST_WORD_QUIET_MS = 2 * 24 * 60 * 60 * 1000;

function everHelper(programId: string | null | undefined, userId: string | null): boolean {
  if (!programId || !userId) return false;
  try {
    const { isAdmin } = require("./config");
    if (isAdmin && isAdmin(userId)) return true;
  } catch (_) {}
  return (db.listHelpers(programId, false) as Array<{ user_id?: string }>).some((row) => row.user_id === userId);
}

function toMs(ts: unknown): number | null {
  const raw = Number(ts);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 1e11 ? Math.round(raw * 1000) : raw;
}

function helperLastWord({
  programId,
  requesterId,
  threadTs = null,
  rows = [],
  now = Date.now(),
}: { programId?: string; requesterId?: string; threadTs?: string | null; rows?: ThreadRow[]; now?: number } = {}): {
  helperId: string;
  at: number;
} | null {
  const humans = rows
    .filter((row): row is ThreadRow & { userId: string } =>
      Boolean(row && row.userId && !row.isBot && (threadTs === null || String(row.ts) !== String(threadTs))),
    )
    .map((row) => ({ ...row, at: toMs(row.ts) }))
    .filter((row): row is ThreadRow & { userId: string; at: number } => row.at !== null)
    .sort((a, b) => a.at - b.at);
  const last = humans.at(-1);
  if (!last || last.userId === requesterId) return null;
  if (!everHelper(programId, last.userId)) return null;
  if (now - last.at < LAST_WORD_QUIET_MS) return null;
  return { helperId: last.userId, at: last.at };
}

export = { helperLastWord, everHelper, LAST_WORD_QUIET_MS };
