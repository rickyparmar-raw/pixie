import Link from "next/link";
import { DashboardShell, PageHeader, Section, MetricCard, StatusBadge } from "@/app/_components/DashboardShell";
import { VolumeChart } from "@/app/_components/charts/VolumeChart";
import { SharePie } from "@/app/_components/charts/SharePie";
import { requireWizardSuperadmin } from "@/lib/programAccess";
import { listHostedProgramsForOwner } from "@/lib/hostedPrograms";
import { coreAnalytics } from "@/lib/pixieCore";
import { summarizeAnalytics, mergeDailySeries, type AnalyticsSnapshot } from "@/lib/dashboardMetrics";

function percent(value: number, total: number): string {
  return total ? `${Math.round((value / total) * 100)}%` : "0%";
}

// Cross-program view — superadmin-only. Anyone else only ever needs the one
// program they actually work on; see requireWizardSuperadmin.
export default async function OverviewPage() {
  const session = await requireWizardSuperadmin();

  const programs = await listHostedProgramsForOwner(session).catch(() => []);
  const snapshots = (
    await Promise.all(
      programs.map(async (program) => {
        try {
          return (await coreAnalytics(program.id, 30)) as unknown as AnalyticsSnapshot;
        } catch {
          return null;
        }
      }),
    )
  ).filter((value): value is AnalyticsSnapshot => value !== null);
  const totals = summarizeAnalytics(snapshots);
  const timeline = mergeDailySeries(snapshots);

  const nameFor = (programId: string) =>
    programs.find((program) => program.id === programId)?.program_name ?? programId;

  const volumeByProgram = snapshots.map((snapshot) => ({
    label: nameFor(snapshot.programId),
    value: snapshot.created,
  }));

  // Disjoint by construction — the daily series splits each question by who
  // ended up answering it, so these three sum to the total. The top-level
  // aiAnswered/humanHandled counters overlap and cannot be used here.
  const pixieHandled = timeline.reduce((sum, day) => sum + day.aiOnly, 0);
  const neededPerson = timeline.reduce((sum, day) => sum + day.human, 0);
  const handling = [
    { label: "Pixie handled it", value: pixieHandled },
    { label: "Needed a person", value: neededPerson },
    { label: "No reply yet", value: Math.max(0, totals.questions - pixieHandled - neededPerson) },
  ];

  return (
    <DashboardShell>
      <PageHeader title="Overview" description="Last 30 days across every program you own." />

      <div className="space-y-11">
        <Section bordered title="Question volume" description={`Every question across ${programs.length} ${programs.length === 1 ? "program" : "programs"}, by the day it arrived.`}>
          <VolumeChart data={timeline} aspectRatio="4 / 1" />
        </Section>

        <Section title="Totals">
          <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">
            <MetricCard label="Questions" value={totals.questions} />
            <MetricCard label="AI answered" value={totals.aiAnswered} detail={`${percent(totals.aiAnswered, totals.questions)} of questions`} />
            <MetricCard label="Escalated" value={totals.escalated} detail={`${percent(totals.escalated, totals.questions)} of questions`} tone="text-brand" />
            <MetricCard label="Open tickets" value={totals.openTickets} detail={`${totals.stale} stale 48h+`} tone="text-tang" />
            <MetricCard label="Resolved" value={totals.resolved} />
            <MetricCard label="FAQ gaps" value={totals.faqGaps} tone="text-tang" />
            <MetricCard label="Active incidents" value={totals.activeIncidents} tone={totals.activeIncidents ? "text-brand" : "text-mint"} />
            <MetricCard label="Programs" value={programs.length} />
          </div>
        </Section>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Section bordered title="Where the questions came from" description="Share of volume by program.">
            <SharePie shares={volumeByProgram} centerLabel="Questions" unit="questions" />
          </Section>

          <Section bordered title="Who answered them" description="Each question counted once, by who replied first.">
            <SharePie shares={handling} centerLabel="Questions" unit="questions" />
          </Section>
        </div>

        <Section bordered title="By program">
          {programs.length === 0 ? (
            <p className="text-sm text-text-muted">No hosted programs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr className="border-b border-line">
                    <th className="pb-2 font-normal">Program</th>
                    <th className="pb-2 font-normal">Status</th>
                    <th className="pb-2 text-right font-normal">Questions</th>
                    <th className="pb-2 font-normal">AI answer rate</th>
                    <th className="pb-2 text-right font-normal">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {programs.map((program) => {
                    const row = snapshots.find((snapshot) => snapshot.programId === program.id);
                    const open = row
                      ? Object.entries(row.byStatus)
                          .filter(([status]) => status !== "resolved")
                          .reduce((sum, [, count]) => sum + count, 0)
                      : 0;
                    const rate = row && row.created ? row.aiAnswered / row.created : null;
                    return (
                      <tr key={program.id} className="group">
                        <td className="py-2.5">
                          <Link className="text-text group-hover:text-brand" href={`/programs/${program.id}`}>
                            {program.program_name}
                          </Link>
                        </td>
                        <td className="py-2.5">
                          <StatusBadge status={program.status === "active" ? "Healthy" : program.status} />
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-text-muted">{row?.created ?? "—"}</td>
                        <td className="py-2.5">
                          {rate === null ? (
                            <span className="text-text-muted">—</span>
                          ) : (
                            <span className="flex items-center gap-2.5">
                              {/* The bar carries the comparison down the column; the
                                  number stays for the exact read. */}
                              <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-line">
                                <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round(rate * 100)}%` }} />
                              </span>
                              <span className="font-mono text-xs tabular-nums text-text-muted">{Math.round(rate * 100)}%</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-text-muted">{row ? open : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </DashboardShell>
  );
}
