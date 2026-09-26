"use client";

import { useActionState } from "react";
import { hostedChannelsUpdate } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { btnPrimary, inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import type { CoreChannel } from "@/lib/pixieCore";
import { Notice } from "@/app/_components/DashboardShell";
import { Select } from "@/app/_components/Select";

const initialState: ActionState = { error: null };

export function ChannelChangeForm({ programId, channels }: { programId: string; channels: CoreChannel[] }) {
  const [state, formAction] = useActionState(hostedChannelsUpdate, initialState);
  return (
    <form action={formAction} className="mt-6 space-y-4 border-t border-line pt-5">
      <input type="hidden" name="programId" value={programId} />
      <div className="max-w-lg space-y-3.5">
        <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
          <span className="pixie-mark" aria-hidden="true" />
          Move the help channel
        </p>
        <p className="text-[13px] text-text-muted">
          Pixie answers in the help channel and hands anything she can&apos;t answer to your helpers.
        </p>
        <div>
          <label htmlFor="newHelpChannelId" className={labelClass}>New help channel</label>
          <div className="flex gap-2">
            <Select
              id="newHelpChannelId"
              name="newHelpChannelId"
              ariaLabel="New help channel"
              options={channels.map((c) => ({ value: c.id, label: `#${c.name}` }))}
              className="min-w-0 flex-1"
            />
            <button type="submit" className={btnPrimary}>Move</button>
          </div>
          <p className="mt-1.5 text-[13px] text-text-muted">Verifies access, keeps history.</p>
          {channels.length === 0 ? (
            <p className="mt-1.5 text-[13px] text-text-muted">
              Slack returned no channels for this workspace. Paste an ID below instead.
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="newHelpChannelIdRaw" className={labelClass}>Not in the list? Paste a channel ID</label>
          <input
            id="newHelpChannelIdRaw"
            name="newHelpChannelIdRaw"
            placeholder="C0123456789"
            aria-label="Raw channel ID"
            className={`${inputClass} font-mono`}
          />
        </div>
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
    </form>
  );
}
