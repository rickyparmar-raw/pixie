import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreRadarList, coreHealthScore } from "@/lib/pixieCore";
import {
  BarList,
  Chip,
  CoreError,
  EmptyState,
  MiniBar,
  Notice,
  PageHeader,
  Section,
} from "@/app/_components/DashboardShell";
import { IconChevronRight, IconGauge } from "@/app/_components/icons";
import { timeAgo } from "@/app/_components/format";
import { RadarRefreshButton, RadarSignalControls } from "./RadarControls";

type RadarSignal = {
  id: number;
  type: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "active" | "acknowledged" | "resolved" | "suppressed";
  title: string;
  summary: string | null;
  evidence: Record<string, unknown> | null;
  first_detected_at: number;
  last_detected_at: number;
  resolved_at: number | null;
};

type HealthScore = {
  score: number | null;
  label: string | null;
  components: Record<string, number> | null;
  windowDays: number;
};

// Lime is never a severity here. A critical or high signal is the page's
// failure state, so it wears danger; medium is tang, the rest stay quiet.
const SEV_TONE: Record<string, string> = {
  CRITICAL: "text-danger",
  HIGH: "text-danger",
  MEDIUM: "text-tang",
  LOW: "text-text-muted",
  INFO: "text-text-muted",
};
// The same four severities as a square marker, for the count cells where the
// label is muted and cannot lend the marker its colour.
const SEV_MARK: Record<string, string> = {
  CRITICAL: "bg-danger",
  HIGH: "bg-danger",
  MEDIUM: "bg-tang",
  LOW: "bg-text-muted",
  INFO: "bg-text-muted",
};
const SEV_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const LIVE_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

// "sourceHealth" -> "source health", "FAQCoverage" -> "faq coverage". Core
// sends camelCase component keys; a space before the capital alone would read
// as "source Health".
function componentLabel(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function linkFor(t: string, programId: string): { href: string; label: string } | null {
  if (t === "INCIDENT_CANDIDATE" || t === "ACTIVE_INCIDENT") return { href: `/programs/${programId}/incidents`, label: "incident" };
  if (t === "STALE_TICKETS" || t === "REOPEN_SPIKE" || t === "ESCALATION_SPIKE") return { href: `/programs/${programId}/tickets`, label: "tickets" };
  if (t === "SOURCE_FAILURE") return { href: `/programs/${programId}/knowledge`, label: "knowledge" };
  if (t === "FAQ_CLUSTER" || t === "KNOWLEDGE_GAP") return { href: `/programs/${programId}/gaps`, label: "gaps" };
  return null;
}

function SignalRow({ programId, s }: { programId: string; s: RadarSignal }) {
  const link = linkFor(s.type, programId);
  return (
    <li className="grid items-start gap-x-4 gap-y-2 py-4 sm:grid-cols-[4.5rem_6rem_1fr]">
      <span className="font-mono text-xs text-text-muted">{timeAgo(s.first_detected_at)}</span>
      <span
        className={`inline-flex items-center gap-1.5 font-mono text-xs ${SEV_TONE[s.severity] ?? "text-text-muted"}`}
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-[1px] bg-current" />
        {s.severity}
      </span>
      <div className="min-w-0">
        <p className="text-sm text-text">{s.title}</p>
        {s.summary && <p className="mt-0.5 text-xs text-text-muted">{s.summary}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Chip>{s.type.replaceAll("_", " ").toLowerCase()}</Chip>
          {link && (
            <Link
              href={link.href}
              className="inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text"
            >
              {link.label}
              <IconChevronRight size={16} className="shrink-0" />
            </Link>
          )}
          <RadarSignalControls programId={programId} signalId={s.id} status={s.status} />
        </div>
      </div>
    </li>
  );
}

export default async function RadarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  const [radarR, healthR] = await Promise.allSettled([coreRadarList(id), coreHealthScore(id)]);
  const loadError =
    radarR.status === "rejected"
      ? radarR.reason instanceof Error
        ? radarR.reason.message
        : "Support radar is unavailable."
      : null;
  const healthError = healthR.status === "rejected";

  const signals = radarR.status === "fulfilled" ? (radarR.value.signals as RadarSignal[]) : [];
  const health = healthR.status === "fulfilled" ? (healthR.value as unknown as HealthScore) : null;

  const live = signals
    .filter((s) => s.status === "active" || s.status === "acknowledged")
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.first_detected_at - a.first_detected_at);
  const resolvedRecently = signals.filter((s) => s.status === "resolved").slice(0, 8);

  const sev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>;
  for (const s of live) if (sev[s.severity] !== undefined) sev[s.severity] += 1;

  const healthTone =
    health?.score == null ? "text-text-muted" : health.score >= 80 ? "text-mint" : health.score >= 60 ? "text-tang" : "text-danger";
  const compMax = health?.components ? Math.max(1, ...Object.values(health.components)) : 1;

  return (
    <>
      <PageHeader
        title="Support radar"
        description="Signals derived from tickets, gaps, incidents and source health. Nothing here posts to Slack."
        actions={<RadarRefreshButton programId={id} />}
      />

      {loadError && <CoreError message={loadError} />}
      {healthError && (
        <Notice tone="warn" title="Support health is unavailable">
          Pixie Core did not return a health score, so the components below are missing too. The signal list is unaffected.
        </Notice>
      )}

      <div className="space-y-8">
        {/* One instrument, not two cards: the score is a single number, so the
            four live-signal counts read as the same instrument's other reading.
            A hairline divides them instead of a second panel, which used to
            leave a third of the row empty. */}
        <div className="pixie-panel p-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,15rem)_1fr] lg:items-center lg:gap-8">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className={`grid size-7 shrink-0 place-items-center rounded-[2px] bg-panel-2 ${healthTone}`}>
                  <IconGauge size={16} />
                </span>
                <p className="text-[12px] text-text-muted">Support health</p>
              </div>
              <p className="mt-3.5 flex flex-wrap items-baseline gap-x-3 font-mono text-[28px] leading-none tabular-nums">
                <span className={healthTone}>{health?.score ?? "—"}</span>
                {health?.label ? (
                  <span className="font-sans text-[13px] text-text-muted">{health.label}</span>
                ) : null}
              </p>
            </div>
            <div className="min-w-0 border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
              <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
                <span className="pixie-mark" aria-hidden="true" />
                Live by severity
              </p>
              <ul className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                {LIVE_SEVERITIES.map((k) => (
                  <li key={k} className="min-w-0">
                    <p className={`font-mono text-[24px] leading-none tabular-nums ${sev[k] ? SEV_TONE[k] : "text-text-muted/50"}`}>
                      {sev[k]}
                    </p>
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                      <span
                        aria-hidden
                        className={`size-1.5 shrink-0 rounded-[1px] ${sev[k] ? SEV_MARK[k] : "bg-line-strong"}`}
                      />
                      <span className="truncate">{k.toLowerCase()}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {health?.components && (
          <Section title="Health components" description={`${health.windowDays}-day window. Each component is scored 0–100.`}>
            <BarList>
              {Object.entries(health.components).map(([k, v]) => (
                <MiniBar
                  key={k}
                  label={componentLabel(k)}
                  value={v}
                  max={compMax}
                  tone={v >= 80 ? "bg-mint" : v >= 60 ? "bg-tang" : "bg-danger"}
                />
              ))}
            </BarList>
          </Section>
        )}

        <Section title={`Active signals${live.length ? ` · ${live.length}` : ""}`}>
          {live.length === 0 && !loadError ? (
            <EmptyState
              title="Nothing on the radar."
              hint="Escalation spikes, stale tickets, FAQ clusters and source failures surface here."
            />
          ) : (
            <ul className="pixie-panel divide-y divide-line px-5">
              {live.map((s) => (
                <SignalRow key={s.id} programId={id} s={s} />
              ))}
            </ul>
          )}
        </Section>

        {resolvedRecently.length > 0 && (
          <Section title="Recently cleared">
            <ul className="pixie-panel divide-y divide-line px-5">
              {resolvedRecently.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-3 font-mono text-xs">
                  <span className={`inline-flex items-center gap-1.5 ${SEV_TONE[s.severity] ?? "text-text-muted"}`}>
                    <span aria-hidden className="size-1.5 shrink-0 rounded-[1px] bg-current" />
                    {s.severity}
                  </span>
                  <span className="text-text-muted">·</span>
                  <span className="text-text">{s.title}</span>
                  {s.resolved_at && <span className="text-text-muted">· {timeAgo(s.resolved_at)}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </>
  );
}
