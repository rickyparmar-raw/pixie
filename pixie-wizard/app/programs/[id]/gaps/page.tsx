import { requireProgramMembership } from "@/lib/programAccess";
import { coreGapClusters } from "@/lib/pixieCore";
import { PageHeader, CoreError } from "@/app/_components/DashboardShell";
import { FaqProposeButton } from "../knowledge/ReviewForms";

interface Cluster {
  representative: string;
  variants: number;
  askCount: number;
  askers: number;
  firstSeen: number;
  lastSeen: number;
  escalated: number;
  covered: boolean;
}

export default async function GapsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  let clusters: Cluster[] = [];
  let loadError: string | null = null;
  try {
    const res = await coreGapClusters(id);
    clusters = res.clusters as Cluster[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load gaps.";
  }

  return (
    <>
      <PageHeader
        title="FAQ gaps"
        description="Repeated questions the docs don't answer well, grouped automatically."
      />

      {loadError && <CoreError message={loadError} />}

      <ul className="divide-y divide-line border-t border-line">
        {clusters.map((c) => (
          <li key={c.representative} className="py-4">
            <p className="text-sm text-text">{c.representative}</p>
            <p className="mt-1 text-xs text-text-muted">
              {c.askCount} asks · {c.askers} people · {c.variants} phrasing{c.variants === 1 ? "" : "s"} · escalated {c.escalated}×
              {c.covered ? " · covered by an approved fact" : " · docs unclear"}
            </p>
            {!c.covered && <FaqProposeButton programId={id} question={c.representative} />}
          </li>
        ))}
      </ul>
      {clusters.length === 0 && !loadError && (
        <p className="text-sm text-text-muted">No gaps with 2+ askers in the last 30 days.</p>
      )}
    </>
  );
}
