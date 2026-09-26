"use client";

import { Select } from "@/app/_components/Select";

import { useActionState } from "react";
import { changePersonProgramRole, revokePersonProgramAccess } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";

const initial: ActionState = { error: null };

export function PersonAccessActions({ programId, slackUserId, role }: { programId: string; slackUserId: string; role: string }) {
  const [roleState, roleAction] = useActionState(changePersonProgramRole, initial);
  const [revokeState, revokeAction] = useActionState(revokePersonProgramAccess, initial);
  return (
    <span className="ml-auto flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
      <form action={roleAction} className="flex items-center gap-2">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="slackUserId" value={slackUserId} />
        <Select
          name="role"
          defaultValue={role === "organizer" ? "organizer" : "helper"}
          className="w-[124px]"
          ariaLabel="Program role"
          options={[{ value: "helper", label: "Helper" }, { value: "organizer", label: "Organizer" }]}
        />
        <button className="pixie-button pixie-button-quiet pixie-button-sm" type="submit">Save</button>
      </form>
      <form action={revokeAction}>
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="slackUserId" value={slackUserId} />
        <button className="pixie-button pixie-button-danger pixie-button-sm" type="submit">Revoke</button>
      </form>
      {(roleState.error || revokeState.error) && (
        <span className="w-full text-right text-[12px] text-danger">{roleState.error || revokeState.error}</span>
      )}
    </span>
  );
}
