"use client";

import { useActionState } from "react";
import { hostedChannelsUpdate } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import type { CoreChannel } from "@/lib/pixieCore";

const initialState: ActionState = { error: null };

export function ChannelChangeForm({ programId, channels }: { programId: string; channels: CoreChannel[] }) {
  const [state, formAction] = useActionState(hostedChannelsUpdate, initialState);
  return (
    <form action={formAction} className="mt-4 space-y-2">
      <input type="hidden" name="programId" value={programId} />
      <label htmlFor="newHelpChannelId" className={labelClass}>Move help channel (verifies access, keeps history)</label>
      <div className="flex gap-2">
        <select name="newHelpChannelId" defaultValue="" aria-label="New help channel" className={inputClass}>
          <option value="" disabled>Choose a channel…</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>#{c.name} {c.isMember ? "· Pixie has access" : "· invite @Pixie"}</option>
          ))}
        </select>
        <button type="submit" className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white">Move</button>
      </div>
      <input name="newHelpChannelIdRaw" placeholder="…or paste a channel ID" aria-label="Raw channel ID" className={`${inputClass} font-mono`} />
      {state.error && <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>}
    </form>
  );
}
