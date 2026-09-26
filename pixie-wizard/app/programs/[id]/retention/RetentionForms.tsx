"use client";

import { useActionState } from "react";
import { hostedRetentionPolicy, hostedRetentionSweep } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass, btnPrimary } from "@/app/wizard/_components/formStyles";
import { Section, Notice } from "@/app/_components/DashboardShell";
import { IconCheck, IconHourglass } from "@/app/_components/icons";

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
    <form action={formAction} className="max-w-2xl">
      <Section
        title="Retention windows"
        description="Days of raw content to keep. Approved knowledge and open tickets are always kept."
        bordered
      >
        <div className="space-y-4">
          <input type="hidden" name="programId" value={programId} />
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map(([key, label, fallback]) => (
              <label key={key} className="block">
                <span className={labelClass}>{label}</span>
                <input
                  id={key}
                  name={key}
                  defaultValue={policy[key] ?? fallback}
                  className={`${inputClass} font-mono tabular-nums`}
                />
              </label>
            ))}
          </div>
          {state.error && <Notice tone="error">{state.error}</Notice>}
          <button type="submit" className={btnPrimary}>
            <IconCheck size={16} />
            Save retention
          </button>
        </div>
      </Section>
    </form>
  );
}

export function RetentionSweepForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedRetentionSweep, initialState);
  return (
    <form action={formAction} className="max-w-2xl">
      {/* Destructive by nature: the one panel on the page with a danger edge, a
          danger mark and a danger button. A lime "Sweep now" would be a lie. */}
      <div className="pixie-panel border-danger/40 p-5">
        <h2 className="pixie-eyebrow flex items-center gap-2 text-danger">
          <span className="pixie-mark bg-danger" aria-hidden="true" />
          Run sweep now
        </h2>
        <p className="mt-2 text-[13px] text-text-muted">
          Organizers only. Deletes everything currently eligible. Type the phrase to confirm.
        </p>
        <div className="mt-4">
          <input type="hidden" name="programId" value={programId} />
          <label className="block">
            <span className={labelClass}>Confirmation phrase</span>
            <input
              name="confirm"
              placeholder={`DELETE ${programId}`}
              aria-label="Confirmation phrase"
              className={`${inputClass} font-mono`}
            />
          </label>
          <p className="mt-1.5 font-mono text-[11px] text-text-muted">Type DELETE {programId} to confirm.</p>
        </div>
        {state.error && (
          <div className="mt-3">
            <Notice tone="error">{state.error}</Notice>
          </div>
        )}
        <button type="submit" className="pixie-button pixie-button-danger mt-4">
          <IconHourglass size={16} />
          Sweep now
        </button>
      </div>
    </form>
  );
}
