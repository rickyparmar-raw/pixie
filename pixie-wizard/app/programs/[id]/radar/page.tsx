import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreRadarList, coreHealthScore } from "@/lib/pixieCore";
import { PageHeader, Section, MetricCard, CoreError } from "@/app/_components/DashboardShell";
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

const PATTERN_TYPES = new Set(["FAQ_CLUSTER", "LOW_CONFIDENCE_TOPIC", "KNOWLEDGE_GAP"]);
const SYSTEM_TYPES = new Set(["SOURCE_FAILURE"]);

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: "text-brand",
  HIGH: "text-brand",
  MEDIUM: "text-tang",
  LOW: "text-text-muted",
  INFO: "text-text-muted",
};

function timeAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function linkFor(signal: RadarSignal, programId: string): { href: string; label: string } | null {
  const t = signal.type;
  if (t === "INCIDENT_CANDIDATE" || t === "ACTIVE_INCIDENT") return { href: `/programs/${programId}/incidents`, label: "Review incident →" };
  if (t === "STALE_TICKETS" || t === "REOPEN_SPIKE" || t === "ESCALATION_SPIKE") return { href: `/programs/${programId}/tickets`, label: "View tickets →" };
  if (t === "SOURCE_FAILURE") return { href: `/programs/${programId}/knowledge`, label: "Inspect source →" };
  if (t === "FAQ_CLUSTER" || t === "KNOWLEDGE_GAP") return { href: `/programs/${programId}/gaps`, label: "Review gap →" };
  return null;
}

function SignalRow({ programId, signal }: { programId: string; signal: RadarSignal }) {
  const link = linkFor(signal, programId);
  return (
    <li className="py-4">
      <p className="text-xs text-text-muted">
        <span className={SEVERITY_TONE[signal.severity] ?? "text-text-muted"}>{signal.severity}</span>
        {" · "}
        {signal.type.replaceAll("_", " ").toLowerCase()}
        {" · detected "}
        {timeAgo(signal.first_detected_at)}
      </p>
      <p className="mt-1 text-sm text-text">{signal.title}</p>
      {signal.summary && <p className="mt-0.5 text-xs text-text-muted">{signal.summary}</p>}
      {link && (
        <Link href={link.href} className="mt-1 inline-block text-xs text-text-muted hover:text-text">
          {link.label}
        </Link>
      )}
      <RadarSignalControls programId={programId} signalId={signal.id} status={signal.status} />
    </li>
  );
}

function SignalGroup({ programId, title, description, signals, empty }: {
  programId: string;
  title: string;
  description?: string;
  signals: RadarSignal[];
  empty: string;
}) {
  return (
    <Section title={title} description={description}>
      {signals.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {signals.map((s) => <SignalRow key={s.id} programId={programId} signal={s} />)}
        </ul>
      )}
    </Section>
  );
}

export default async function RadarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

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

  const live = (s: RadarSignal) => s.status === "active" || s.status === "acknowledged";
  const needsAttention = signals.filter((s) => live(s) && !PATTERN_TYPES.has(s.type) && !SYSTEM_TYPES.has(s.type));
  const patterns = signals.filter((s) => live(s) && PATTERN_TYPES.has(s.type));
  const systemHealth = signals.filter((s) => live(s) && SYSTEM_TYPES.has(s.type));
  const recentlyResolved = signals.filter((s) => s.status === "resolved").slice(0, 10);

  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>;
  for (const s of needsAttention) if (severityCounts[s.severity] !== undefined) severityCounts[s.severity] += 1;

  const healthTone =
    health?.score == null ? "text-text-muted" : health.score >= 80 ? "text-mint" : health.score >= 60 ? "text-tang" : "text-brand";

  return (
    <>
      <PageHeader
        title="Support radar"
        description="Signals derived from tickets, gaps, incidents and source health."
        actions={<RadarRefreshButton programId={id} />}
      />

      {loadError && <CoreError message={loadError} />}

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard label="Critical" value={severityCounts.CRITICAL} tone={severityCounts.CRITICAL ? "text-brand" : "text-text"} />
        <MetricCard label="High" value={severityCounts.HIGH} tone={severityCounts.HIGH ? "text-brand" : "text-text"} />
        <MetricCard label="Medium" value={severityCounts.MEDIUM} tone={severityCounts.MEDIUM ? "text-tang" : "text-text"} />
        <MetricCard label="Low" value={severityCounts.LOW} />
        <MetricCard
          label="Support health"
          value={health?.score ?? "—"}
          detail={health?.label ?? (health?.components ? `${health.windowDays}d window` : undefined)}
          tone={healthTone}
        />
      </div>

      {health?.components && (
        <ul className="mt-8 max-w-sm">
          {Object.entries(health.components).map(([key, value]) => (
            <li key={key} className="flex justify-between gap-4 py-1 text-sm">
              <span className="text-text-muted">{key.replace(/([A-Z])/g, " $1").trim()}</span>
              <span className="tabular-nums text-text">{value}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-12 space-y-12">
        <SignalGroup programId={id} title="Needs attention" description="Most severe first." signals={needsAttention} empty="Nothing needs attention right now." />
        <SignalGroup programId={id} title="Emerging patterns" description="FAQ clusters, low-confidence topics and knowledge gaps." signals={patterns} empty="No emerging patterns detected." />
        <SignalGroup programId={id} title="System health" description="Source refresh failures and sync issues." signals={systemHealth} empty="All configured sources are refreshing normally." />

        <Section title="Recently resolved">
          {recentlyResolved.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing resolved yet.</p>
          ) : (
            <ul className="space-y-1.5 text-xs text-text-muted">
              {recentlyResolved.map((s) => (
                <li key={s.id}>
                  <span className={SEVERITY_TONE[s.severity] ?? "text-text-muted"}>{s.severity}</span> · {s.title}
                  {s.resolved_at ? ` · resolved ${timeAgo(s.resolved_at)}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
