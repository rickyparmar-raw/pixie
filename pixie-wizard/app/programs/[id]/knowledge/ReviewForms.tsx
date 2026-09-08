"use client";

import { useActionState } from "react";
import { hostedKnowledgePropose, hostedCandidateReview, hostedFaqPropose } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>;
}

export function ProposeTicketForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedKnowledgePropose, initialState);
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2">
      <input type="hidden" name="programId" value={programId} />
      <input name="ticketId" placeholder="Resolved ticket # to learn from" className={`${inputClass} max-w-xs font-mono`} />
      <button type="submit" className={btnPrimary}>Propose</button>
      <ErrorLine state={state} />
    </form>
  );
}

export function CandidateCard({ programId, candidate }: {
  programId: string;
  candidate: { id: number; question: string; answer: string; ticket_id: number | null; category: string | null };
}) {
  const [state, formAction] = useActionState(hostedCandidateReview, initialState);
  return (
    <div className="border-l-2 border-line pl-4">
      <p className="text-xs text-text-muted">
        #{candidate.id}
        {candidate.ticket_id ? ` · from ticket #${candidate.ticket_id}` : ""}
        {candidate.category ? ` · ${candidate.category}` : ""}
      </p>
      <p className="mt-2 text-sm text-text"><span className="text-text-muted">Q </span>{candidate.question}</p>
      <p className="mt-1 text-sm text-text"><span className="text-text-muted">A </span>{candidate.answer}</p>
      <form action={formAction} className="mt-3 max-w-xl space-y-2">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="candidateId" value={candidate.id} />
        <input name="editAnswer" defaultValue={candidate.answer} aria-label="Edit answer" className={`${inputClass} text-xs`} />
        <div className="flex gap-2">
          <button name="reviewAction" value="approve" className="rounded-md bg-mint px-3 py-2 text-xs font-medium text-ink">Approve</button>
          <button name="reviewAction" value="reject" className={btnQuiet}>Reject</button>
        </div>
        <ErrorLine state={state} />
      </form>
    </div>
  );
}

export function FaqProposeButton({ programId, question }: { programId: string; question: string }) {
  const [state, formAction] = useActionState(hostedFaqPropose, initialState);
  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="faqQuestion" value={question} />
      <button type="submit" className={btnQuiet}>Generate FAQ draft</button>
      <ErrorLine state={state} />
    </form>
  );
}
