import { requireProgramMembership } from "@/lib/programAccess";
import { coreGapClusters } from "@/lib/pixieCore";
import { PageHeader, CoreError, StatusDot, EmptyState } from "@/app/_components/DashboardShell";
import { timeAgo } from "@/app/_components/format";
import { FaqProposeButton } from "../knowledge/ReviewForms";

type Cluster = {
  representative: string;
  variants: number;
  askCount: number;
  askers: number;
  firstSeen: number;
  lastSeen: number;
  escalated: number;
  covered: boolean;
};

export default async function GapsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  let clusters: Cluster[] = [];
  let loadError: string | null = null;
  try {
    const res = await coreGapClusters(id);
    clusters = res.clusters as Cluster[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Gap clustering is unavailable.";
  }

  clusters = [...clusters].sort((a, b) => b.askCount - a.askCount);

  return (
    <>
      <PageHeader
        title="FAQ gaps"
        description="Questions the docs don't answer well, grouped by meaning. The ones near the top keep coming back."
      />

      {loadError ? (
        <CoreError message={loadError} />
      ) : clusters.length === 0 ? (
        <EmptyState
          title="No gaps with two or more askers in the last 30 days."
          hint="Pixie groups repeated misses here so you can fix the doc once."
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {clusters.map((c) => (
            <li key={c.representative} className="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[1fr_auto]">
              <div className="min-w-0">
                <p className="text-sm text-text">{c.representative}</p>
                <p className="mt-1 font-mono text-xs text-text-muted">
                  {c.askCount} asks · {c.askers} {c.askers === 1 ? "person" : "people"} · {c.variants}{" "}
                  phrasing{c.variants === 1 ? "" : "s"}
                  {c.escalated > 0 ? ` · escalated ${c.escalated}×` : ""} · seen {timeAgo(c.lastSeen)}
                </p>
              </div>
              <div className="flex items-center gap-3 sm:flex-col sm:items-end">
                <StatusDot status={c.covered ? "healthy" : "attention"}>
                  {c.covered ? "covered" : "docs unclear"}
                </StatusDot>
                {!c.covered && <FaqProposeButton programId={id} question={c.representative} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
