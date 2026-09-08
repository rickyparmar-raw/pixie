import { requireProgramMembership } from "@/lib/programAccess";
import { coreAnalytics } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError, SignalRail, MiniBar, BarList, EmptyState } from "@/app/_components/DashboardShell";
import { personaName, formatDuration, userLabel } from "@/app/_components/format";

type Analytics = {
  created: number;
  aiAnswered: number;
  humanHandled: number;
  deflected: number;
  deflectionRate: number;
  reopened: number;
  reopenRate: number;
  duplicates: number;
  duplicateRate: number;
  byStatus: Record<string, number>;
  byCategory: Array<{ category: string; n: number }>;
  helperLoad: Array<{ userId: string; openAssigned: number }>;
  helperResolved: Array<{ userId: string; resolved: number }>;
  medianFirstResponseMs: number | null;
  medianFirstHumanResponseMs: number | null;
  medianResolveMs: number | null;
  stale48h: number;
};

export default async function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program } = await requireProgramMembership(id);
  const persona = personaName(program);

  let a: Analytics | null = null;
  let loadError: string | null = null;
  try {
    a = (await coreAnalytics(id, 30)) as unknown as Analytics;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Analytics are unavailable.";
  }

  if (loadError || !a) {
    return (
      <>
        <PageHeader title="Analytics" description="Deterministic — every figure is counted from stored tickets, never estimated." />
        <CoreError message={loadError ?? "Analytics are unavailable."} />
      </>
    );
  }

  const escalated = a.byStatus.escalated ?? 0;
  const resolved = a.byStatus.resolved ?? 0;

  // response-time comparison shares one scale
  const times: Array<[string, number | null]> = [
    ["First reply", a.medianFirstResponseMs],
    ["First human reply", a.medianFirstHumanResponseMs],
    ["Time to resolve", a.medianResolveMs],
  ];
  const timeMax = Math.max(1, ...times.map(([, v]) => v ?? 0));

  const catMax = Math.max(1, ...a.byCategory.map((c) => c.n));

  const helpers = mergeHelpers(a.helperLoad, a.helperResolved);
  const helperMax = Math.max(1, ...helpers.map((h) => h.open + h.resolved));

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Last 30 days. Every figure is counted from stored tickets, never estimated."
      />

      <div className="space-y-12">
        <Section title="Volume">
          <SignalRail
            stages={[
              { label: "Questions", value: a.created },
              { label: `${persona} answered`, value: a.aiAnswered },
              { label: "Needed a person", value: a.humanHandled, tone: "text-tang" },
              { label: "Escalated", value: escalated, tone: "text-brand" },
              { label: "Resolved", value: resolved, tone: "text-mint" },
            ]}
          />
          <p className="mt-5 text-xs text-text-muted">
            {Math.round(a.deflectionRate * 100)}% of resolved tickets never needed a person.{" "}
            {a.stale48h > 0 && `${a.stale48h} open past 48h.`}
          </p>
        </Section>

        <Section title="Response time" description="Median, per stage of the handoff.">
          <BarList>
            {times.map(([label, v]) => (
              <MiniBar key={label} label={label} value={v ?? 0} max={timeMax} tone="bg-text-muted" display={formatDuration(v)} />
            ))}
          </BarList>
        </Section>

        <Section title="Outcomes">
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <Rate label="Deflection" value={a.deflectionRate} tone="text-mint" />
            <Rate label="Reopened" value={a.reopenRate} tone={a.reopenRate > 0.1 ? "text-tang" : "text-text"} />
            <Rate label="Duplicates" value={a.duplicateRate} />
            <div>
              <p className="font-mono text-xl tabular-nums text-text">{a.humanHandled}</p>
              <p className="mt-1 text-xs text-text-muted">Handled by a person</p>
            </div>
          </div>
        </Section>

        <Section title="By category">
          {a.byCategory.length === 0 ? (
            <EmptyState title="No categorised tickets yet." />
          ) : (
            <BarList>
              {a.byCategory.map((c) => (
                <MiniBar key={c.category} label={c.category} value={c.n} max={catMax} tone="bg-text-muted" />
              ))}
            </BarList>
          )}
        </Section>

        <Section title="Helper workload" description="Open assigned, and resolved in the last 30 days.">
          {helpers.length === 0 ? (
            <EmptyState title="No helper activity yet." />
          ) : (
            <ul className="space-y-3">
              {helpers.map((h) => (
                <li key={h.userId} className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate font-mono text-xs text-text-muted">{userLabel(h.userId)}</span>
                  <span className="flex h-1.5 overflow-hidden rounded-full bg-line/50">
                    <span className="bg-tang" style={{ width: `${(h.open / helperMax) * 100}%` }} />
                    <span className="bg-mint" style={{ width: `${(h.resolved / helperMax) * 100}%` }} />
                  </span>
                  <span className="font-mono text-xs tabular-nums text-text-muted">
                    <span className="text-tang">{h.open}</span> open · <span className="text-mint">{h.resolved}</span> resolved
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function Rate({ label, value, tone = "text-text" }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <p className={`font-mono text-xl tabular-nums ${tone}`}>{Math.round((value ?? 0) * 100)}%</p>
      <p className="mt-1 text-xs text-text-muted">{label}</p>
    </div>
  );
}

function mergeHelpers(
  load: Array<{ userId: string; openAssigned: number }>,
  resolved: Array<{ userId: string; resolved: number }>,
): Array<{ userId: string; open: number; resolved: number }> {
  const map = new Map<string, { userId: string; open: number; resolved: number }>();
  for (const l of load) map.set(l.userId, { userId: l.userId, open: l.openAssigned, resolved: 0 });
  for (const r of resolved) {
    const e = map.get(r.userId) ?? { userId: r.userId, open: 0, resolved: 0 };
    e.resolved = r.resolved;
    map.set(r.userId, e);
  }
  return [...map.values()].sort((x, y) => y.open + y.resolved - (x.open + x.resolved));
}
