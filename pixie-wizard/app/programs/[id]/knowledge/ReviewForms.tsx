"use client";

import { useActionState } from "react";
import { hostedKnowledgePropose, hostedCandidateReview, hostedFaqPropose } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/app/wizard/actions";
import { inputClass } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>;
}

export function ProposeTicketForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedKnowledgePropose, initialState);
  return (
    <form action={formAction} className="mt-6 flex gap-2">
      <input type="hidden" name="programId" value={programId} />
      <input name="ticketId" placeholder="Resolved ticket # to learn from…" className={`${inputClass} font-mono`} />
      <button type="submit" className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">Propose</button>
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
    <div className="rounded-lg border border-line bg-panel p-4">
      <p className="font-heading text-xs text-text-muted">#{candidate.id}{candidate.ticket_id ? ` · from ticket #${candidate.ticket_id}` : ""}{candidate.category ? ` · ${candidate.category}` : ""}</p>
      <p className="mt-2 text-sm text-text"><span className="text-text-muted">Q: </span>{candidate.question}</p>
      <p className="mt-1 text-sm text-text"><span className="text-text-muted">A: </span>{candidate.answer}</p>
      <form action={formAction} className="mt-3 space-y-2">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="candidateId" value={candidate.id} />
        <input name="editAnswer" defaultValue={candidate.answer} aria-label="Edit answer" className={`${inputClass} text-xs`} />
        <div className="flex gap-2">
          <button name="reviewAction" value="approve" className="rounded-md bg-mint px-3 py-2 font-heading text-xs text-ink">Approve</button>
          <button name="reviewAction" value="reject" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Reject</button>
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
      <button type="submit" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Generate FAQ draft</button>
      <ErrorLine state={state} />
    </form>
  );
}
