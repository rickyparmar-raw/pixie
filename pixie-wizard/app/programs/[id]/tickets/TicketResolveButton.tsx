"use client";

import { useActionState } from "react";
import { hostedTicketAction } from "@/app/wizard/hostedActions";
import { IconCheck, IconAlert } from "@/app/_components/icons";
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
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <button
        type="submit"
        name="ticketAction"
        value="resolve"
        disabled={pending || done}
        className="pixie-button pixie-button-quiet pixie-button-sm min-w-[5.75rem]"
      >
        <IconCheck size={16} />
        {pending ? "Resolving…" : done ? "Resolved" : "Resolve"}
      </button>
      {state.error && (
        <span className="flex max-w-[15rem] items-start gap-1.5 text-right text-[11px] text-danger">
          <IconAlert size={16} className="mt-px shrink-0" />
          {state.error}
        </span>
      )}
    </form>
  );
}
