"use client";

import { useActionState } from "react";
import { revokeSuperadmin } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";

export function SuperadminActions({ hcaId }: { hcaId: string }) {
  const [state, action] = useActionState(revokeSuperadmin, { error: null } satisfies ActionState);
  return <form action={action} className="mt-3"><input type="hidden" name="hcaId" value={hcaId} /><button type="submit" className="text-sm text-brand underline">Revoke global superadmin</button>{state.error && <p className="mt-2 text-xs text-brand">{state.error}</p>}</form>;
}
