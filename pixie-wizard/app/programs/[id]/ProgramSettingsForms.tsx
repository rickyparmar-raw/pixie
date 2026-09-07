"use client";

import { useActionState } from "react";
import { saveHostedSettings, saveHostedSources } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import type { HostedProgramRow } from "@/lib/types";

const initialState: ActionState = { error: null };

export function ProgramSettingsForms({ program }: { program: HostedProgramRow }) {
  const [settingsState, settingsAction] = useActionState(saveHostedSettings, initialState);
  const [sourcesState, sourcesAction] = useActionState(saveHostedSources, initialState);

  return (
    <div className="space-y-6">
      <form action={settingsAction} className="space-y-4 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">AI & support behavior</h2>
        <input type="hidden" name="programId" value={program.id} />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="supportName" className={labelClass}>Support display name</label>
            <input id="supportName" name="supportName" defaultValue={program.support_name ?? ""} maxLength={80} className={inputClass} />
          </div>
          <div>
            <label htmlFor="iconUrl" className={labelClass}>Support icon / avatar URL</label>
            <input id="iconUrl" name="iconUrl" defaultValue={program.icon_url ?? ""} placeholder="https://…/avatar.png" className={inputClass} />
          </div>
        </div>
        <div>
          <label htmlFor="programDescription" className={labelClass}>Program description</label>
          <textarea id="programDescription" name="programDescription" defaultValue={program.program_description ?? ""} rows={2} className={inputClass} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="posture" className={labelClass}>Posture</label>
            <select id="posture" name="posture" defaultValue={program.posture} className={inputClass}>
              <option value="active">Active</option>
              <option value="passive">Passive</option>
              <option value="muted">Muted</option>
            </select>
          </div>
          <div>
            <label htmlFor="scope" className={labelClass}>Answer scope</label>
            <select id="scope" name="scope" defaultValue={program.scope} className={inputClass}>
              <option value="program">Program only</option>
              <option value="any">Anything</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="hidden" name="aiAnswers" value="off" />
          <input type="checkbox" name="aiAnswers" value="on" defaultChecked={program.ai_answers} /> AI answers on
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="hidden" name="ticketsEnabled" value="off" />
          <input type="checkbox" name="ticketsEnabled" value="on" defaultChecked={program.tickets_enabled} /> Human tickets on
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="hidden" name="autoEscalate" value="off" />
          <input type="checkbox" name="autoEscalate" value="on" defaultChecked={program.auto_escalate} /> Auto-escalate when unsure
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="hidden" name="autoAssign" value="off" />
          <input type="checkbox" name="autoAssign" value="on" /> Auto-assign to the recommended helper
        </label>
        <div>
          <label htmlFor="sensitiveCategories" className={labelClass}>Human-only categories (comma-separated)</label>
          <input id="sensitiveCategories" name="sensitiveCategories" placeholder="money, reimbursement, safety" className={inputClass} />
          <p className="mt-1 text-xs text-text-muted">Matching questions skip the AI entirely and go straight to humans.</p>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="slaUnassignedMin" className={labelClass}>Flag unassigned after (min)</label>
            <input id="slaUnassignedMin" name="slaUnassignedMin" placeholder="e.g. 120" className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label htmlFor="slaAssignedMin" className={labelClass}>Flag assigned idle after (min)</label>
            <input id="slaAssignedMin" name="slaAssignedMin" placeholder="e.g. 240" className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label htmlFor="slaWaitingMin" className={labelClass}>Flag waiting after (min)</label>
            <input id="slaWaitingMin" name="slaWaitingMin" placeholder="e.g. 180" className={`${inputClass} font-mono`} />
          </div>
        </div>
        {settingsState.error && <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{settingsState.error}</p>}
        <SubmitButton>Save behavior</SubmitButton>
      </form>

      <form action={sourcesAction} className="space-y-4 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Knowledge sources</h2>
        <input type="hidden" name="programId" value={program.id} />
        {program.sources.map((s, i) => (
          <div key={i} className="grid grid-cols-[110px_1fr] gap-2">
            <input name="sourceType" defaultValue={s.type} className={inputClass} aria-label="Source type" />
            <input name="sourceUrl" defaultValue={s.url ?? ""} className={inputClass} aria-label="Source URL" />
          </div>
        ))}
        <div className="grid grid-cols-[110px_1fr] gap-2">
          <select name="sourceType" defaultValue="url" className={inputClass} aria-label="Source type">
            <option value="url">Web docs</option>
            <option value="github-dir">GitHub dir</option>
            <option value="gdoc">Google Doc</option>
            <option value="json-faq">JSON FAQ</option>
          </select>
          <input name="sourceUrl" placeholder="https://… (add another)" className={inputClass} />
        </div>
        {sourcesState.error && <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{sourcesState.error}</p>}
        <SubmitButton>Save sources</SubmitButton>
      </form>
    </div>
  );
}
