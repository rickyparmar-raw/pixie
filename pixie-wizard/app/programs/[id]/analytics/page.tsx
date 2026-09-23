import { requireProgramMembership } from "@/lib/programAccess";
import { coreDashboardMetrics, type DashboardMetrics } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, Section, CoreError, SignalRail, MiniBar, BarList, EmptyState } from "@/app/_components/DashboardShell";
import { personaName, formatDuration } from "@/app/_components/format";
import { VolumeChart } from "@/app/_components/charts/VolumeChart";
import { OutcomeRings } from "@/app/_components/charts/OutcomeRings";
import { SharePie } from "@/app/_components/charts/SharePie";

// Every figure is Core-counted from stored tickets/ticket_events/metrics
// rows (lib/web/dashboardApi.js metricsOverview) — never estimated, scoped
// to this program's window.
export default async function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program } = await requireProgramMembership(id);
  const persona = personaName(program);

  let m: DashboardMetrics | null = null;
  let loadError: string | null = null;
  try {
    m = await coreDashboardMetrics(id, 30);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Analytics are unavailable.";
  }

  if (loadError || !m) {
    return (
      <>
        <PageHeader title="Analytics" description="Every figure is counted from stored tickets, never estimated." />
        <CoreError message={loadError ?? "Analytics are unavailable."} />
      </>
    );
  }

  const identities = await resolveIdentities((m.helpers ?? []).map((h) => h.userId));

  // Response-time comparison shares one scale.
  const times: Array<[string, number | null]> = [
    ["First reply · median", m.firstResponse.medianMs],
    ["First reply · average", m.firstResponse.averageMs],
    ["Time to resolve · median", m.resolution.medianMs],
    ["Time to resolve · average", m.resolution.averageMs],
  ];
  const timeMax = Math.max(1, ...times.map(([, v]) => v ?? 0));

  const helperMax = Math.max(1, ...m.helpers.map((h) => h.openAssigned + h.resolved));
  const blockPct = m.grounding.blockRate === null ? 0 : Math.round(m.grounding.blockRate * 100);
  const answerTotal = m.answers.pixieAnswered + m.answers.humanHandled;

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`Last ${m.windowDays} days. Every figure is counted from stored tickets, never estimated.`}
      />

      <div className="space-y-12">
        <Section title="Volume" description="Every question that arrived, and where it sits now.">
          <VolumeChart data={m.volumeByDay ?? []} aspectRatio="3 / 1" />
          <div className="mt-8 border-t border-line pt-7">
          <SignalRail
            stages={[
              { label: "Questions", value: m.created },
              { label: "Open now", value: m.openTickets },
              { label: "Waiting for helper", value: m.waitingForHelper, tone: "text-tang" },
              { label: `${persona} answered`, value: m.answers.pixieAnswered },
              { label: "Needed a person", value: m.answers.humanHandled, tone: "text-brand" },
            ]}
          />
          </div>
        </Section>

        <Section title="Response time" description="Median and average, per stage of the handoff.">
          <BarList>
            {times.map(([label, v]) => (
              <MiniBar key={label} label={label} value={v ?? 0} max={timeMax} tone="bg-text-muted" display={formatDuration(v)} />
            ))}
          </BarList>
          <p className="mt-5 text-xs text-text-muted">
            {m.firstResponse.n} answered · {m.resolution.n} resolved in window.
          </p>
        </Section>

        <Section title="Who answered" description="Share of questions Pixie carried alone vs handed to a person.">
          {answerTotal === 0 ? (
            <EmptyState title="No answered questions yet." />
          ) : (
            <SharePie
              shares={[
                { label: `${persona} answered`, value: m.answers.pixieAnswered },
                { label: "Human handled", value: m.answers.humanHandled },
              ]}
              centerLabel="Answers"
              unit="answered questions"
            />
          )}
        </Section>

        <Section
          title="Grounding blocks"
          description="Replies Pixie withheld for lack of grounded docs — silent ungrounded/gap rows plus Jev-permitted generations the grounding gate rejected."
        >
          <OutcomeRings
            rates={[
              { label: "Blocked", pct: blockPct, color: "var(--chart-2)", detail: `${m.grounding.blocked} of ${m.grounding.blocked + m.grounding.answered} replies` },
            ]}
          />
          {Object.keys(m.grounding.byReason).length > 0 && (
            <ul className="mt-7 space-y-1.5 border-t border-line pt-5 font-mono text-xs text-text-muted">
              {Object.entries(m.grounding.byReason)
                .sort(([, a], [, b]) => b - a)
                .map(([reason, n]) => (
                  <li key={reason} className="flex justify-between gap-4">
                    <span>{reason}</span>
                    <span className="tabular-nums">{n}</span>
                  </li>
                ))}
            </ul>
          )}
        </Section>

        <Section title="Helper workload" description="Open assigned, and resolved in window.">
          {m.helpers.length === 0 ? (
            <EmptyState title="No helper activity yet." />
          ) : (
            <ul className="space-y-3">
              {m.helpers.map((h) => (
                <li key={h.userId} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate text-xs text-text-muted">{labelFor(identities, h.userId)}</span>
                  <span className="flex h-1.5 overflow-hidden rounded-full bg-line/50">
                    <span className="bg-tang" style={{ width: `${(h.openAssigned / helperMax) * 100}%` }} />
                    <span className="bg-mint" style={{ width: `${(h.resolved / helperMax) * 100}%` }} />
                  </span>
                  <span className="font-mono text-xs tabular-nums text-text-muted">
                    <span className="text-tang">{h.openAssigned}</span> open · <span className="text-mint">{h.resolved}</span> resolved
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
