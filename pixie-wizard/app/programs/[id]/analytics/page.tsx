import { requireProgramMembership } from "@/lib/programAccess";
import { coreAnalytics } from "@/lib/pixieCore";
import { PageHeader, Section, MetricCard, CoreError } from "@/app/_components/DashboardShell";

function ms(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const mins = Math.round(v / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

export default async function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  let a: Record<string, unknown> | null = null;
  let loadError: string | null = null;
  try {
    a = await coreAnalytics(id, 30);
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load analytics.";
  }

  const byStatus = (a?.byStatus ?? {}) as Record<string, number>;
  const byCategory = (a?.byCategory ?? []) as Array<{ category: string; n: number }>;
  const helperLoad = (a?.helperLoad ?? []) as Array<{ userId: string; openAssigned: number }>;
  const helperResolved = (a?.helperResolved ?? []) as Array<{ userId: string; resolved: number }>;

  const openish =
    (byStatus.open ?? 0) + (byStatus.waiting_for_helper ?? 0) + (byStatus.escalated ?? 0) +
    (byStatus.assigned ?? 0) + (byStatus.claimed ?? 0) + (byStatus.reopened ?? 0);

  const volume: Array<[string, string]> = a
    ? [
        ["Created", String(a.created ?? 0)],
        ["Resolved", String(byStatus.resolved ?? 0)],
        ["Open", String(openish)],
        ["AI answered", String(a.aiAnswered ?? 0)],
        ["Human handled", String(a.humanHandled ?? 0)],
        ["Deflected", `${a.deflected ?? 0} (${Math.round(Number(a.deflectionRate ?? 0) * 100)}%)`],
        ["Reopened", `${a.reopened ?? 0} (${Math.round(Number(a.reopenRate ?? 0) * 100)}%)`],
        ["Duplicates", String(a.duplicates ?? 0)],
        ["Stale 48h+", String(a.stale48h ?? 0)],
      ]
    : [];
  const timing: Array<[string, string]> = a
    ? [
        ["First response", ms(a.medianFirstResponseMs)],
        ["First human reply", ms(a.medianFirstHumanResponseMs)],
        ["Time to resolution", ms(a.medianResolveMs)],
      ]
    : [];

  return (
    <>
      <PageHeader title="Analytics" description="Support trends and response times over the last 30 days." />

      {loadError && <CoreError message={loadError} />}

      {a && (
        <div className="space-y-12">
          <Section title="Volume">
            <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
              {volume.map(([label, value]) => (
                <MetricCard key={label} label={label} value={value} />
              ))}
            </div>
          </Section>

          <Section title="Response time (median)">
            <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3">
              {timing.map(([label, value]) => (
                <MetricCard key={label} label={label} value={value} />
              ))}
            </div>
          </Section>

          {byCategory.length > 0 && (
            <Section title="Volume by category">
              <ul className="space-y-1 text-sm">
                {byCategory.map((c) => (
                  <li key={c.category} className="flex justify-between gap-4">
                    <span className="text-text">{c.category}</span>
                    <span className="tabular-nums text-text-muted">{c.n}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(helperLoad.length > 0 || helperResolved.length > 0) && (
            <Section title="Helpers">
              <ul className="space-y-1 text-sm">
                {helperLoad.map((h) => (
                  <li key={h.userId} className="text-text">
                    &lt;@{h.userId}&gt; <span className="text-text-muted">· {h.openAssigned} open</span>
                  </li>
                ))}
                {helperResolved.map((h) => (
                  <li key={`r-${h.userId}`} className="text-text">
                    &lt;@{h.userId}&gt; <span className="text-text-muted">· {h.resolved} resolved (30d)</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </>
  );
}
