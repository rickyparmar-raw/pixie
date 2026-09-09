"use client";

import { useActionState } from "react";
import { changePersonProgramRole, revokePersonProgramAccess } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";

const initial: ActionState = { error: null };

export function PersonAccessActions({ programId, slackUserId, role }: { programId: string; slackUserId: string; role: string }) {
  const [roleState, roleAction] = useActionState(changePersonProgramRole, initial);
  const [revokeState, revokeAction] = useActionState(revokePersonProgramAccess, initial);
  return <span className="flex items-center gap-2"><form action={roleAction} className="flex items-center gap-1"><input type="hidden" name="programId" value={programId} /><input type="hidden" name="slackUserId" value={slackUserId} /><select name="role" defaultValue={role === "organizer" ? "organizer" : "helper"} className="border border-line bg-panel px-1 py-1 text-xs"><option value="helper">Helper</option><option value="organizer">Organizer</option></select><button className="text-xs text-brand underline" type="submit">Save</button></form><form action={revokeAction}><input type="hidden" name="programId" value={programId} /><input type="hidden" name="slackUserId" value={slackUserId} /><button className="text-xs text-brand underline" type="submit">Revoke</button></form>{(roleState.error || revokeState.error) && <span className="text-xs text-brand">{roleState.error || revokeState.error}</span>}</span>;
}
