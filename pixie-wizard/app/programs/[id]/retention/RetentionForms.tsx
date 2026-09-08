"use client";

import { useActionState } from "react";
import { hostedRetentionPolicy, hostedRetentionSweep } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass, btnPrimary } from "@/app/wizard/_components/formStyles";

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
    <form action={formAction} className="max-w-2xl space-y-3">
      <h2 className="text-sm font-medium text-text">Retention windows (days)</h2>
      <p className="text-xs text-text-muted">Approved knowledge and open tickets are always kept.</p>
      <input type="hidden" name="programId" value={programId} />
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(([key, label, fallback]) => (
          <div key={key}>
            <label htmlFor={key} className={labelClass}>{label}</label>
            <input id={key} name={key} defaultValue={policy[key] ?? fallback} className={`${inputClass} font-mono`} />
          </div>
        ))}
      </div>
      {state.error && <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>}
      <button type="submit" className={btnPrimary}>Save retention</button>
    </form>
  );
}

export function RetentionSweepForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedRetentionSweep, initialState);
  return (
    <form action={formAction} className="max-w-2xl space-y-3 rounded-md border border-brand/40 p-5">
      <h2 className="text-sm font-medium text-text">Run sweep now</h2>
      <p className="text-xs text-text-muted">Organizers only. Deletes everything currently eligible. Type the phrase to confirm.</p>
      <input type="hidden" name="programId" value={programId} />
      <input name="confirm" placeholder={`DELETE ${programId}`} aria-label="Confirmation phrase" className={`${inputClass} font-mono`} />
      {state.error && <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>}
      <button type="submit" className="inline-flex items-center justify-center rounded-md border border-brand/60 px-3.5 py-2 text-sm font-medium text-brand transition-colors hover:bg-brand/10">Sweep now</button>
    </form>
  );
}
