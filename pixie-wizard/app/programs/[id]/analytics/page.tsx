import { requireProgramMembership } from "@/lib/programAccess";
import { coreAnalytics } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, Section, CoreError, SignalRail, MiniBar, BarList, EmptyState } from "@/app/_components/DashboardShell";
import { personaName, formatDuration } from "@/app/_components/format";
import { VolumeChart } from "@/app/_components/charts/VolumeChart";
import { OutcomeRings } from "@/app/_components/charts/OutcomeRings";
import { SharePie } from "@/app/_components/charts/SharePie";
import type { VolumeDay } from "@/lib/dashboardMetrics";

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
  daily: VolumeDay[];
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
        <PageHeader title="Analytics" description="Every figure is counted from stored tickets, never estimated." />
        <CoreError message={loadError ?? "Analytics are unavailable."} />
      </>
    );
  }

  const escalated = a.byStatus.escalated ?? 0;
  const resolved = a.byStatus.resolved ?? 0;
  const identities = await resolveIdentities([
    ...(a.helperLoad ?? []).map((h) => h.userId),
    ...(a.helperResolved ?? []).map((h) => h.userId),
  ]);

  // response-time comparison shares one scale
  const times: Array<[string, number | null]> = [
    ["First reply", a.medianFirstResponseMs],
    ["First human reply", a.medianFirstHumanResponseMs],
    ["Time to resolve", a.medianResolveMs],
  ];
  const timeMax = Math.max(1, ...times.map(([, v]) => v ?? 0));

  const helpers = mergeHelpers(a.helperLoad, a.helperResolved);
  const helperMax = Math.max(1, ...helpers.map((h) => h.open + h.resolved));

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Last 30 days. Every figure is counted from stored tickets, never estimated."
      />

      <div className="space-y-8">
        <Section title="Volume" description="Every question that arrived, and the share a person had to pick up.">
          <VolumeChart data={a.daily ?? []} aspectRatio="3 / 1" />
        </Section>

        <Section title="Signal" description="Each stage between a question arriving and a ticket closing.">
          <SignalRail
            stages={[
              { label: "Questions", value: a.created },
              { label: `${persona} answered`, value: a.aiAnswered, tone: "text-brand" },
              { label: "Needed a person", value: a.humanHandled, tone: "text-tang" },
              { label: "Escalated", value: escalated, tone: "text-tang" },
              { label: "Resolved", value: resolved, tone: "text-mint" },
            ]}
          />
          <p className="mt-6 border-t border-line pt-4 text-[13px] text-text-muted">
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

        <Section title="Outcomes" description="Three independent rates — each ring runs its own 0-100 track.">
          <OutcomeRings
            rates={[
              { label: "Deflection", pct: pct(a.deflectionRate), color: "var(--chart-1)", detail: "resolved with no person" },
              { label: "Reopened", pct: pct(a.reopenRate), color: "var(--chart-2)", detail: "came back after closing" },
              { label: "Duplicates", pct: pct(a.duplicateRate), color: "var(--chart-3)", detail: "already asked" },
            ]}
          />
          <p className="mt-7 border-t border-line pt-5 text-[13px] text-text-muted">
            <span className="font-mono text-sm text-text tabular-nums">{a.humanHandled}</span> of {a.created} handled by a person.
          </p>
        </Section>

        <Section title="What they asked about" description="Share of questions by category.">
          {a.byCategory.length === 0 ? (
            <EmptyState title="No categorised tickets yet." hint="Share appears once a question carries a category." />
          ) : (
            <SharePie
              shares={a.byCategory.map((c) => ({ label: c.category, value: c.n }))}
              centerLabel="Questions"
              unit="categorised questions"
            />
          )}
        </Section>

        <Section title="Helper workload" description="Open assigned, and resolved in the last 30 days.">
          {helpers.length === 0 ? (
            <EmptyState title="No helper activity yet." hint="Bars appear once a helper is assigned or resolves a ticket." />
          ) : (
            <ul className="divide-y divide-line">
              {helpers.map((h) => (
                <li
                  key={h.userId}
                  className="grid grid-cols-1 gap-x-4 gap-y-1.5 py-3 first:pt-0 last:pb-0 sm:grid-cols-[10rem_1fr_auto] sm:items-center"
                >
                  <span className="truncate text-[13px] text-text-muted">{labelFor(identities, h.userId)}</span>
                  <span className="flex h-1.5 overflow-hidden rounded-[1px] bg-line/60">
                    <span className="h-full bg-tang" style={{ width: `${(h.open / helperMax) * 100}%` }} />
                    <span className="h-full bg-mint" style={{ width: `${(h.resolved / helperMax) * 100}%` }} />
                  </span>
                  <span className="whitespace-nowrap text-right font-mono text-xs tabular-nums text-text-muted">
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

function pct(rate: number): number {
  return Math.round((rate ?? 0) * 100);
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
