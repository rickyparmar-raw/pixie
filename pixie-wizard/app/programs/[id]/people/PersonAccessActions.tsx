"use client";

import { Select } from "@/app/_components/Select";

import { useActionState } from "react";
import { changePersonProgramRole, revokePersonProgramAccess } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";

const initial: ActionState = { error: null };

export function PersonAccessActions({ programId, slackUserId, role }: { programId: string; slackUserId: string; role: string }) {
  const [roleState, roleAction] = useActionState(changePersonProgramRole, initial);
  const [revokeState, revokeAction] = useActionState(revokePersonProgramAccess, initial);
  return <span className="flex items-center gap-2"><form action={roleAction} className="flex items-center gap-1"><input type="hidden" name="programId" value={programId} /><input type="hidden" name="slackUserId" value={slackUserId} /><Select name="role" defaultValue={role === "organizer" ? "organizer" : "helper"} className="w-[118px]" ariaLabel="Program role" options={[{ value: "helper", label: "Helper" }, { value: "organizer", label: "Organizer" }]} /><button className="text-xs text-text-muted transition-colors hover:text-text" type="submit">Save</button></form><form action={revokeAction}><input type="hidden" name="programId" value={programId} /><input type="hidden" name="slackUserId" value={slackUserId} /><button className="text-xs text-text-muted transition-colors hover:text-tang" type="submit">Revoke</button></form>{(roleState.error || revokeState.error) && <span className="text-xs text-brand">{roleState.error || revokeState.error}</span>}</span>;
}
