"use client";

import { useActionState } from "react";
import { saveHostedSettings, saveHostedSources } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import type { HostedProgramRow } from "@/lib/types";

const initialState: ActionState = { error: null };

function FormError({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>;
}

function Toggle({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-text">
      <input type="hidden" name={name} value="off" />
      <input type="checkbox" name={name} value="on" defaultChecked={defaultChecked} className="accent-brand" />
      {label}
    </label>
  );
}

export function ProgramSettingsForms({ program }: { program: HostedProgramRow }) {
  const [settingsState, settingsAction] = useActionState(saveHostedSettings, initialState);
  // Routing flags live in the settings JSON blob, not in their own columns.
  const programSettings = (program.settings ?? {}) as Record<string, unknown>;
  const [sourcesState, sourcesAction] = useActionState(saveHostedSources, initialState);

  return (
    <div className="max-w-2xl space-y-12">
      <form action={settingsAction} className="space-y-5">
        <h2 className="text-sm font-medium text-text">Behavior</h2>
        <input type="hidden" name="programId" value={program.id} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="supportName" className={labelClass}>Support display name</label>
            <input id="supportName" name="supportName" defaultValue={program.support_name ?? ""} maxLength={80} className={inputClass} />
          </div>
          <div>
            <label htmlFor="iconUrl" className={labelClass}>Support avatar URL</label>
            <input id="iconUrl" name="iconUrl" defaultValue={program.icon_url ?? ""} placeholder="https://…/avatar.png" className={inputClass} />
          </div>
        </div>

        <div>
          <label htmlFor="replySignature" className={labelClass}>Reply signature</label>
          <input id="replySignature" name="replySignature" defaultValue={program.reply_signature ?? ""} maxLength={120} placeholder="stay wired :hardwire:" className={inputClass} />
          <p className="mt-1 text-xs text-text-muted">Optional text added to normal Pixie answers.</p>
        </div>

        <div>
          <label htmlFor="programDescription" className={labelClass}>Program description</label>
          <textarea id="programDescription" name="programDescription" defaultValue={program.program_description ?? ""} rows={2} className={inputClass} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
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

        <div className="space-y-2.5 border-t border-line pt-4">
          <Toggle name="aiAnswers" label="AI answers on" defaultChecked={program.ai_answers} />
          <Toggle name="ticketsEnabled" label="Human tickets on" defaultChecked={program.tickets_enabled} />
          <Toggle name="autoEscalate" label="Auto-escalate when unsure" defaultChecked={program.auto_escalate} />
          <Toggle name="autoAssign" label="Auto-assign to the recommended helper" defaultChecked={programSettings.autoAssign === true} />
          <Toggle
            name="helperPing"
            label="@-mention the best-matched helper in the thread"
            defaultChecked={programSettings.helperPing === true}
          />
          <Toggle name="publicTicketsEnabled" label="Auto-open tickets from the public help channel" defaultChecked={program.public_tickets_enabled} />
        </div>
        <p className="text-xs text-text-muted">
          With @-mentions on, a ticket Pixie can&apos;t answer asks one helper by name and says why it picked
          them — most &ldquo;reviews&rdquo; questions resolved, most replies on the topic. Off, the ticket waits in the
          queue silently. Helpers can toggle public tickets live with <code>/pixie-program tickets on|off</code> in the channel.
        </p>

        <div>
          <label htmlFor="incidentMode" className={labelClass}>When an incident is active</label>
          <select id="incidentMode" name="incidentMode" defaultValue={program.incident_mode} className={inputClass}>
            <option value="ANSWER_AND_TRACK">Answer with the known issue, track affected threads</option>
            <option value="ANSWER_ONLY">Answer with the known issue only</option>
            <option value="NORMAL_TICKET">Always open a normal ticket</option>
          </select>
          <p className="mt-1 text-xs text-text-muted">Applies only while an incident is declared active on Support radar.</p>
        </div>

        <div>
          <label htmlFor="sensitiveCategories" className={labelClass}>Human-only categories</label>
          <input id="sensitiveCategories" name="sensitiveCategories" placeholder="money, reimbursement, safety" className={inputClass} />
          <p className="mt-1 text-xs text-text-muted">Comma-separated. Matching questions skip the AI and go straight to humans.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="slaUnassignedMin" className={labelClass}>Flag unassigned after (min)</label>
            <input id="slaUnassignedMin" name="slaUnassignedMin" placeholder="120" className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label htmlFor="slaAssignedMin" className={labelClass}>Flag assigned idle after (min)</label>
            <input id="slaAssignedMin" name="slaAssignedMin" placeholder="240" className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label htmlFor="slaWaitingMin" className={labelClass}>Flag waiting after (min)</label>
            <input id="slaWaitingMin" name="slaWaitingMin" placeholder="180" className={`${inputClass} font-mono`} />
          </div>
        </div>

        <FormError state={settingsState} />
        <SubmitButton>Save behavior</SubmitButton>
      </form>

      <form action={sourcesAction} className="space-y-4 border-t border-line pt-10">
        <h2 className="text-sm font-medium text-text">Knowledge sources</h2>
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
        <FormError state={sourcesState} />
        <SubmitButton>Save sources</SubmitButton>
      </form>
    </div>
  );
}
