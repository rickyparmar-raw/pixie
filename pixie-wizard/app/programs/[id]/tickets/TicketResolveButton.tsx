"use client";

import { useActionState } from "react";
import { hostedTicketAction } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";

const initial: ActionState = { error: null };

// Inline resolve for a ticket row. Same server action as the detail page, so
// the same lifecycle, authorization, audit and Slack sync run. Disabled while
// the request is in flight and once it succeeds, so a row cannot be
// double-resolved; the list revalidates and the row leaves the open views.
export function TicketResolveButton({ programId, ticketId }: { programId: string; ticketId: number }) {
  const [state, formAction, pending] = useActionState(hostedTicketAction, initial);
  const done = state.ok === true;

  return (
    <form action={formAction} className="flex flex-col items-end gap-0.5">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <button
        type="submit"
        name="ticketAction"
        value="resolve"
        disabled={pending || done}
        className="rounded-[var(--radius)] border border-line px-2 py-0.5 text-xs text-text-muted transition-colors hover:border-brand hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Resolving…" : done ? "Resolved" : "Resolve"}
      </button>
      {state.error && <span className="max-w-[14rem] text-right text-xs text-brand">{state.error}</span>}
    </form>
  );
}
