import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { coreGapClusters } from "@/lib/pixieCore";
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
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  let clusters: Cluster[] = [];
  let loadError: string | null = null;
  try {
    const res = await coreGapClusters(id);
    clusters = res.clusters as Cluster[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load gaps.";
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · faq gaps</p>
      <h1 className="font-heading mt-3 text-2xl text-text">What docs don&apos;t answer</h1>
      <p className="mt-2 text-sm text-text-muted">Equivalent asks grouped automatically. Drafts need approval before they teach Pixie anything.</p>

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      <ul className="mt-6 space-y-4">
        {clusters.map((c) => (
          <li key={c.representative} className="rounded-lg border border-line bg-panel p-4">
            <p className="text-sm text-text">{c.representative}</p>
            <p className="mt-1 text-xs text-text-muted">
              {c.askCount} asks · {c.askers} people · {c.variants} phrasing{c.variants === 1 ? "" : "s"} · escalated {c.escalated}×
              {c.covered ? " · already covered by an approved fact" : " · docs unclear"}
            </p>
            {!c.covered && <FaqProposeButton programId={id} question={c.representative} />}
          </li>
        ))}
      </ul>
      {clusters.length === 0 && !loadError && <p className="mt-6 text-sm text-text-muted">No gaps with 2+ askers in the last 30 days. Quiet docs, or quiet channel.</p>}

      <div className="mt-8 flex gap-4">
        <Link href={`/programs/${id}/knowledge`} className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">Review drafts →</Link>
        <Link href={`/programs/${id}`} className="mt-2 text-sm text-text-muted underline">← Back</Link>
      </div>
    </main>
  );
}
