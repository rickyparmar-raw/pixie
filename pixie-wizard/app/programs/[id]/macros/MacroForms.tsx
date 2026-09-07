"use client";

import { useActionState } from "react";
import { hostedMacroSave, hostedMacroDelete, hostedMacroSend } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/app/wizard/actions";
import { inputClass } from "@/app/wizard/_components/formStyles";

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
  return <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>;
}

export function MacroCreateForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedMacroSave, initialState);
  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-line bg-panel p-6">
      <h2 className="font-heading text-lg text-text">New macro</h2>
      <input type="hidden" name="programId" value={programId} />
      <div className="grid grid-cols-[130px_1fr] gap-2">
        <input name="trigger" placeholder="?shipping" aria-label="Trigger" className={`${inputClass} font-mono`} />
        <input name="macroName" placeholder="Name" aria-label="Name" className={inputClass} />
      </div>
      <input name="macroDescription" placeholder="When to use it (optional)" aria-label="Description" className={inputClass} />
      <textarea name="macroContent" rows={3} placeholder="Approved reply. {requester} {ticket_id} {program} {status} {helper} interpolate." aria-label="Content" className={inputClass} />
      <select name="macroTransition" defaultValue="" aria-label="On-send transition" className={inputClass}>
        <option value="">No ticket transition on send</option>
        <option value="resolved">Resolve ticket on send</option>
        <option value="closed">Close ticket on send</option>
        <option value="snoozed">Snooze 24h on send</option>
      </select>
      <button type="submit" className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">Save macro</button>
      <ErrorLine state={state} />
    </form>
  );
}

export function MacroRowCard({ programId, macro }: { programId: string; macro: MacroRow }) {
  const [state, deleteAction] = useActionState(hostedMacroDelete, initialState);
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <p className="font-mono text-sm text-text">{macro.trigger} <span className="font-sans text-text-muted">· {macro.name}{macro.on_send_transition ? ` · sends → ${macro.on_send_transition}` : ""}</span></p>
      {macro.description && <p className="mt-1 text-xs text-text-muted">{macro.description}</p>}
      <p className="mt-2 whitespace-pre-wrap text-sm text-text">{macro.content}</p>
      <form action={deleteAction} className="mt-3">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="macroId" value={macro.id} />
        <button type="submit" className="rounded-md border border-line px-3 py-1 font-heading text-xs text-text-muted hover:text-text">Delete</button>
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
      <select name="macroId" defaultValue="" aria-label="Macro" className={inputClass}>
        <option value="" disabled>Send a macro…</option>
        {macros.map((m) => (
          <option key={m.id} value={m.id}>{m.trigger} — {m.name}</option>
        ))}
      </select>
      <button type="submit" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Send</button>
      <ErrorLine state={state} />
    </form>
  );
}
