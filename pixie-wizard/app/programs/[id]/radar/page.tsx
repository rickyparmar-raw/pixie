import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreRadarList, coreHealthScore } from "@/lib/pixieCore";
import { PageHeader, SectionCard, MetricCard } from "@/app/_components/DashboardShell";
import { RadarRefreshButton, RadarSignalControls } from "./RadarControls";

interface RadarSignal {
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
}

interface HealthScore {
  score: number | null;
  label: string | null;
  components: Record<string, number> | null;
  windowDays: number;
}

const SEVERITY_ICON: Record<string, string> = { CRITICAL: "🔴", HIGH: "🔴", MEDIUM: "🟠", LOW: "🟡", INFO: "🟢" };
const PATTERN_TYPES = new Set(["FAQ_CLUSTER", "LOW_CONFIDENCE_TOPIC", "KNOWLEDGE_GAP"]);
const SYSTEM_TYPES = new Set(["SOURCE_FAILURE"]);

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function SignalCard({ programId, signal }: { programId: string; signal: RadarSignal }) {
  return (
    <li className="rounded-lg border border-line bg-panel p-4">
      <p className="flex items-center gap-2 font-heading text-xs uppercase tracking-[0.16em] text-text-muted">
        <span>{SEVERITY_ICON[signal.severity] ?? "⚪"}</span>
        <span>{signal.severity}</span>
        <span className="text-text-muted/60">· {signal.type.replaceAll("_", " ").toLowerCase()}</span>
        <span className="text-text-muted/60">· detected {timeAgo(signal.first_detected_at)}</span>
      </p>
      <p className="mt-2 text-sm text-text">{signal.title}</p>
      {signal.summary && <p className="mt-1 text-xs text-text-muted">{signal.summary}</p>}
      {signal.type === "INCIDENT_CANDIDATE" || signal.type === "ACTIVE_INCIDENT" ? (
        <Link href={`/programs/${programId}/incidents`} className="mt-2 inline-block text-xs text-brand underline">Review incident →</Link>
      ) : signal.type === "STALE_TICKETS" || signal.type === "REOPEN_SPIKE" || signal.type === "ESCALATION_SPIKE" ? (
        <Link href={`/programs/${programId}/tickets`} className="mt-2 inline-block text-xs text-brand underline">View tickets →</Link>
      ) : signal.type === "SOURCE_FAILURE" ? (
        <Link href={`/programs/${programId}/knowledge`} className="mt-2 inline-block text-xs text-brand underline">Inspect source →</Link>
      ) : signal.type === "FAQ_CLUSTER" || signal.type === "KNOWLEDGE_GAP" ? (
        <Link href={`/programs/${programId}/gaps`} className="mt-2 inline-block text-xs text-brand underline">Review gap →</Link>
      ) : null}
      <RadarSignalControls programId={programId} signalId={signal.id} status={signal.status} />
    </li>
  );
}

export default async function RadarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program } = await requireProgramMembership(id);

  let signals: RadarSignal[] = [];
  let health: HealthScore | null = null;
  let loadError: string | null = null;
  try {
    const [radarRes, healthRes] = await Promise.all([coreRadarList(id), coreHealthScore(id)]);
    signals = radarRes.signals as RadarSignal[];
    health = healthRes as unknown as HealthScore;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load Support Radar.";
  }

  const needsAttention = signals.filter((s) => (s.status === "active" || s.status === "acknowledged") && !PATTERN_TYPES.has(s.type) && !SYSTEM_TYPES.has(s.type));
  const patterns = signals.filter((s) => (s.status === "active" || s.status === "acknowledged") && PATTERN_TYPES.has(s.type));
  const systemHealth = signals.filter((s) => (s.status === "active" || s.status === "acknowledged") && SYSTEM_TYPES.has(s.type));
  const recentlyResolved = signals.filter((s) => s.status === "resolved").slice(0, 10);

  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>;
  for (const s of needsAttention) if (severityCounts[s.severity] !== undefined) severityCounts[s.severity] += 1;

  return (
    <main className="max-w-none px-0 py-0">
      <PageHeader
        eyebrow={`${program.program_name} · support radar`}
        title="What needs an organizer's attention right now"
        description="Every signal below is explainable from stored tickets, gaps, incidents, and source health — nothing is invented."
        actions={<RadarRefreshButton programId={id} />}
      />

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Critical" value={severityCounts.CRITICAL} tone={severityCounts.CRITICAL ? "text-brand" : "text-mint"} />
        <MetricCard label="High" value={severityCounts.HIGH} tone={severityCounts.HIGH ? "text-brand" : "text-mint"} />
        <MetricCard label="Medium" value={severityCounts.MEDIUM} tone={severityCounts.MEDIUM ? "text-tang" : "text-mint"} />
        <MetricCard label="Low" value={severityCounts.LOW} />
        <MetricCard
          label="Support health"
          value={health?.score ?? "—"}
          detail={health?.label ?? (health?.components ? `${health.windowDays}d window` : undefined)}
          tone={health?.score === null || health?.score === undefined ? "text-text-muted" : health.score >= 80 ? "text-mint" : health.score >= 60 ? "text-tang" : "text-brand"}
        />
      </div>

      {health?.components && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(health.components).map(([key, value]) => (
            <div key={key} className="pixie-panel px-4 py-3">
              <p className="text-[11px] text-text-muted">{key.replace(/([A-Z])/g, " $1").trim()}</p>
              <p className="mt-1 text-lg text-text">{value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 space-y-8">
        <SectionCard title="Needs attention" description="Sorted most severe first.">
          {needsAttention.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing needs attention right now.</p>
          ) : (
            <ul className="space-y-3">{needsAttention.map((s) => <SignalCard key={s.id} programId={id} signal={s} />)}</ul>
          )}
        </SectionCard>

        <SectionCard title="Emerging patterns" description="FAQ clusters, low-confidence topics, and knowledge gaps.">
          {patterns.length === 0 ? (
            <p className="text-sm text-text-muted">No emerging patterns detected.</p>
          ) : (
            <ul className="space-y-3">{patterns.map((s) => <SignalCard key={s.id} programId={id} signal={s} />)}</ul>
          )}
        </SectionCard>

        <SectionCard title="System health" description="Source refresh failures and sync issues.">
          {systemHealth.length === 0 ? (
            <p className="text-sm text-text-muted">All configured sources are refreshing normally.</p>
          ) : (
            <ul className="space-y-3">{systemHealth.map((s) => <SignalCard key={s.id} programId={id} signal={s} />)}</ul>
          )}
        </SectionCard>

        <SectionCard title="Recently resolved" description="Last 10 signals that cleared or were resolved.">
          {recentlyResolved.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing resolved yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentlyResolved.map((s) => (
                <li key={s.id} className="text-xs text-text-muted">
                  {SEVERITY_ICON[s.severity] ?? "⚪"} {s.title} — resolved {s.resolved_at ? timeAgo(s.resolved_at) : ""}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back</Link>
    </main>
  );
}
