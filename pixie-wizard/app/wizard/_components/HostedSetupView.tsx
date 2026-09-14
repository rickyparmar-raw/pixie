"use client";

import { useActionState, useState } from "react";
import { activateHostedProgram } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { SubmitButton } from "./SubmitButton";
import { Select as Dropdown } from "@/app/_components/Select";
import type { CoreChannel } from "@/lib/pixieCore";

const steps = ["Program", "Channels", "Identity", "Docs", "Behavior", "Helpers", "Review"];
const initialState: ActionState = { error: null };
const inputClass = "pixie-input";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="block text-xs text-text-muted"><span className="mb-2 block">{label}</span>{children}{hint && <span className="mt-2 block text-[11px] text-text-muted/70">{hint}</span>}</label>;
}

// A plain text input rather than a <select>: the channel list only reflects
// what Core's Slack client happens to already know about, and a real channel
// (or a sandbox/test one) that isn't in that list would otherwise be
// unselectable. The known channels are still offered as datalist suggestions
// for anyone who'd rather click than type an ID.
function Select({ name, channels, label }: { name: string; channels: CoreChannel[]; label: string }) {
  const listId = `${name}-options`;
  return (
    <Field label={label} hint="Slack channel ID, e.g. C0123456789. Right-click the channel in Slack, then View channel details, to find it.">
      <input
        className={inputClass}
        name={name}
        required
        list={listId}
        placeholder="C0123456789"
        pattern="[CG][A-Z0-9]{8,14}"
        title="A Slack channel ID starting with C or G (e.g. C0123456789)"
      />
      <datalist id={listId}>
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            #{channel.name}
            {channel.isMember ? "" : " · invite @Pixie"}
          </option>
        ))}
      </datalist>
    </Field>
  );
}

function Toggle({ name, label, description, checked = true }: { name: string; label: string; description: string; checked?: boolean }) {
  return <label className="flex gap-3 rounded-md border border-line px-3 py-3"><input type="hidden" name={name} value="off" /><input className="mt-0.5 accent-brand" type="checkbox" name={name} value="on" defaultChecked={checked} /><span><span className="block text-sm text-text">{label}</span><span className="mt-1 block text-xs leading-relaxed text-text-muted">{description}</span></span></label>;
}

function Stage({ step, title, description, children }: { step: number; title: string; description: string; children: React.ReactNode }) {
  return <section><p className="text-xs text-text-muted">STEP {String(step).padStart(2, "0")} / 07</p><h1 className="mt-5 text-2xl font-medium text-text">{title}</h1><p className="mt-3 max-w-xl text-sm leading-relaxed text-text-muted">{description}</p><div className="mt-8 space-y-5">{children}</div></section>;
}

export function HostedSetupView({ channels, coreLive }: { channels: CoreChannel[]; coreLive: boolean }) {
  const [state, formAction] = useActionState(activateHostedProgram, initialState);
  const [step, setStep] = useState(0);
  const [programName, setProgramName] = useState("");
  const move = (to: number) => setStep(Math.max(0, Math.min(steps.length - 1, to)));
  const next = () => move(step + 1);
  return <main className="mx-auto min-h-screen max-w-5xl px-5 py-6 sm:px-8"><header className="flex items-center justify-between border-b border-line pb-5"><a href="/wizard" className="flex items-center gap-2 text-sm font-medium text-text"><span className="grid size-7 place-items-center rounded-full bg-brand text-ink">✦</span>pixie</a><a href="/programs" className="text-xs text-text-muted hover:text-text">Open dashboard ›</a></header><div className="mx-auto mt-16 max-w-[680px]"><nav aria-label="Hosted setup progress" className="mb-7 flex items-center gap-2">{steps.map((name, index) => <button type="button" key={name} onClick={() => index <= step && move(index)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className={`grid size-6 shrink-0 place-items-center rounded-full border text-[11px] ${index === step ? "border-brand bg-brand text-ink" : index < step ? "border-mint text-mint" : "border-line text-text-muted"}`}>{index + 1}</span><span className={`hidden text-xs sm:block ${index === step ? "text-text" : "text-text-muted"}`}>{name}</span>{index < steps.length - 1 && <span className="h-px flex-1 bg-line" />}</button>)}</nav><form action={formAction} className="pixie-panel p-6 sm:p-9">{!coreLive && <p className="mb-6 rounded-md border border-tang/40 bg-tang/10 p-3 text-xs text-tang">Pixie Core is temporarily unreachable. Your configuration will sync when it is available.</p>}
    <div hidden={step !== 0}><Stage step={1} title="What's the program?" description="This shows up in how Pixie introduces itself and answers questions."><Field label="Program name"><input className={inputClass} name="programName" required maxLength={80} value={programName} onChange={(event) => setProgramName(event.target.value)} placeholder="Your program" /></Field><Field label="Short description · optional"><textarea className={inputClass} name="programDescription" rows={3} placeholder="A short line about what members are building" /></Field></Stage></div>
    <div hidden={step !== 1}><Stage step={2} title="Where should Pixie help?" description="Choose the channel where members ask for help and the private channel where helpers receive escalations."><Select name="helpChannelId" channels={channels} label="Help channel" /><Select name="organizerChannelId" channels={channels} label="Organizer channel" /><input type="hidden" name="allowPublicOrganizer" value="off" /><p className="text-xs text-text-muted">Questions and public replies happen in the help channel. Private tickets and claim controls stay in the organizer channel.</p></Stage></div>
    <div hidden={step !== 2}><Stage step={3} title="Make Pixie yours" description="Choose how Pixie appears when helping members of this program."><Field label="Support bot name"><input className={inputClass} name="supportName" maxLength={80} placeholder={programName ? `${programName} Help` : "Program Help"} /></Field><Field label="Bot logo / avatar" hint="Use an approved Wizard storage URL. Image bytes are never saved in database rows."><input className={inputClass} name="iconUrl" type="url" placeholder="https://.../avatar.png" /></Field><div className="rounded-md border border-line bg-panel-2 p-4"><p className="text-xs text-text-muted">Live Slack message preview</p><div className="mt-3 flex gap-3"><span className="grid size-8 place-items-center rounded-md bg-brand text-xs text-ink">PX</span><p className="text-xs leading-relaxed text-text"><b>{programName ? `${programName} Help` : "Pixie Help"}</b> <span className="text-text-muted">APP · just now</span><br />Pixie answers from your program&apos;s docs and flags anything a human should review.</p></div></div></Stage></div>
    <div hidden={step !== 3}><Stage step={4} title="Point Pixie at your docs" description="Add every page, FAQ, or doc Pixie should answer questions from. You can add more later."><Field label="Primary source"><div className="grid gap-2 sm:grid-cols-[170px_1fr]"><Dropdown name="sourceType" defaultValue="url" ariaLabel="Source type" options={[{ value: "url", label: "Web docs" }, { value: "github-dir", label: "GitHub dir" }, { value: "gdoc", label: "Google Doc" }, { value: "json-faq", label: "JSON FAQ" }]} /><input className={inputClass} name="sourceUrl" required placeholder="https://docs.example.com" /></div></Field><Field label="Additional source · optional"><div className="grid gap-2 sm:grid-cols-[170px_1fr]"><Dropdown name="sourceType" defaultValue="url" ariaLabel="Source type" options={[{ value: "url", label: "Web docs" }, { value: "github-dir", label: "GitHub dir" }, { value: "gdoc", label: "Google Doc" }, { value: "json-faq", label: "JSON FAQ" }]} /><input className={inputClass} name="sourceUrl" placeholder="https://..." /></div></Field></Stage></div>
    <div hidden={step !== 4}><Stage step={5} title="How should Pixie help?" description="Keep support behavior simple. Pixie is hosted, so there are no model or provider settings to configure."><Toggle name="aiAnswers" label="AI answers" description="Allow Pixie to answer questions when it has enough grounded information." /><Toggle name="ticketsEnabled" label="Human handoff" description="Escalate sensitive, uncertain, or explicitly human-directed questions." /><Toggle name="autoEscalate" label="Source citations" description="Show relevant sources when useful." /><div className="grid gap-3 sm:grid-cols-2"><Field label="Posture"><Dropdown name="posture" defaultValue="active" ariaLabel="Posture" options={[{ value: "active", label: "Active" }, { value: "passive", label: "Passive" }, { value: "muted", label: "Muted" }]} /></Field><Field label="Answer scope"><Dropdown name="scope" defaultValue="program" ariaLabel="Answer scope" options={[{ value: "program", label: "Program only" }, { value: "any", label: "Anything" }]} /></Field></div></Stage></div>
    <div hidden={step !== 5}><Stage step={6} title="Who's helping?" description="Add people who can claim, resolve, and support Pixie tickets in the private organizer channel."><Field label="Initial helper Slack user IDs · optional" hint="The creator is automatically an owner and organizer."><input className={inputClass} name="initialHelperIds" placeholder="U01234567, U02345678" /></Field><Toggle name="autoAssign" label="Auto-assign" description="Route tickets to available helpers based on their expertise." checked={false} /></Stage></div>
    <div hidden={step !== 6}><Stage step={7} title="Ready to ship Pixie?" description={`Review the basics, then activate Pixie for ${programName || "your program"}. You can edit everything later.`}><dl className="divide-y divide-line border-y border-line text-sm"><div className="flex justify-between py-3"><dt className="text-text-muted">Program</dt><dd>{programName || "Not named yet"}</dd></div><div className="flex justify-between py-3"><dt className="text-text-muted">Support identity</dt><dd>Configured</dd></div><div className="flex justify-between py-3"><dt className="text-text-muted">Knowledge</dt><dd>Sources configured</dd></div><div className="flex justify-between py-3"><dt className="text-text-muted">Behavior</dt><dd>Grounded support</dd></div></dl>{state.error && <p className="rounded-md border border-brand/40 bg-brand/10 p-3 text-sm text-brand">{state.error}</p>}</Stage></div>
    <footer className="mt-8 flex items-center justify-between border-t border-line pt-5"><span className="text-xs text-text-muted">Hosted Pixie · no keys required</span>{step === 6 ? <SubmitButton block pendingLabel="Activating Pixie...">Activate Pixie</SubmitButton> : <div className="flex gap-2"><button type="button" onClick={() => move(step - 1)} disabled={step === 0} className="pixie-button pixie-button-quiet disabled:opacity-30">Back</button><button type="button" onClick={next} className="pixie-button pixie-button-primary">Continue ›</button></div>}</footer>
  </form></div></main>;
}
