import { requireProgramMembership } from "@/lib/programAccess";
import { coreKnowledgeCandidates } from "@/lib/pixieCore";
import { PageHeader, CoreError } from "@/app/_components/DashboardShell";
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
  await requireProgramMembership(id);

  let candidates: Candidate[] = [];
  let loadError: string | null = null;
  try {
    candidates = (await coreKnowledgeCandidates(id)) as Candidate[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load candidates.";
  }

  return (
    <>
      <PageHeader
        title="Knowledge review"
        description="Resolved tickets become answers only after you approve them here."
      />

      {loadError && <CoreError message={loadError} />}

      <ProposeTicketForm programId={id} />

      <div className="mt-8 space-y-4">
        {candidates.map((c) => (
          <CandidateCard key={c.id} programId={id} candidate={c} />
        ))}
      </div>
      {candidates.length === 0 && !loadError && (
        <p className="mt-8 text-sm text-text-muted">No pending candidates. Resolve tickets, then propose the good ones.</p>
      )}
    </>
  );
}
