"use client";

import { useActionState } from "react";
import { hostedChannelsUpdate } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass, btnQuiet } from "@/app/wizard/_components/formStyles";
import type { CoreChannel } from "@/lib/pixieCore";
import { Select } from "@/app/_components/Select";

const initialState: ActionState = { error: null };

export function ChannelChangeForm({ programId, channels }: { programId: string; channels: CoreChannel[] }) {
  const [state, formAction] = useActionState(hostedChannelsUpdate, initialState);
  return (
    <form action={formAction} className="mt-5 max-w-lg space-y-2">
      <input type="hidden" name="programId" value={programId} />
      <label htmlFor="newHelpChannelId" className={labelClass}>Move help channel (verifies access, keeps history)</label>
      <div className="flex gap-2">
        <Select id="newHelpChannelId" name="newHelpChannelId" ariaLabel="New help channel" options={channels.map((c) => ({ value: c.id, label: `#${c.name}` }))} />
        <button type="submit" className={btnQuiet}>Move</button>
      </div>
      <input name="newHelpChannelIdRaw" placeholder="…or paste a channel ID" aria-label="Raw channel ID" className={`${inputClass} font-mono`} />
      {state.error && <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>}
    </form>
  );
}
