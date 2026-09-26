"use client";

import { useActionState } from "react";
import { revokeSuperadmin } from "@/app/wizard/hostedActions";
import { Notice } from "@/app/_components/DashboardShell";
import { IconExit } from "@/app/_components/icons";
import type { ActionState } from "@/lib/types";

// The one destructive action on a person record, so it is the one place in the
// dashboard that gets the danger button: panel ground, danger text, a 1px
// danger outline. Never lime — lime is what a working, active thing wears.
export function SuperadminActions({ hcaId }: { hcaId: string }) {
  const [state, action] = useActionState(revokeSuperadmin, { error: null } satisfies ActionState);
  return (
    <form action={action} className="mt-4 space-y-4">
      <input type="hidden" name="hcaId" value={hcaId} />
      <button type="submit" className="pixie-button pixie-button-danger">
        <IconExit size={16} />
        Revoke global superadmin
      </button>
      {state.error && <Notice tone="error">{state.error}</Notice>}
    </form>
  );
}
