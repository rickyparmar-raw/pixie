"use client";

import { useActionState, useState } from "react";
import { hostedKnowledgePropose, hostedCandidateReview, hostedFaqPropose } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";
import { refreshKnowledgeSources } from "./knowledgeActions";

const initialState: ActionState = { error: null };

function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>;
}

// Re-sync button for the sources table. Core starts the refresh in the
// background and returns immediately, so the button only confirms the kick:
// "Syncing…" until the click resolves, then the operator watches the table.
export function RefreshSourcesButton({ programId }: { programId: string }) {
  const [phase, setPhase] = useState<"idle" | "working" | "started" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={phase === "working"}
        onClick={async () => {
          setPhase("working");
          setError(null);
          const res = await refreshKnowledgeSources(programId);
          if (res.ok) setPhase("started");
          else {
            setPhase("failed");
            setError(res.error ?? "Refresh failed.");
          }
        }}
        className="pixie-button pixie-button-quiet disabled:opacity-50"
      >
        {phase === "working" ? "Starting…" : phase === "started" ? "Syncing…" : "Re-sync"}
      </button>
      {phase === "started" && <span className="text-xs text-text-muted">Refresh running — reload for progress.</span>}
      {error && <span className="text-xs text-brand">{error}</span>}
    </span>
  );
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

export type Fact = {
  id: number;
  question: string;
  answer: string;
  status: string;
  ticket_id: number | null;
  category: string | null;
  author_id: string | null;
  created_at: number;
  auto_learned?: number;
};

// One card for every stage of a learned fact's life. Candidates and pending
// rows get Approve/Reject (approval is the only path into the corpus);
// approved rows get Retire (the same reject transition, now meaning
// "stop answering from this"); rejected rows are shown read-only.
export function CandidateCard({ programId, candidate, authorLabel, createdLabel }: {
  programId: string;
  candidate: Fact;
  authorLabel?: string;
  createdLabel?: string;
}) {
  const [state, formAction] = useActionState(hostedCandidateReview, initialState);
  const reviewable = candidate.status === "candidate" || candidate.status === "pending";
  const live = candidate.status === "approved";
  return (
    <div className="border-l-2 border-line pl-4">
      <p className="text-xs text-text-muted">
        #{candidate.id}
        {` · ${candidate.status}`}
        {candidate.auto_learned ? " · auto-learned" : ""}
        {candidate.ticket_id ? ` · from ticket #${candidate.ticket_id}` : ""}
        {candidate.category ? ` · ${candidate.category}` : ""}
        {authorLabel ? ` · by ${authorLabel}` : ""}
        {createdLabel ? ` · ${createdLabel}` : ""}
      </p>
      <p className="mt-2 text-sm text-text"><span className="text-text-muted">Q </span>{candidate.question}</p>
      <p className="mt-1 text-sm text-text"><span className="text-text-muted">A </span>{candidate.answer}</p>
      {(reviewable || live) && (
        <form action={formAction} className="mt-3 max-w-xl space-y-2">
          <input type="hidden" name="programId" value={programId} />
          <input type="hidden" name="candidateId" value={candidate.id} />
          {reviewable && (
            <input name="editAnswer" defaultValue={candidate.answer} aria-label="Edit answer" className={`${inputClass} text-xs`} />
          )}
          <div className="flex gap-2">
            {reviewable && (
              <button name="reviewAction" value="approve" className="rounded-md bg-mint px-3 py-2 text-xs font-medium text-ink">Approve</button>
            )}
            <button
              name="reviewAction"
              value="reject"
              className={btnQuiet}
              title={live ? "Stop answering from this fact" : undefined}
            >
              {live ? "Retire" : "Reject"}
            </button>
          </div>
          <ErrorLine state={state} />
        </form>
      )}
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
