"use client";

import { useActionState } from "react";
import { hostedHelperSave, setHelperVisibilityAction } from "@/app/wizard/hostedActions";
import { setHelperAvailabilityAction, setHelperExpertiseAction } from "./helperActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";
import { Chip, Notice } from "@/app/_components/DashboardShell";
import { IconPlus } from "@/app/_components/icons";

const initialState: ActionState = { error: null };

export function HelperAvailabilityToggle({ programId, slackUserId, active }: { programId: string; slackUserId: string; active: boolean }) {
  const [state, formAction] = useActionState(setHelperAvailabilityAction, initialState);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="helperUserId" value={slackUserId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <button type="submit" className={btnQuiet}>{active ? "Pause pings" : "Resume pings"}</button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}

export function HelperExpertiseForm({ programId, slackUserId, tags, categorySuggestions }: { programId: string; slackUserId: string; tags: string[]; categorySuggestions: string[] }) {
  const [state, formAction] = useActionState(setHelperExpertiseAction, initialState);
  const listId = `expertise-${slackUserId.replace(/[^A-Za-z0-9]/g, "")}`;
  return (
    <form action={formAction} className="flex max-w-xl flex-wrap items-center gap-2">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="helperUserId" value={slackUserId} />
      <input name="helperTags" defaultValue={tags.join(", ")} placeholder="ordering, verification, pcb" list={categorySuggestions.length > 0 ? listId : undefined} aria-label={`Expertise tags for ${slackUserId}`} className={`${inputClass} min-w-0 flex-1 text-xs`} />
      {categorySuggestions.length > 0 && <datalist id={listId}>{categorySuggestions.map((category) => <option key={category} value={category} />)}</datalist>}
      <button type="submit" className={btnQuiet}>Save tags</button>
      {state.error && <span className="w-full text-xs text-danger">{state.error}</span>}
    </form>
  );
}

// Owner/admin only — the page decides whether to render this at all, and
// setHelperVisibilityAction() re-checks that server-side regardless, since a
// page-level check is a UX nicety, never the actual authorization boundary.
// Purely a display toggle: it can never grant or revoke real permissions,
// only whether this one helper shows up on the public roster.
//
// `label` is the person's resolved name, so this settings list reads like the
// roster above it. It is display only — the id in the hidden input is what the
// action writes — and when Core knows nobody the label IS "@<id>", so the
// name is dropped rather than printed twice beside its own id.
export function HelperVisibilityToggle({
  programId,
  slackUserId,
  label,
  role,
  visible,
}: {
  programId: string;
  slackUserId: string;
  label: string;
  role: string;
  visible: boolean;
}) {
  const [state, formAction] = useActionState(setHelperVisibilityAction, initialState);
  const named = label !== `@${slackUserId}`;
  return (
    <form action={formAction} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="slackUserId" value={slackUserId} />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {named && <span className="min-w-0 truncate text-[13px] text-text">{label}</span>}
        <span className="font-mono text-[13px] text-text-muted">@{slackUserId}</span>
        <Chip>{role}</Chip>
      </span>
      {/* A square the size of the rest of the world's markers: unselected is an
          empty outlined tile, selected is a lime tile with a tick in the button
          ink. The tick is drawn by the input's own background so it can never
          drift out of the tile the way an overlaid sprite would, and the input
          keeps its real name/value/onChange, so the form posts exactly what it
          always did. */}
      <label className="relative flex select-none items-center gap-2 text-[13px] text-text-muted transition-colors hover:text-text">
        <input
          type="checkbox"
          name="visible"
          value="on"
          defaultChecked={visible}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="peer size-4 shrink-0 appearance-none rounded-[1px] border border-line-strong bg-panel-2 bg-[length:16px_16px] bg-center bg-no-repeat transition-colors checked:border-lime checked:bg-lime checked:bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2016%2016%22%3E%3Cpath%20d=%22M3.5%208.5L6.5%2011.5L12.5%204.5%22%20fill=%22none%22%20stroke=%22%230d1a07%22%20stroke-width=%222.5%22/%3E%3C/svg%3E')] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        />
        Show on public profile
      </label>
      {state.error && <span className="w-full text-[12px] text-danger">{state.error}</span>}
    </form>
  );
}

// The page owns this form's section heading; the field names, the hidden
// programId and the server action are unchanged.
export function HelperAddForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedHelperSave, initialState);
  return (
    <form action={formAction} className="max-w-3xl space-y-4">
      <input type="hidden" name="programId" value={programId} />
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
        <div>
          <label htmlFor="helperUserId" className={labelClass}>Slack user ID</label>
          <input id="helperUserId" name="helperUserId" placeholder="U0123456789" className={`${inputClass} font-mono`} />
        </div>
        <div>
          <label htmlFor="helperTags" className={labelClass}>Expertise tags</label>
          <input id="helperTags" name="helperTags" placeholder="ordering, verification, pcb" className={inputClass} />
          <p className="mt-1.5 text-[12px] text-text-muted">Comma-separated. Used to route matching questions.</p>
        </div>
      </div>
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <button type="submit" className={btnPrimary}>
        <IconPlus size={16} />
        Add helper
      </button>
    </form>
  );
}
