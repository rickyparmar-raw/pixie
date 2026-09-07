"use client";

import { useActionState } from "react";
import { activateHostedProgram } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/app/wizard/actions";
import { SubmitButton } from "./SubmitButton";
import { inputClass, labelClass } from "./formStyles";
import type { CoreChannel } from "@/lib/pixieCore";

const initialState: ActionState = { error: null };

function Section({ n, title, hint, children }: { n: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-6">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-brand">{n}</p>
      <h2 className="font-heading mt-2 text-lg text-text">{title}</h2>
      <p className="mt-1 text-sm text-text-muted">{hint}</p>
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}

function ChannelSelect({
  name,
  channels,
}: {
  name: string;
  channels: CoreChannel[];
}) {
  return (
    <div>
      <select name={name} defaultValue="" className={inputClass}>
        <option value="" disabled>
          Choose a channel…
        </option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name} {c.isMember ? "· Pixie has access" : "· invite @Pixie"}
          </option>
        ))}
      </select>
      <details className="mt-2 text-xs text-text-muted">
        <summary className="cursor-pointer underline">Channel not listed? Paste its ID</summary>
        <input name={`${name}Raw`} placeholder="C0123456789" className={`${inputClass} mt-2 font-mono`} />
        <p className="mt-1">Raw IDs work for private channels Pixie can already see. If Pixie lacks access, run <code>/invite @Pixie</code> in the channel first.</p>
      </details>
    </div>
  );
}

export function HostedSetupView({ channels, coreLive }: { channels: CoreChannel[]; coreLive: boolean }) {
  const [state, formAction] = useActionState(activateHostedProgram, initialState);

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">hosted pixie · shared @Pixie</p>
      <h1 className="font-heading mt-3 text-2xl text-text">Connect your program</h1>
      <p className="mt-2 text-sm text-text-muted">
        No Slack app, no tokens, no Railway, no AI keys. Pick channels, tune behavior, activate — Pixie starts answering in seconds.
      </p>
      {!coreLive && (
        <p className="mt-4 rounded-md border border-line bg-panel px-3 py-2 text-sm text-text-muted">
          Pixie Core is unreachable right now. You can still activate — your program is saved and syncs automatically once Core is back.
        </p>
      )}

      <form action={formAction} className="mt-8 space-y-6">
        <Section n="Step 1 · Program" title="What's the program?" hint="The support identity is how Pixie signs its replies.">
          <div>
            <label htmlFor="programName" className={labelClass}>Program name</label>
            <input id="programName" name="programName" required maxLength={80} placeholder="e.g. Highway" className={inputClass} />
          </div>
          <div>
            <label htmlFor="supportName" className={labelClass}>Support display name (optional)</label>
            <input id="supportName" name="supportName" maxLength={80} placeholder="e.g. Highway Help" className={inputClass} />
          </div>
        </Section>

        <Section n="Step 2 · Channels" title="Where does Pixie help?" hint="Invite @Pixie into both channels before activating.">
          <div>
            <label className={labelClass}>Help channel — members ask here</label>
            <ChannelSelect name="helpChannelId" channels={channels} />
          </div>
          <div>
            <label className={labelClass}>Organizer channel — helpers coordinate here</label>
            <ChannelSelect name="organizerChannelId" channels={channels} />
          </div>
          <div>
            <label htmlFor="extraChannelId" className={labelClass}>Extra channel IDs, one per line (optional)</label>
            <textarea id="extraChannelId" name="extraChannelId" rows={2} placeholder={"C0123456789"} className={`${inputClass} font-mono`} />
          </div>
        </Section>

        <Section n="Step 3 · AI behavior" title="When should Pixie answer?" hint="Pixie only answers from your docs. Unsure means a human gets it.">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="hidden" name="aiAnswers" value="off" />
            <input type="checkbox" name="aiAnswers" value="on" defaultChecked /> AI answers on
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="hidden" name="ticketsEnabled" value="off" />
            <input type="checkbox" name="ticketsEnabled" value="on" defaultChecked /> Human tickets on
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="hidden" name="autoEscalate" value="off" />
            <input type="checkbox" name="autoEscalate" value="on" defaultChecked /> Escalate automatically when unsure
          </label>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="posture" className={labelClass}>Posture</label>
              <select id="posture" name="posture" defaultValue="active" className={inputClass}>
                <option value="active">Active — answers when it can</option>
                <option value="passive">Passive — only when addressed</option>
                <option value="muted">Muted — silent while setting up</option>
              </select>
            </div>
            <div>
              <label htmlFor="scope" className={labelClass}>Answer scope</label>
              <select id="scope" name="scope" defaultValue="program" className={inputClass}>
                <option value="program">Program questions only</option>
                <option value="any">Anything members are stuck on</option>
              </select>
            </div>
          </div>
        </Section>

        <Section n="Step 4 · Support experience" title="How do replies feel?" hint="Shown in thread acknowledgements and ticket cards.">
          <p className="text-sm text-text-muted">Uses your support display name from Step 1. Fine-tune acknowledgement and resolve wording after activation, from the program page.</p>
        </Section>

        <Section n="Step 5 · Knowledge" title="What does Pixie know?" hint="Start with your main docs — add more anytime from the program page.">
          <div className="grid grid-cols-[110px_1fr] gap-2">
            <select name="sourceType" defaultValue="url" className={inputClass} aria-label="Source type">
              <option value="url">Web docs</option>
              <option value="github-dir">GitHub dir</option>
              <option value="gdoc">Google Doc</option>
              <option value="json-faq">JSON FAQ</option>
            </select>
            <input name="sourceUrl" placeholder="https://…" className={inputClass} />
          </div>
          <div className="grid grid-cols-[110px_1fr] gap-2">
            <select name="sourceType" defaultValue="url" className={inputClass} aria-label="Source type">
              <option value="url">Web docs</option>
              <option value="github-dir">GitHub dir</option>
              <option value="gdoc">Google Doc</option>
              <option value="json-faq">JSON FAQ</option>
            </select>
            <input name="sourceUrl" placeholder="https://… (optional second source)" className={inputClass} />
          </div>
        </Section>

        <Section n="Steps 6–7 · Helpers & retention" title="Defaults that just work" hint="You organize helpers in your organizer channel; retention uses safe defaults.">
          <p className="text-sm text-text-muted">You (the creator) start as organizer. Helper sync from the organizer channel and retention windows are managed from the program page after activation.</p>
        </Section>

        <Section n="Step 8 · Review & activate" title="Ready?" hint="Activation takes seconds. No deployment, no build, no restart.">
          {state.error && (
            <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{state.error}</p>
          )}
          <SubmitButton pendingLabel="Activating…">Activate hosted Pixie</SubmitButton>
        </Section>
      </form>
    </main>
  );
}
