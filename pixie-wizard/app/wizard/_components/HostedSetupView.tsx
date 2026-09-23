"use client";

import { useActionState, useState } from "react";
import { createSandboxProgram, launchProgramAction } from "@/app/wizard/hostedActions";
import {
  BehaviorToggles,
  behaviorFromState,
  type BehaviorValue,
} from "@/app/programs/[id]/ProgramSettingsForms";
import { effectiveBehavior, type ActionState } from "@/lib/types";
import type { CoreChannel } from "@/lib/pixieCore";
import { SubmitButton } from "./SubmitButton";
import { Select as Dropdown } from "@/app/_components/Select";
import { TestQuestionPanel } from "./TestQuestionPanel";

const steps = ["Program", "Channels", "Behavior", "Knowledge", "Helpers", "Test", "Launch"];
const initialLaunchState: ActionState = { error: null };
const inputClass = "pixie-input";

function slugifyName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 62);
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="block text-xs text-text-muted"><span className="mb-2 block">{label}</span>{children}{hint && <span className="mt-2 block text-[11px] text-text-muted/70">{hint}</span>}</label>;
}

// A plain text input rather than a <select>: the channel list only reflects
// what Core's Slack client happens to already know about, and a real channel
// (or a sandbox/test one) that isn't in that list would otherwise be
// unselectable. The known channels are still offered as datalist suggestions
// for anyone who'd rather click than type an ID.
function ChannelInput({ name, channels, label, value, onChange, disabled, optional }: {
  name: string; channels: CoreChannel[]; label: string; value: string;
  onChange: (v: string) => void; disabled?: boolean; optional?: boolean;
}) {
  const listId = `${name}-options`;
  return (
    <Field label={optional ? `${label} · optional` : label} hint="Slack channel ID, e.g. C0123456789. Right-click the channel in Slack, then View channel details, to find it.">
      <input
        className={inputClass}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
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

function Stage({ step, title, description, children }: { step: number; title: string; description: string; children: React.ReactNode }) {
  return <section><p className="text-xs text-text-muted">STEP {String(step).padStart(2, "0")} / 07</p><h1 className="mt-5 text-2xl font-medium text-text">{title}</h1><p className="mt-3 max-w-xl text-sm leading-relaxed text-text-muted">{description}</p><div className="mt-8 space-y-5">{children}</div></section>;
}

interface UrlRow { type: string; url: string }
interface TextRow { label: string; content: string }
interface HelperRow { slackId: string; role: "helper" | "organizer"; expertise: string; pings: boolean }

export function HostedSetupView({ channels, coreLive }: { channels: CoreChannel[]; coreLive: boolean }) {
  const [step, setStep] = useState(0);
  const [programName, setProgramName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [mainChannel, setMainChannel] = useState("");
  const [helpChannel, setHelpChannel] = useState("");
  const [behavior, setBehavior] = useState<BehaviorValue>(() => effectiveBehavior(null));
  const [urlRows, setUrlRows] = useState<UrlRow[]>([{ type: "url", url: "" }]);
  const [textRows, setTextRows] = useState<TextRow[]>([]);
  const [helperRows, setHelperRows] = useState<HelperRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ programId: string; syncError?: string } | null>(null);
  const [launchState, launchAction] = useActionState(launchProgramAction, initialLaunchState);

  const locked = created !== null; // sandbox exists — steps 1-5 are saved, review-only from here
  const move = (to: number) => setStep(Math.max(0, Math.min(steps.length - 1, to)));

  const onName = (v: string) => {
    setProgramName(v);
    if (!slugTouched) setSlug(slugifyName(v));
  };

  const canNext = (): boolean => {
    if (step === 0) return programName.trim().length > 0;
    if (step === 1) return mainChannel.trim().length > 0 || helpChannel.trim().length > 0;
    if (step === 3) {
      return urlRows.some((r) => r.url.trim()) || textRows.some((r) => r.content.trim());
    }
    if (step === 5) return created !== null;
    return true;
  };

  const create = async () => {
    if (creating || created) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createSandboxProgram({
        programName: programName.trim(),
        programSlug: slug.trim() || null,
        programDescription: description.trim() || null,
        supportName: null,
        iconUrl: iconUrl.trim() || null,
        mainChannelId: mainChannel.trim() || null,
        helpChannelId: helpChannel.trim() || null,
        behavior: behaviorFromState(behavior),
        sources: [
          ...urlRows.filter((r) => r.url.trim()).map((r) => ({ type: r.type as "url" | "github-dir" | "gdoc" | "json-faq", url: r.url.trim() })),
          ...textRows.filter((r) => r.content.trim()).map((r) => ({ type: "text" as const, label: r.label.trim(), content: r.content.trim() })),
        ],
        helpers: helperRows
          .filter((r) => r.slackId.trim())
          .map((r) => ({
            slackUserId: r.slackId.trim(),
            role: r.role,
            expertise: r.expertise.split(",").map((t) => t.trim()).filter(Boolean),
            eligibleForPings: r.pings,
          })),
      });
      if (!res.ok) {
        setCreateError(res.error);
        return;
      }
      setCreated({ programId: res.programId, syncError: res.syncError });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not create the sandbox program.");
    } finally {
      setCreating(false);
    }
  };

  return <main className="mx-auto min-h-screen max-w-5xl px-5 py-6 sm:px-8"><header className="flex items-center justify-between border-b border-line pb-5"><a href="/wizard" className="flex items-center gap-2 text-sm font-medium text-text"><span className="grid size-7 place-items-center rounded-full bg-brand text-ink">✦</span>pixie</a><a href="/programs" className="text-xs text-text-muted hover:text-text">Open dashboard ›</a></header><div className="mx-auto mt-16 max-w-[680px]"><nav aria-label="Hosted setup progress" className="mb-7 flex items-center gap-2">{steps.map((name, index) => <button type="button" key={name} onClick={() => index <= step && move(index)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className={`grid size-6 shrink-0 place-items-center rounded-full border text-[11px] ${index === step ? "border-brand bg-brand text-ink" : index < step ? "border-mint text-mint" : "border-line text-text-muted"}`}>{index + 1}</span><span className={`hidden text-xs sm:block ${index === step ? "text-text" : "text-text-muted"}`}>{name}</span>{index < steps.length - 1 && <span className="h-px flex-1 bg-line" />}</button>)}</nav><div className="pixie-panel p-6 sm:p-9">{!coreLive && <p className="mb-6 rounded-md border border-tang/40 bg-tang/10 p-3 text-xs text-tang">Pixie Core is temporarily unreachable. Your configuration will sync when it is available.</p>}
    {locked && step < 5 && <p className="mb-6 rounded-md border border-line bg-panel-2 p-3 text-xs text-text-muted">Sandbox created — these settings are saved. Change them later in program settings.</p>}
    <fieldset disabled={locked && step < 5} className="contents">
    <div hidden={step !== 0}><Stage step={1} title="What's the program?" description="This shows up in how Pixie introduces itself and answers questions."><Field label="Program name"><input className={inputClass} name="programName" required maxLength={80} value={programName} onChange={(event) => onName(event.target.value)} placeholder="Your program" /></Field><Field label="URL slug · auto-filled, editable" hint="Lowercase letters, numbers and hyphens, 3-62 characters."><input className={inputClass} name="programSlug" value={slug} onChange={(event) => { setSlug(event.target.value); setSlugTouched(true); }} placeholder="your-program" pattern="[a-z0-9][a-z0-9-]{1,60}[a-z0-9]" title="Lowercase slug, e.g. my-program" /></Field><Field label="Short description · optional"><textarea className={inputClass} name="programDescription" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A short line about what members are building" /></Field><Field label="Logo URL · optional" hint="A secure https:// image. Shown as Pixie's avatar for this program."><input className={inputClass} name="iconUrl" type="url" value={iconUrl} onChange={(event) => setIconUrl(event.target.value)} placeholder="https://…/avatar.png" /></Field></Stage></div>
    <div hidden={step !== 1}><Stage step={2} title="Where should Pixie help?" description="Pick a main channel, a help channel, or both — at least one is required. Pixie must already be a member of each."><ChannelInput name="mainChannelId" channels={channels} label="Main channel" value={mainChannel} onChange={setMainChannel} optional /><ChannelInput name="helpChannelId" channels={channels} label="Help channel" value={helpChannel} onChange={setHelpChannel} optional /><p className="text-xs text-text-muted">The main channel is where members hang out; the help channel is where members ask for support. Tip: run /invite @Pixie in each channel first.</p></Stage></div>
    <div hidden={step !== 2}><Stage step={3} title="How should Pixie help?" description="Flip what Pixie does in each channel. You can change everything later in settings."><BehaviorToggles value={behavior} onChange={(section, key, on) => setBehavior((prev) => ({ ...prev, [section]: { ...prev[section], [key]: on } }))} /></Stage></div>
    <div hidden={step !== 3}><Stage step={4} title="Point Pixie at your docs" description="Add every page, FAQ, or doc Pixie should answer from — as URLs or pasted text. Ingestion runs in the background; you can continue right away.">{urlRows.map((row, i) => <Field key={`url-${i}`} label={i === 0 ? "Docs URL" : `Docs URL · ${i + 1}`}><div className="grid gap-2 sm:grid-cols-[170px_1fr]"><Dropdown name={`sourceType-${i}`} defaultValue={row.type} ariaLabel="Source type" options={[{ value: "url", label: "Web docs" }, { value: "github-dir", label: "GitHub dir" }, { value: "gdoc", label: "Google Doc" }, { value: "json-faq", label: "JSON FAQ" }]} onValueChange={(v) => setUrlRows((rows) => rows.map((r, j) => (j === i ? { ...r, type: v } : r)))} /><input className={inputClass} value={row.url} onChange={(e) => setUrlRows((rows) => rows.map((r, j) => (j === i ? { ...r, url: e.target.value } : r)))} placeholder="https://docs.example.com" /></div></Field>)}<button type="button" onClick={() => setUrlRows((rows) => [...rows, { type: "url", url: "" }])} className="pixie-button pixie-button-quiet">+ Add URL</button>{textRows.map((row, i) => <div key={`text-${i}`} className="space-y-2"><Field label={`Pasted text · ${i + 1}`}><input className={inputClass} value={row.label} onChange={(e) => setTextRows((rows) => rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))} placeholder="Name these notes, e.g. Refund policy" /></Field><textarea className={inputClass} rows={4} value={row.content} onChange={(e) => setTextRows((rows) => rows.map((r, j) => (j === i ? { ...r, content: e.target.value } : r)))} placeholder="Paste the text Pixie should answer from…" /></div>)}<div><button type="button" onClick={() => setTextRows((rows) => [...rows, { label: "", content: "" }])} className="pixie-button pixie-button-quiet">+ Paste text</button></div></Stage></div>
    <div hidden={step !== 4}><Stage step={5} title="Who's helping?" description="Add people who can claim and resolve tickets. The creator is automatically an owner.">{helperRows.map((row, i) => <div key={`helper-${i}`} className="space-y-2 rounded-md border border-line p-3"><Field label="Slack user ID"><input className={`${inputClass} font-mono`} value={row.slackId} onChange={(e) => setHelperRows((rows) => rows.map((r, j) => (j === i ? { ...r, slackId: e.target.value } : r)))} placeholder="U01234567" pattern="[UW][A-Z0-9]{8,14}" title="A Slack user ID like U01234567" /></Field><div className="grid gap-2 sm:grid-cols-2"><Field label="Role"><Dropdown name={`helperRole-${i}`} defaultValue={row.role} ariaLabel="Helper role" options={[{ value: "helper", label: "Helper" }, { value: "organizer", label: "Organizer" }]} onValueChange={(v) => setHelperRows((rows) => rows.map((r, j) => (j === i ? { ...r, role: v === "organizer" ? "organizer" : "helper" } : r)))} /></Field><Field label="Expertise · comma-separated"><input className={inputClass} value={row.expertise} onChange={(e) => setHelperRows((rows) => rows.map((r, j) => (j === i ? { ...r, expertise: e.target.value } : r)))} placeholder="refunds, shipping" /></Field></div><label className="flex items-center gap-2.5 text-sm text-text"><input type="checkbox" checked={row.pings} onChange={(e) => setHelperRows((rows) => rows.map((r, j) => (j === i ? { ...r, pings: e.target.checked } : r)))} className="accent-brand" />Eligible for helper pings</label></div>)}<div><button type="button" onClick={() => setHelperRows((rows) => [...rows, { slackId: "", role: "helper", expertise: "", pings: true }])} className="pixie-button pixie-button-quiet">+ Add helper</button></div></Stage></div>
    </fieldset>
    <div hidden={step !== 5}><Stage step={6} title="Try it in the sandbox" description="Your program exists as a sandbox — nothing public yet. Ask a test question to see what Pixie would do.">{!created ? <div className="space-y-3"><p className="text-sm text-text-muted">Create the sandbox program first (channels, behavior, docs and helpers from the previous steps are saved together).</p>{createError && <p className="rounded-md border border-brand/40 bg-brand/10 p-3 text-sm text-brand">{createError}</p>}<button type="button" onClick={create} disabled={creating} className="pixie-button pixie-button-primary">{creating ? "Creating sandbox…" : "Create sandbox program"}</button></div> : <div className="space-y-4">{created.syncError && <p className="rounded-md border border-tang/40 bg-tang/10 p-3 text-xs text-tang">{created.syncError}</p>}<TestQuestionPanel programId={created.programId} /></div>}</Stage></div>
    <div hidden={step !== 6}><Stage step={7} title="Ready to launch?" description={created ? `Review the basics, then launch ${programName || "your program"}. This flips it from sandbox to live — Pixie starts answering in its channels.` : "Create the sandbox first (step 6), then come back to launch."}>{created && <><dl className="divide-y divide-line border-y border-line text-sm"><div className="flex justify-between py-3"><dt className="text-text-muted">Program</dt><dd>{programName || created.programId}</dd></div><div className="flex justify-between py-3"><dt className="text-text-muted">Channels</dt><dd>{[mainChannel.trim() && "main", helpChannel.trim() && "help"].filter(Boolean).join(" + ") || "—"}</dd></div><div className="flex justify-between py-3"><dt className="text-text-muted">Status</dt><dd>Sandbox → live</dd></div></dl><form action={launchAction} className="mt-5 space-y-3"><input type="hidden" name="programId" value={created.programId} /><label className="flex items-center gap-2.5 text-sm text-text"><input type="checkbox" name="confirm" value="launch" required className="accent-brand" />Launch — Pixie starts answering in these channels.</label>{launchState.error && <p className="rounded-md border border-brand/40 bg-brand/10 p-3 text-sm text-brand">{launchState.error}</p>}<SubmitButton block pendingLabel="Launching…">Launch Pixie</SubmitButton></form></>}</Stage></div>
    <footer className="mt-8 flex items-center justify-between border-t border-line pt-5"><span className="text-xs text-text-muted">Hosted Pixie · no keys required</span><div className="flex gap-2"><button type="button" onClick={() => move(step - 1)} disabled={step === 0} className="pixie-button pixie-button-quiet disabled:opacity-30">Back</button>{step === 5 && !created ? <button type="button" onClick={create} disabled={creating || !canNext()} className="pixie-button pixie-button-primary disabled:opacity-30">{creating ? "Creating…" : "Create sandbox ›"}</button> : step < 6 ? <button type="button" onClick={() => move(step + 1)} disabled={!canNext()} className="pixie-button pixie-button-primary disabled:opacity-30">Continue ›</button> : null}</div></footer>
  </div></div></main>;
}
