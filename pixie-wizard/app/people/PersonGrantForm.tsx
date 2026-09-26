"use client";

import { useActionState } from "react";
import { grantPersonAccess } from "@/app/wizard/hostedActions";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { Select } from "@/app/_components/Select";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import { Notice } from "@/app/_components/DashboardShell";
import { IconCheck, IconPlus } from "@/app/_components/icons";
import type { ActionState } from "@/lib/types";

const initial: ActionState = { error: null };

export function PersonGrantForm({ programId = "", programs = [] }: { programId?: string; programs?: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState(grantPersonAccess, initial);
  // `programId` fixed means this grant is scoped to the program you are
  // already in: the hidden input still carries it, and the field says so
  // rather than sitting there as a label over nothing.
  const scoped = Boolean(programId);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {scoped && <input type="hidden" name="programId" value={programId} />}
      <div>
        <label className={labelClass} htmlFor="hcaId">HCA identity</label>
        <input required id="hcaId" name="hcaId" className={inputClass} placeholder="account id" />
      </div>
      <div>
        <label className={labelClass} htmlFor="displayName">Display name</label>
        <input required id="displayName" name="displayName" className={inputClass} placeholder="Joe" />
      </div>
      <div>
        <label className={labelClass} htmlFor="email">Verified email</label>
        <input required type="email" id="email" name="email" className={inputClass} placeholder="person@example.com" />
      </div>
      <div>
        {/* The action refuses a person with no Slack id, so the field says so
            here rather than letting the submit come back as an error. */}
        <label className={labelClass} htmlFor="slackUserId">Slack user ID</label>
        <input required id="slackUserId" name="slackUserId" className={`${inputClass} font-mono`} placeholder="U0123456789" />
      </div>
      <div>
        {scoped ? (
          <>
            <span className={labelClass}>Program</span>
            <p className="flex items-center gap-2 rounded-[3px] border border-line bg-panel-2 px-[11px] py-2 text-[13px]">
              <IconCheck size={16} className="shrink-0 text-mint" />
              <span className="truncate font-mono text-text-muted">{programId}</span>
            </p>
          </>
        ) : (
          <>
            <label className={labelClass} htmlFor="programId">Program</label>
            <Select id="programId" name="programId" options={programs.map((program) => ({ value: program.id, label: program.name }))} />
          </>
        )}
      </div>
      <div>
        <label className={labelClass} htmlFor="role">Program role</label>
        <Select id="role" name="role" defaultValue="helper" options={[{ value: "helper", label: "Helper" }, { value: "organizer", label: "Organizer" }]} />
      </div>
      {state.error && (
        <div className="sm:col-span-2 xl:col-span-3">
          <Notice tone="error">{state.error}</Notice>
        </div>
      )}
      <div className="sm:col-span-2 xl:col-span-3">
        <SubmitButton>
          <IconPlus size={16} />
          Grant program access
        </SubmitButton>
      </div>
    </form>
  );
}
