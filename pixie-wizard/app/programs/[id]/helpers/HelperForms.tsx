"use client";

import { useActionState } from "react";
import { hostedHelperSave } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/app/wizard/actions";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

export function HelperAddForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedHelperSave, initialState);
  return (
    <form action={formAction} className="space-y-3 rounded-lg border border-line bg-panel p-6">
      <h2 className="font-heading text-lg text-text">Add helper + expertise</h2>
      <input type="hidden" name="programId" value={programId} />
      <div>
        <label htmlFor="helperUserId" className={labelClass}>Slack user ID</label>
        <input id="helperUserId" name="helperUserId" placeholder="U0123456789" className={`${inputClass} font-mono`} />
      </div>
      <div>
        <label htmlFor="helperTags" className={labelClass}>Expertise tags (comma-separated)</label>
        <input id="helperTags" name="helperTags" placeholder="ordering, verification, pcb" className={inputClass} />
      </div>
      {state.error && <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>}
      <button type="submit" className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">Save helper</button>
    </form>
  );
}
