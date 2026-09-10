"use client";

import { useActionState } from "react";
import { hostedTicketAction, hostedTicketReply, hostedTicketNote } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { inputClass, labelClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>;
}

function DoneLine({ state }: { state: ActionState }) {
  if (state.error || !state.ok) return null;
  return (
    <p className="border-l-2 border-mint/60 pl-3 text-sm text-text-muted">
      Done{state.status ? ` — now ${state.status.replace(/_/g, " ")}` : ""}.
    </p>
  );
}

export function TicketActions({ programId, ticketId }: { programId: string; ticketId: number }) {
  const [actionState, actionForm, actionPending] = useActionState(hostedTicketAction, initialState);
  const [replyState, replyForm] = useActionState(hostedTicketReply, initialState);
  const [noteState, noteForm] = useActionState(hostedTicketNote, initialState);

  const hidden = (
    <>
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="ticketId" value={ticketId} />
    </>
  );

  return (
    <div className="space-y-6">
      <form action={actionForm} className="flex flex-wrap items-center gap-2">
        {hidden}
        <button name="ticketAction" value="claim" disabled={actionPending} className={`${btnPrimary} disabled:opacity-50`}>Claim</button>
        <button name="ticketAction" value="resolve" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Resolve</button>
        <button name="ticketAction" value="reopen" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Reopen</button>
        <button name="ticketAction" value="unclaim" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Release</button>
        <button name="ticketAction" value="close" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Close</button>
        <button name="ticketAction" value="escalate" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Escalate</button>
        {actionPending && <span className="text-xs text-text-muted">Working…</span>}
        <ErrorLine state={actionState} />
        <DoneLine state={actionState} />
      </form>

      <form action={replyForm} className="max-w-2xl space-y-3">
        <h2 className="text-sm font-medium text-text">Reply to requester</h2>
        <p className="text-xs text-text-muted">Sends into the Slack thread as your program support identity, not as you personally.</p>
        {hidden}
        <textarea name="replyText" rows={4} required placeholder="Grounded in the docs. Helpers send, Pixie delivers." className={inputClass} />
        <SubmitButton pendingLabel="Sending…">Send reply</SubmitButton>
        <ErrorLine state={replyState} />
      </form>

      <form action={noteForm} className="max-w-2xl space-y-3">
        <h2 className="text-sm font-medium text-text">Internal note</h2>
        <p className="text-xs text-text-muted">Helper-only. Never posted to Slack, never quoted to requesters.</p>
        {hidden}
        <textarea name="noteBody" rows={3} required placeholder="Context for other helpers" className={inputClass} />
        <SubmitButton pendingLabel="Saving…">Add note</SubmitButton>
        <ErrorLine state={noteState} />
      </form>

      <form action={actionForm} className="max-w-2xl space-y-3">
        <h2 className="text-sm font-medium text-text">Assign, duplicate or snooze</h2>
        {hidden}
        <div>
          <label htmlFor="assigneeId" className={labelClass}>Assignee (Slack user ID)</label>
          <input id="assigneeId" name="assigneeId" placeholder="U0123456789" className={`${inputClass} font-mono`} />
        </div>
        <div>
          <label htmlFor="canonicalId" className={labelClass}>Canonical ticket # (for Duplicate)</label>
          <input id="canonicalId" name="canonicalId" placeholder="123" className={`${inputClass} font-mono`} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button name="ticketAction" value="assign" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Assign</button>
          <button name="ticketAction" value="duplicate" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Duplicate</button>
          <button name="ticketAction" value="snooze" disabled={actionPending} className={`${btnQuiet} disabled:opacity-50`}>Snooze 24h</button>
        </div>
        <input type="hidden" name="until" value={String(Date.now() + 24 * 60 * 60 * 1000)} />
      </form>
    </div>
  );
}
