import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreRadarList, coreHealthScore } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError, MiniBar, BarList, EmptyState } from "@/app/_components/DashboardShell";
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

const SEV_TONE: Record<string, string> = {
  CRITICAL: "text-brand",
  HIGH: "text-brand",
  MEDIUM: "text-tang",
  LOW: "text-text-muted",
  INFO: "text-text-muted/70",
};
const SEV_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

function linkFor(t: string, programId: string): { href: string; label: string } | null {
  if (t === "INCIDENT_CANDIDATE" || t === "ACTIVE_INCIDENT") return { href: `/programs/${programId}/incidents`, label: "incident →" };
  if (t === "STALE_TICKETS" || t === "REOPEN_SPIKE" || t === "ESCALATION_SPIKE") return { href: `/programs/${programId}/tickets`, label: "tickets →" };
  if (t === "SOURCE_FAILURE") return { href: `/programs/${programId}/knowledge`, label: "knowledge →" };
  if (t === "FAQ_CLUSTER" || t === "KNOWLEDGE_GAP") return { href: `/programs/${programId}/gaps`, label: "gaps →" };
  return null;
}

function SignalRow({ programId, s }: { programId: string; s: RadarSignal }) {
  const link = linkFor(s.type, programId);
  return (
    <li className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[4.5rem_6rem_1fr]">
      <span className="font-mono text-xs text-text-muted">{timeAgo(s.first_detected_at)}</span>
      <span className={`font-mono text-xs ${SEV_TONE[s.severity] ?? "text-text-muted"}`}>{s.severity}</span>
      <div className="min-w-0">
        <p className="text-sm text-text">{s.title}</p>
        {s.summary && <p className="mt-0.5 text-xs text-text-muted">{s.summary}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[11px] text-text-muted/70">{s.type.replaceAll("_", " ").toLowerCase()}</span>
          {link && (
            <Link href={link.href} className="font-mono text-[11px] text-text-muted hover:text-text">
              {link.label}
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

  const signals = radarR.status === "fulfilled" ? (radarR.value.signals as RadarSignal[]) : [];
  const health = healthR.status === "fulfilled" ? (healthR.value as unknown as HealthScore) : null;

  const live = signals
    .filter((s) => s.status === "active" || s.status === "acknowledged")
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.first_detected_at - a.first_detected_at);
  const resolvedRecently = signals.filter((s) => s.status === "resolved").slice(0, 8);

  const sev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>;
  for (const s of live) if (sev[s.severity] !== undefined) sev[s.severity] += 1;

  const healthTone =
    health?.score == null ? "text-text-muted" : health.score >= 80 ? "text-mint" : health.score >= 60 ? "text-tang" : "text-brand";
  const compMax = health?.components ? Math.max(1, ...Object.values(health.components)) : 1;

  return (
    <>
      <PageHeader
        title="Radar"
        description="Signals derived from tickets, gaps, incidents and source health. Nothing here posts to Slack."
        actions={<RadarRefreshButton programId={id} />}
      />

      {loadError && <CoreError message={loadError} />}

      {/* status line */}
      <div className="mb-10 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className={`font-mono text-2xl tabular-nums ${healthTone}`}>{health?.score ?? "—"}</p>
          <p className="mt-1 text-xs text-text-muted">Support health{health?.label ? ` · ${health.label}` : ""}</p>
        </div>
        <div className="flex gap-6 font-mono text-xs">
          {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((k) => (
            <span key={k} className={sev[k] ? SEV_TONE[k] : "text-text-muted/50"}>
              {sev[k]} {k.toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      {health?.components && (
        <Section title="Health components" description={`${health.windowDays}-day window.`}>
          <BarList>
            {Object.entries(health.components).map(([k, v]) => (
              <MiniBar
                key={k}
                label={k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim()}
                value={v}
                max={compMax}
                tone={v >= 80 ? "bg-mint" : v >= 60 ? "bg-tang" : "bg-brand"}
              />
            ))}
          </BarList>
        </Section>
      )}

      <div className="mt-12 space-y-4">
        <h2 className="text-sm font-medium text-text">Active signals{live.length ? ` · ${live.length}` : ""}</h2>
        {live.length === 0 && !loadError ? (
          <EmptyState title="Nothing on the radar." hint="Escalation spikes, stale tickets, FAQ clusters and source failures surface here." />
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {live.map((s) => (
              <SignalRow key={s.id} programId={id} s={s} />
            ))}
          </ul>
        )}
      </div>

      {resolvedRecently.length > 0 && (
        <Section title="Recently cleared">
          <ul className="space-y-1.5 font-mono text-xs text-text-muted">
            {resolvedRecently.map((s) => (
              <li key={s.id}>
                <span className={SEV_TONE[s.severity]}>{s.severity}</span> · {s.title}
                {s.resolved_at ? ` · ${timeAgo(s.resolved_at)}` : ""}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
