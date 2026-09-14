"use client";

import { Select } from "@/app/_components/Select";

import { useActionState } from "react";
import { hostedMacroSave, hostedMacroDelete, hostedMacroSend } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

export interface MacroRow {
  id: number;
  trigger: string;
  name: string;
  description: string | null;
  content: string;
  enabled: number;
  on_send_transition: string | null;
}

function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>;
}

export function MacroCreateForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedMacroSave, initialState);
  return (
    <form action={formAction} className="max-w-2xl space-y-3">
      <h2 className="text-sm font-medium text-text">New macro</h2>
      <input type="hidden" name="programId" value={programId} />
      <div className="grid grid-cols-[130px_1fr] gap-2">
        <input name="trigger" placeholder="?shipping" aria-label="Trigger" className={`${inputClass} font-mono`} />
        <input name="macroName" placeholder="Name" aria-label="Name" className={inputClass} />
      </div>
      <input name="macroDescription" placeholder="When to use it (optional)" aria-label="Description" className={inputClass} />
      <textarea name="macroContent" rows={3} placeholder="Approved reply. {requester} {ticket_id} {program} {status} {helper} interpolate." aria-label="Content" className={inputClass} />
      <Select
        name="macroTransition"
        ariaLabel="On-send transition"
        options={[
          { value: "", label: "No ticket transition on send" },
          { value: "resolved", label: "Resolve ticket on send" },
          { value: "closed", label: "Close ticket on send" },
          { value: "snoozed", label: "Snooze 24h on send" },
        ]}
      />
      <button type="submit" className={btnPrimary}>Save macro</button>
      <ErrorLine state={state} />
    </form>
  );
}

export function MacroRowCard({ programId, macro }: { programId: string; macro: MacroRow }) {
  const [state, deleteAction] = useActionState(hostedMacroDelete, initialState);
  return (
    <div className="border-l-2 border-line pl-4">
      <p className="font-mono text-sm text-text">{macro.trigger} <span className="font-sans text-text-muted">· {macro.name}{macro.on_send_transition ? ` · sends → ${macro.on_send_transition}` : ""}</span></p>
      {macro.description && <p className="mt-1 text-xs text-text-muted">{macro.description}</p>}
      <p className="mt-2 whitespace-pre-wrap text-sm text-text">{macro.content}</p>
      <form action={deleteAction} className="mt-3">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="macroId" value={macro.id} />
        <button type="submit" className={btnQuiet}>Delete</button>
        <ErrorLine state={state} />
      </form>
    </div>
  );
}

export function MacroSendForm({ programId, ticketId, macros }: { programId: string; ticketId: number; macros: MacroRow[] }) {
  const [state, formAction] = useActionState(hostedMacroSend, initialState);
  if (macros.length === 0) return null;
  return (
    <form action={formAction} className="flex gap-2">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <Select name="macroId" ariaLabel="Macro" options={macros.map((m) => ({ value: String(m.id), label: `${m.trigger} — ${m.name}` }))} />
      <button type="submit" className={btnQuiet}>Send</button>
      <ErrorLine state={state} />
    </form>
  );
}
