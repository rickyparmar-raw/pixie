// Small display helpers shared across dashboard pages. Pure functions, no
// React — safe to import from server components and route handlers alike.
import type { HostedProgramRow } from "@/lib/types";

// The program's support identity, used wherever the UI would otherwise say
// "AI" — the program's own support name, or "Pixie" when it hasn't set one.
export function personaName(program: Pick<HostedProgramRow, "support_name"> | null | undefined): string {
  const name = program?.support_name?.trim();
  return name && name.length > 0 ? name : "Pixie";
}

// A millisecond duration as a short operational string: "8s", "42m", "3h",
// "2d". Non-finite input renders as an em-dash placeholder.
export function formatDuration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

// Time elapsed since an absolute epoch-ms timestamp: "42m", "3h", "2d".
export function timeAgo(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return formatDuration(Date.now() - ms);
}

// A Slack user id as a compact operational label: "@U0ABC123". The list
// views don't resolve display names (that would be one Core call per row);
// the ticket detail page resolves the handful it shows.
export function userLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return id.startsWith("@") ? id : `@${id}`;
}

// Absolute epoch-ms as "14:32" (today) or "Apr 3, 14:32".
export function shortTime(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
