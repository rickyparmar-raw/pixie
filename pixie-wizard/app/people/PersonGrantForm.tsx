"use client";

import { useActionState } from "react";
import { grantPersonAccess } from "@/app/wizard/hostedActions";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import type { ActionState } from "@/lib/types";

const initial: ActionState = { error: null };

export function PersonGrantForm({ programId = "", programs = [] }: { programId?: string; programs?: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState(grantPersonAccess, initial);
  return <form action={action} className="grid max-w-3xl gap-3 sm:grid-cols-2">
    {programId && <input type="hidden" name="programId" value={programId} />}
    <div><label className={labelClass} htmlFor="hcaId">HCA identity</label><input required id="hcaId" name="hcaId" className={inputClass} placeholder="account id" /></div>
    <div><label className={labelClass} htmlFor="displayName">Display name</label><input required id="displayName" name="displayName" className={inputClass} placeholder="Kavyansh" /></div>
    <div><label className={labelClass} htmlFor="email">Verified email</label><input required type="email" id="email" name="email" className={inputClass} placeholder="person@example.com" /></div>
    <div><label className={labelClass} htmlFor="slackUserId">Slack user ID</label><input id="slackUserId" name="slackUserId" className={`${inputClass} font-mono`} placeholder="U0123456789" /></div>
    <div><label className={labelClass} htmlFor="programId">Program</label>{programId ? <input type="hidden" name="programId" value={programId} /> : <select required id="programId" name="programId" className={inputClass} defaultValue=""><option value="" disabled>Select a program</option>{programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}</select>}</div>
    <div><label className={labelClass} htmlFor="role">Program role</label><select id="role" name="role" defaultValue="helper" className={inputClass}><option value="helper">Helper</option><option value="organizer">Organizer</option></select></div>
    {state.error && <p className="border-l-2 border-brand pl-3 text-sm text-brand sm:col-span-2">{state.error}</p>}
    <div className="sm:col-span-2"><SubmitButton>Grant program access</SubmitButton></div>
  </form>;
}
