"use client";

import { useActionState } from "react";
import { hostedHelperSave, setHelperVisibilityAction } from "@/app/wizard/hostedActions";
import { setHelperAvailabilityAction, setHelperExpertiseAction } from "./helperActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

const initialState: ActionState = { error: null };

// Availability switch: eligible for pings, routing and assignment, or
// parked with history intact. Owner/admin only — the page decides whether
// to render this, and setHelperAvailabilityAction re-checks server-side.
export function HelperAvailabilityToggle({
  programId,
  slackUserId,
  active,
}: {
  programId: string;
  slackUserId: string;
  active: boolean;
}) {
  const [state, formAction] = useActionState(setHelperAvailabilityAction, initialState);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="helperUserId" value={slackUserId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <button type="submit" className={btnQuiet} title={active ? "Stop pings and assignments" : "Resume pings and assignments"}>
        {active ? "Pause pings" : "Resume pings"}
      </button>
      {state.error && <span className="text-xs text-brand">{state.error}</span>}
    </form>
  );
}

// Per-helper expertise editor. The datalist suggests the program's own
// categories; free text stays allowed because real expertise ("pcb reflow")
// rarely matches a category name exactly.
export function HelperExpertiseForm({
  programId,
  slackUserId,
  tags,
  categorySuggestions,
}: {
  programId: string;
  slackUserId: string;
  tags: string[];
  categorySuggestions: string[];
}) {
  const [state, formAction] = useActionState(setHelperExpertiseAction, initialState);
  const listId = `expertise-${slackUserId.replace(/[^A-Za-z0-9]/g, "")}`;
  return (
    <form action={formAction} className="flex max-w-md flex-wrap items-center gap-2">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="helperUserId" value={slackUserId} />
      <input
        name="helperTags"
        defaultValue={tags.join(", ")}
        placeholder="ordering, verification, pcb"
        list={categorySuggestions.length > 0 ? listId : undefined}
        aria-label={`Expertise tags for ${slackUserId}`}
        className={`${inputClass} min-w-0 flex-1 text-xs`}
      />
      {categorySuggestions.length > 0 && (
        <datalist id={listId}>
          {categorySuggestions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
      <button type="submit" className={btnQuiet}>Save tags</button>
      {state.error && <span className="w-full text-xs text-brand">{state.error}</span>}
    </form>
  );
}

// Owner/admin only — the page decides whether to render this at all, and
// setHelperVisibilityAction() re-checks that server-side regardless, since a
// page-level check is a UX nicety, never the actual authorization boundary.
// Purely a display toggle: it can never grant or revoke real permissions,
// only whether this one helper shows up on the public roster.
export function HelperVisibilityToggle({
  programId,
  slackUserId,
  role,
  visible,
}: {
  programId: string;
  slackUserId: string;
  role: string;
  visible: boolean;
}) {
  const [state, formAction] = useActionState(setHelperVisibilityAction, initialState);
  return (
    <form action={formAction} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2 text-sm">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="slackUserId" value={slackUserId} />
      <span className="font-mono text-text">
        @{slackUserId} <span className="font-sans text-text-muted">· {role}</span>
      </span>
      <label className="flex items-center gap-2 text-xs text-text-muted">
        <input type="checkbox" name="visible" value="on" defaultChecked={visible} className="accent-brand" onChange={(e) => e.currentTarget.form?.requestSubmit()} />
        Show on public profile
      </label>
      {state.error && <span className="text-brand">{state.error}</span>}
    </form>
  );
}

export function HelperAddForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedHelperSave, initialState);
  return (
    <form action={formAction} className="max-w-lg space-y-3">
      <h2 className="text-sm font-medium text-text">Add helper</h2>
      <input type="hidden" name="programId" value={programId} />
      <div>
        <label htmlFor="helperUserId" className={labelClass}>Slack user ID</label>
        <input id="helperUserId" name="helperUserId" placeholder="U0123456789" className={`${inputClass} font-mono`} />
      </div>
      <div>
        <label htmlFor="helperTags" className={labelClass}>Expertise tags</label>
        <input id="helperTags" name="helperTags" placeholder="ordering, verification, pcb" className={inputClass} />
        <p className="mt-1 text-xs text-text-muted">Comma-separated. Used to route matching questions.</p>
      </div>
      {state.error && <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>}
      <button type="submit" className={btnPrimary}>Add helper</button>
    </form>
  );
}
