import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { coreKnowledgeCandidates } from "@/lib/pixieCore";
import { ProposeTicketForm, CandidateCard } from "./ReviewForms";

interface Candidate {
  id: number;
  question: string;
  answer: string;
  status: string;
  category: string | null;
  ticket_id: number | null;
  resolver_id: string | null;
  created_at: number;
}

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  let candidates: Candidate[] = [];
  let loadError: string | null = null;
  try {
    candidates = (await coreKnowledgeCandidates(id)) as Candidate[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load candidates.";
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · knowledge review</p>
      <h1 className="font-heading mt-3 text-2xl text-text">Verified memory</h1>
      <p className="mt-2 text-sm text-text-muted">Resolved tickets become answers only after you approve them here. Nothing enters the corpus unreviewed.</p>

      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      <ProposeTicketForm programId={id} />

      <div className="mt-6 space-y-4">
        {candidates.map((c) => (
          <CandidateCard key={c.id} programId={id} candidate={c} />
        ))}
      </div>
      {candidates.length === 0 && !loadError && <p className="mt-6 text-sm text-text-muted">No pending candidates. Resolve tickets, then propose the good ones here.</p>}

      <div className="mt-8 flex gap-4">
        <Link href={`/programs/${id}/gaps`} className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">FAQ gaps →</Link>
        <Link href={`/programs/${id}`} className="mt-2 text-sm text-text-muted underline">← Back</Link>
      </div>
    </main>
  );
}
