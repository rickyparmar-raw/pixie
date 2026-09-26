"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { hostedTicketAction, hostedTicketReply, hostedTicketNote } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { Section, Notice } from "@/app/_components/DashboardShell";
import { inputClass, labelClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

// A failed action is a failure, so it wears danger — never the lime that means
// "this worked". Same server action, same fields, same lifecycle either way.
function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <Notice tone="error">{state.error}</Notice>;
}

function DoneLine({ state }: { state: ActionState }) {
  if (state.error || !state.ok) return null;
  return (
    <Notice tone="success">
      Done{state.status ? ` — now ${state.status.replace(/_/g, " ")}` : ""}.
    </Notice>
  );
}

// A submit button for whichever role the form needs, wired to the enclosing
// form's pending state. One screen gets one lime action — here, the reply.
function Submit({
  children,
  pendingLabel,
  variant = "quiet",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "primary" | "quiet";
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={variant === "primary" ? btnPrimary : btnQuiet}>
      {pending ? pendingLabel : children}
    </button>
  );
}

// The rail's control panel: the six lifecycle transitions, as one row of
// equal-weight quiet buttons. None of them is the page's primary action — the
// reply is — so none of them wears lime.
const LIFECYCLE: Array<[action: string, label: string]> = [
  ["claim", "Claim"],
  ["resolve", "Resolve"],
  ["reopen", "Reopen"],
  ["unclaim", "Release"],
  ["close", "Close"],
  ["escalate", "Escalate"],
];

export function TicketActions({ programId, ticketId }: { programId: string; ticketId: number }) {
  const [state, formAction, pending] = useActionState(hostedTicketAction, initialState);

  return (
    <Section title="Actions" bordered>
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="ticketId" value={ticketId} />
        <div className="flex flex-wrap items-center gap-2">
          {LIFECYCLE.map(([action, label]) => (
            <button key={action} name="ticketAction" value={action} disabled={pending} className={btnQuiet}>
              {label}
            </button>
          ))}
          {pending && <span className="text-[12px] text-text-muted">Working…</span>}
        </div>
        <ErrorLine state={state} />
        <DoneLine state={state} />
      </form>
    </Section>
  );
}

// The column the ticket is actually worked in: answer the asker, leave a note
// for the next helper, or move the ticket to someone else.
export function TicketComposer({ programId, ticketId }: { programId: string; ticketId: number }) {
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
      <Section
        title="Reply to requester"
        description='Sends into the Slack thread as your program support identity, with a "sent by @you" line so the thread knows who replied.'
        bordered
      >
        <form action={replyForm} className="space-y-3">
          {hidden}
          <textarea
            name="replyText"
            rows={4}
            required
            placeholder="Grounded in the docs. Helpers send, Pixie delivers."
            className={inputClass}
          />
          <Submit variant="primary" pendingLabel="Sending…">Send reply</Submit>
          <ErrorLine state={replyState} />
        </form>
      </Section>

      <Section title="Internal note" description="Helper-only. Never posted to Slack, never quoted to requesters." bordered>
        <form action={noteForm} className="space-y-3">
          {hidden}
          <textarea name="noteBody" rows={3} required placeholder="Context for other helpers" className={inputClass} />
          <Submit pendingLabel="Saving…">Add note</Submit>
          <ErrorLine state={noteState} />
        </form>
      </Section>

      <Section title="Assign, duplicate or snooze" bordered>
        <form action={actionForm} className="space-y-3">
          {hidden}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="assigneeId" className={labelClass}>Assignee (Slack user ID)</label>
              <input id="assigneeId" name="assigneeId" placeholder="U0123456789" className={`${inputClass} font-mono`} />
            </div>
            <div className="min-w-0">
              <label htmlFor="canonicalId" className={labelClass}>Canonical ticket # (for Duplicate)</label>
              <input id="canonicalId" name="canonicalId" placeholder="123" className={`${inputClass} font-mono`} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button name="ticketAction" value="assign" disabled={actionPending} className={btnQuiet}>Assign</button>
            <button name="ticketAction" value="duplicate" disabled={actionPending} className={btnQuiet}>Duplicate</button>
            <button name="ticketAction" value="snooze" disabled={actionPending} className={btnQuiet}>Snooze 24h</button>
          </div>
          <input type="hidden" name="until" value={String(Date.now() + 24 * 60 * 60 * 1000)} />
          <ErrorLine state={actionState} />
        </form>
      </Section>
    </div>
  );
}
