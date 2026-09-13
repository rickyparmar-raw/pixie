import Link from "next/link";
import { DashboardShell, PageHeader, Section, MetricCard, StatusBadge } from "@/app/_components/DashboardShell";
import { requireWizardSuperadmin } from "@/lib/programAccess";
import { hostedProgramRepository } from "@/lib/repositories/hostedProgramRepository";
import { coreAnalytics } from "@/lib/pixieCore";
import { summarizeAnalytics, type AnalyticsSnapshot } from "@/lib/dashboardMetrics";

function percent(value: number, total: number): string {
  return total ? `${Math.round((value / total) * 100)}%` : "0%";
}

// Cross-program view — superadmin-only. Anyone else only ever needs the one
// program they actually work on; see requireWizardSuperadmin.
export default async function OverviewPage() {
  const session = await requireWizardSuperadmin();

  const programs = await hostedProgramRepository.listHostedProgramsForOwner(session).catch(() => []);
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

  return (
    <DashboardShell>
      <PageHeader title="Overview" description="Last 30 days across every program you own." />

      <div className="space-y-12">
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

        <Section title="By program">
          {programs.length === 0 ? (
            <p className="text-sm text-text-muted">No hosted programs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr className="border-b border-line">
                    <th className="pb-2 font-normal">Program</th>
                    <th className="pb-2 font-normal">Status</th>
                    <th className="pb-2 font-normal">Questions</th>
                    <th className="pb-2 font-normal">AI answer %</th>
                    <th className="pb-2 font-normal">Open</th>
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
                    return (
                      <tr key={program.id}>
                        <td className="py-2.5">
                          <Link className="text-text hover:text-brand" href={`/programs/${program.id}`}>
                            {program.program_name}
                          </Link>
                        </td>
                        <td className="py-2.5">
                          <StatusBadge status={program.status === "active" ? "Healthy" : program.status} />
                        </td>
                        <td className="py-2.5 tabular-nums text-text-muted">{row?.created ?? "—"}</td>
                        <td className="py-2.5 tabular-nums text-text-muted">{row ? percent(row.aiAnswered, row.created) : "—"}</td>
                        <td className="py-2.5 tabular-nums text-text-muted">{row ? open : "—"}</td>
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
