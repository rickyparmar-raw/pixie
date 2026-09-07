import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreAnalytics } from "@/lib/pixieCore";

function ms(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const mins = Math.round(v / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

export default async function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program } = await requireProgramMembership(id);

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

  return (
    <main className="max-w-none px-0 py-0">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · analytics · 30d</p>
      <h1 className="font-heading mt-3 text-2xl text-text">How support is doing</h1>
      <p className="mt-2 text-sm text-text-muted">Computed from ticket rows — no model invents these numbers.</p>

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      {a && (
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
          {[
            ["Created", String(a.created ?? 0)],
            ["Resolved", String(byStatus.resolved ?? 0)],
            ["Open-ish", String((byStatus.open ?? 0) + (byStatus.waiting_for_helper ?? 0) + (byStatus.escalated ?? 0) + (byStatus.assigned ?? 0) + (byStatus.claimed ?? 0) + (byStatus.reopened ?? 0))],
            ["AI answered", String(a.aiAnswered ?? 0)],
            ["Human handled", String(a.humanHandled ?? 0)],
            ["Deflected", `${a.deflected ?? 0} (${Math.round(Number(a.deflectionRate ?? 0) * 100)}%)`],
            ["Reopened", `${a.reopened ?? 0} (${Math.round(Number(a.reopenRate ?? 0) * 100)}%)`],
            ["Duplicates", String(a.duplicates ?? 0)],
            ["Stale 48h+", String(a.stale48h ?? 0)],
            ["First response", ms(a.medianFirstResponseMs)],
            ["First human", ms(a.medianFirstHumanResponseMs)],
            ["Resolution", ms(a.medianResolveMs)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-panel p-4">
              <p className="font-heading text-xs uppercase tracking-[0.2em] text-text-muted">{label}</p>
              <p className="font-heading mt-1 text-xl text-text">{value}</p>
            </div>
          ))}
        </div>
      )}

      {byCategory.length > 0 && (
        <div className="mt-6 rounded-lg border border-line bg-panel p-6">
          <h2 className="font-heading text-lg text-text">Volume by category</h2>
          <ul className="mt-3 space-y-1 text-sm text-text">
            {byCategory.map((c) => (
              <li key={c.category}>{c.category} · <span className="text-text-muted">{c.n}</span></li>
            ))}
          </ul>
        </div>
      )}

      {(helperLoad.length > 0 || helperResolved.length > 0) && (
        <div className="mt-6 rounded-lg border border-line bg-panel p-6">
          <h2 className="font-heading text-lg text-text">Helpers</h2>
          <ul className="mt-3 space-y-1 text-sm text-text">
            {helperLoad.map((h) => (
              <li key={h.userId}>&lt;@{h.userId}&gt; · <span className="text-text-muted">{h.openAssigned} open</span></li>
            ))}
            {helperResolved.map((h) => (
              <li key={`r-${h.userId}`}>&lt;@{h.userId}&gt; · <span className="text-text-muted">{h.resolved} resolved (30d)</span></li>
            ))}
          </ul>
        </div>
      )}

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back</Link>
    </main>
  );
}
