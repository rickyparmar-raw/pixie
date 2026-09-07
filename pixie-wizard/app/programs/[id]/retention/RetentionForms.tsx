"use client";

import { useActionState } from "react";
import { hostedRetentionPolicy, hostedRetentionSweep } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

const FIELDS: Array<[string, string, number]> = [
  ["contextDays", "Short-term context", 30],
  ["ticketsDays", "Tickets + timeline + notes", 180],
  ["tracesDays", "AI traces/gaps", 30],
  ["analyticsDays", "Analytics", 365],
  ["auditDays", "Audit (min 365, platform floor)", 365],
];

export function RetentionPolicyForm({ programId, policy }: { programId: string; policy: Record<string, number> }) {
  const [state, formAction] = useActionState(hostedRetentionPolicy, initialState);
  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-line bg-panel p-6">
      <h2 className="font-heading text-lg text-text">Retention windows (days)</h2>
      <p className="text-xs text-text-muted">Approved knowledge always survives. Open tickets are never deleted by retention.</p>
      <input type="hidden" name="programId" value={programId} />
      <div className="grid grid-cols-2 gap-4">
        {FIELDS.map(([key, label, fallback]) => (
          <div key={key}>
            <label htmlFor={key} className={labelClass}>{label}</label>
            <input id={key} name={key} defaultValue={policy[key] ?? fallback} className={`${inputClass} font-mono`} />
          </div>
        ))}
      </div>
      {state.error && <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>}
      <button type="submit" className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">Save retention</button>
    </form>
  );
}

export function RetentionSweepForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedRetentionSweep, initialState);
  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-brand/40 bg-panel p-6">
      <h2 className="font-heading text-lg text-text">Run sweep now</h2>
      <p className="text-xs text-text-muted">Organizers only. Type the exact phrase to confirm deletion.</p>
      <input type="hidden" name="programId" value={programId} />
      <input name="confirm" placeholder={`DELETE ${programId}`} aria-label="Confirmation phrase" className={`${inputClass} font-mono`} />
      {state.error && <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>}
      <button type="submit" className="rounded-md border border-brand/60 px-4 py-2 font-heading text-sm text-brand">Sweep now</button>
    </form>
  );
}
