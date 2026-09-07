"use client";

import { useActionState } from "react";
import { hostedTicketAction, hostedTicketReply, hostedTicketNote } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>;
}

export function TicketActions({ programId, ticketId }: { programId: string; ticketId: number }) {
  const [actionState, actionForm] = useActionState(hostedTicketAction, initialState);
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
      <form action={actionForm} className="flex flex-wrap gap-2">
        {hidden}
        <button name="ticketAction" value="claim" className="rounded-md bg-brand px-3 py-2 font-heading text-xs text-white hover:bg-brand-dim">Claim</button>
        <button name="ticketAction" value="resolve" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Resolve</button>
        <button name="ticketAction" value="reopen" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Reopen</button>
        <button name="ticketAction" value="unclaim" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Unclaim</button>
        <button name="ticketAction" value="close" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Close</button>
        <button name="ticketAction" value="escalate" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Escalate</button>
        <ErrorLine state={actionState} />
      </form>

      <form action={replyForm} className="space-y-3 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Reply to requester</h2>
        <p className="text-xs text-text-muted">Sends into the Slack thread as your program support identity — never as you personally.</p>
        {hidden}
        <textarea name="replyText" rows={4} required placeholder="Grounded in the docs — helpers send, Pixie delivers…" className={inputClass} />
        <SubmitButton pendingLabel="Sending…">Send reply</SubmitButton>
        <ErrorLine state={replyState} />
      </form>

      <form action={noteForm} className="space-y-3 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Internal note</h2>
        <p className="text-xs text-text-muted">Helper-only. Never posted to Slack, never quoted to requesters.</p>
        {hidden}
        <textarea name="noteBody" rows={3} required placeholder="Context for other helpers…" className={inputClass} />
        <SubmitButton pendingLabel="Saving…">Add note</SubmitButton>
        <ErrorLine state={noteState} />
      </form>

      <form action={actionForm} className="space-y-3 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Assign · duplicate · snooze</h2>
        {hidden}
        <div>
          <label htmlFor="assigneeId" className={labelClass}>Assign to Slack user ID, then press Assign</label>
          <input id="assigneeId" name="assigneeId" placeholder="U0123456789" className={`${inputClass} font-mono`} />
        </div>
        <div>
          <label htmlFor="canonicalId" className={labelClass}>Duplicate of ticket #, then press Duplicate</label>
          <input id="canonicalId" name="canonicalId" placeholder="123" className={`${inputClass} font-mono`} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button name="ticketAction" value="assign" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Assign</button>
          <button name="ticketAction" value="duplicate" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Duplicate</button>
          <button name="ticketAction" value="snooze" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Snooze 24h</button>
        </div>
        <input type="hidden" name="until" value={String(Date.now() + 24 * 60 * 60 * 1000)} />
      </form>
    </div>
  );
}
