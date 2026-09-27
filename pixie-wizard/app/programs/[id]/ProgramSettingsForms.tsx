"use client";

import { useActionState, useState } from "react";
import { saveHostedSettings, saveHostedSources } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { BEHAVIOR_FIELDS, behaviorFlag, effectiveBehavior, type BehaviorSection, type HelpBehavior, type MainBehavior, type ProgramBehavior } from "@/lib/types";
import { MAX_SOURCES, RECOMMENDED_SOURCES } from "@/lib/onboardingDraft";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import { EmptyState, Notice, Section } from "@/app/_components/DashboardShell";
import { IconBook, IconCheck, IconDoc } from "@/app/_components/icons";
import {
  PixelIconGitHub,
  PixelIconGoogleDoc,
  PixelIconMarkdown,
  PixelIconNotion,
} from "@/app/_components/PixelIcons";
import { Select } from "@/app/_components/Select";
import type { DocSource, HostedProgramRow } from "@/lib/types";

const initialState: ActionState = { error: null };

function FormError({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <Notice tone="error">{state.error}</Notice>;
}

// A sub-heading inside a bordered section: same eyebrow voice as the section
// title, so the form reads as three named groups instead of one long column.
// The rule under it is what separates the group from the field labels under it
// — they share a size, a case and a colour, so without it the two read as one
// flat list of uppercase words.
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3.5">
      <p className="pixie-eyebrow flex items-center gap-2 border-b border-line pb-2 text-text-muted">
        <span className="pixie-mark" aria-hidden="true" />
        {title}
      </p>
      {children}
    </div>
  );
}

// A boolean setting. The real checkbox stays in the form (with its paired
// "off" hidden input, so the action still sees on|off); what you see is a
// square-cornered switch drawn in the panel vocabulary, 32x18 with a 12px
// block that slides. Screen readers still get a checkbox and its state.
function Toggle({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="relative flex cursor-pointer items-center gap-3 py-2.5 pl-11 pr-2 text-[13px] text-text">
      <input type="hidden" name={name} value="off" />
      <input type="checkbox" name={name} value="on" defaultChecked={defaultChecked} className="peer sr-only" />
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-1/2 h-[18px] w-[32px] -translate-y-1/2 border border-line-strong bg-panel-2 transition-colors peer-checked:border-brand/60 peer-checked:bg-brand/15 peer-focus-visible:shadow-[inset_0_0_0_2px_var(--color-brand)]"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute left-[3px] top-1/2 size-3 -translate-y-1/2 bg-text-muted transition-transform peer-checked:translate-x-[14px] peer-checked:bg-lime"
      />
      {label}
    </label>
  );
}

export interface BehaviorValue {
  main: MainBehavior;
  help: HelpBehavior;
}

export function BehaviorToggles({ value, onChange }: { value: BehaviorValue; onChange: (section: BehaviorSection, key: string, on: boolean) => void }) {
  return (
    <div className="space-y-4">
      {(["main", "help"] as const).map((section) => (
        <fieldset key={section} className="space-y-2">
          <legend className="text-[13px] font-semibold text-text">{section === "main" ? "Main channel" : "Help channel"}</legend>
          {BEHAVIOR_FIELDS.filter((field) => field.section === section).map((field) => (
            <label key={field.key} className="flex gap-3 rounded-[2px] border border-line px-3 py-2.5 text-[13px] text-text">
              <input type="checkbox" className="mt-0.5 accent-brand" checked={behaviorFlag(value[section], field.key)} onChange={(event) => onChange(section, field.key, event.target.checked)} />
              <span><span className="block">{field.label}</span><span className="mt-0.5 block text-xs text-text-muted">{field.help}</span></span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export function BehaviorHiddenInputs({ value }: { value: BehaviorValue }) {
  return <>{BEHAVIOR_FIELDS.map((field) => <input key={`${field.section}.${field.key}`} type="hidden" name={`behavior.${field.section}.${field.key}`} value={behaviorFlag(value[field.section], field.key) ? "on" : "off"} />)}</>;
}

export function ProgramSettingsForms({ program }: { program: HostedProgramRow }) {
  const [settingsState, settingsAction] = useActionState(saveHostedSettings, initialState);
  // Routing flags live in the settings JSON blob, not in their own columns.
  const programSettings = (program.settings ?? {}) as Record<string, unknown>;
  const [sourcesState, sourcesAction] = useActionState(saveHostedSources, initialState);
  const [behavior, setBehavior] = useState<BehaviorValue>(() => effectiveBehavior(program.behavior));
  // The add row's kind picker is a real control, so the mark beside it only has
  // to follow what is already selected.
  const [newKind, setNewKind] = useState("url");

  return (
    <div className="space-y-8">
      <Section
        title="Behavior"
        description="How Pixie answers here, what she escalates, and when she hands work to a person."
        bordered
      >
        <form action={settingsAction} className="space-y-6">
          <input type="hidden" name="programId" value={program.id} />
          <BehaviorHiddenInputs value={behavior} />

          <Group title="Identity">
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
              <input id="replySignature" name="replySignature" defaultValue={program.reply_signature ?? ""} maxLength={120} placeholder="stay helpful :demo:" className={inputClass} />
              <p className="mt-1.5 text-[13px] text-text-muted">Optional text added to normal Pixie answers.</p>
            </div>

            <div>
              <label htmlFor="programDescription" className={labelClass}>Program description</label>
              <textarea id="programDescription" name="programDescription" defaultValue={program.program_description ?? ""} rows={2} className={`${inputClass} resize-y`} />
            </div>
          </Group>

          <Group title="Channel behavior">
            <BehaviorToggles value={behavior} onChange={(section, key, on) => setBehavior((current) => ({ ...current, [section]: { ...current[section], [key]: on } }))} />
          </Group>

          <Group title="Answers">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="posture" className={labelClass}>Posture</label>
                <Select
                  id="posture"
                  name="posture"
                  defaultValue={program.posture}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "passive", label: "Passive" },
                    { value: "muted", label: "Muted" },
                  ]}
                />
              </div>
              <div>
                <label htmlFor="scope" className={labelClass}>Answer scope</label>
                <Select
                  id="scope"
                  name="scope"
                  defaultValue={program.scope}
                  options={[
                    { value: "program", label: "Program only" },
                    { value: "any", label: "Anything" },
                  ]}
                />
              </div>
            </div>

            <div>
              <label htmlFor="sensitiveCategories" className={labelClass}>Human-only categories</label>
              <input id="sensitiveCategories" name="sensitiveCategories" placeholder="money, reimbursement, safety" className={inputClass} />
              <p className="mt-1.5 text-[13px] text-text-muted">Comma-separated. Matching questions skip the AI and go straight to humans.</p>
            </div>
          </Group>

          <Group title="Escalation">
            <div>
              <label htmlFor="incidentMode" className={labelClass}>When an incident is active</label>
              <Select
                id="incidentMode"
                name="incidentMode"
                defaultValue={program.incident_mode}
                options={[
                  { value: "ANSWER_AND_TRACK", label: "Answer with the known issue, track affected threads" },
                  { value: "ANSWER_ONLY", label: "Answer with the known issue only" },
                  { value: "NORMAL_TICKET", label: "Always open a normal ticket" },
                ]}
              />
              <p className="mt-1.5 text-[13px] text-text-muted">Applies only while an incident is declared active on Support radar.</p>
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
          </Group>

          <Group title="Switches">
            <div className="pixie-panel-raised divide-y divide-line px-3">
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
            <p className="text-[13px] text-text-muted">
              With @-mentions on, a ticket Pixie can&apos;t answer asks one helper by name and says why it picked
              them — most &ldquo;reviews&rdquo; questions resolved, most replies on the topic. Off, the ticket waits in the
              queue silently. Helpers can toggle public tickets live with{" "}
              <code className="pixie-chip align-middle">/pixie-program tickets on|off</code> in the channel.
            </p>
          </Group>

          <FormError state={settingsState} />
          <SubmitButton>
            <IconCheck size={16} />
            Save behavior
          </SubmitButton>
        </form>
      </Section>

      <Section
        title="Knowledge sources"
        description="Where Pixie looks for answers. Knowledge shows what the index picked up."
        bordered
      >
        <form action={sourcesAction} className="space-y-5">
          <input type="hidden" name="programId" value={program.id} />

          {program.sources.length === 0 ? (
            <EmptyState
              title="No knowledge sources yet."
              hint="Add one below and Pixie starts reading it."
            />
          ) : (
            <SourceEditor sources={program.sources} />
          )}

          <div className="pixie-panel-raised p-4">
            <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
              <span className="pixie-mark" aria-hidden="true" />
              Add a source
            </p>
            {/* The mark follows the kind picker, so the row previews the kind
                before anything is typed, and it rails the fields below it the
                way it rails a card on the Knowledge page. */}
            <div className="mt-3.5 flex items-start gap-5">
              <span className="mt-6 grid size-8 shrink-0 place-items-center text-text">{kindMark(newKind, "")}</span>
              <div className="min-w-0 flex-1 space-y-3.5">
                <div>
                  <label htmlFor="newSourceType" className={labelClass}>Type</label>
                  <Select
                    id="newSourceType"
                    name="sourceType"
                    defaultValue="url"
                    ariaLabel="Source type"
                    onValueChange={setNewKind}
                    options={[
                      { value: "url", label: "Web page" },
                      { value: "github-dir", label: "GitHub" },
                      { value: "gdoc", label: "Google Docs" },
                      { value: "json-faq", label: "FAQ file" },
                    ]}
                  />
                </div>
                <div>
                  <label htmlFor="newSourceUrl" className={labelClass}>Link</label>
                  <input
                    id="newSourceUrl"
                    name="sourceUrl"
                    placeholder="https://…"
                    className={`${inputClass} min-w-0 font-mono`}
                  />
                </div>
                <div>
                  <label htmlFor="newSourceLabel" className={labelClass}>Source name</label>
                  <input
                    id="newSourceLabel"
                    name="sourceLabel"
                    required
                    placeholder="Community handbook"
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          </div>

          {program.sources.length === 0 ? null : <KnowledgeQuality count={program.sources.length} />}

          <FormError state={sourcesState} />
          <SubmitButton>
            <IconCheck size={16} />
            Save sources
          </SubmitButton>
        </form>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The source list editor. The same three columns the onboarding Docs step    */
/*  gives each resource — a pixel mark for the kind, what it is, and where it  */
/*  lives — so a program with five feeds reads as five named things rather     */
/*  than five anonymous rows of type and URL.                                  */
/* -------------------------------------------------------------------------- */

// Mark, type, link. `minmax(0, …)` throughout, because an unbreakable URL in a
// bare auto track is what pushes a page sideways on a phone.
const EDITOR_GRID =
  "grid grid-cols-1 items-center gap-x-3 gap-y-2.5 sm:grid-cols-[minmax(0,15rem)_7rem_minmax(0,1fr)]";

// The column headings only make sense on the row layout; on a phone each field
// carries its own label instead.
function MobileLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="-mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted sm:hidden">
      {children}
    </span>
  );
}

function SourceEditor({ sources }: { sources: DocSource[] }) {
  return (
    <div>
      {/* The heading row carries its own rule in the table vocabulary
          (`.pixie-table`'s th edge) rather than borrowing the row divider. */}
      <div className={`${EDITOR_GRID} hidden border-b border-line-strong pb-2 sm:grid`}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Source</span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Type</span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Link</span>
      </div>
      <div className="divide-y divide-line">
        {sources.map((s, i) => (
          <div key={i} className={`${EDITOR_GRID} py-3`}>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-8 shrink-0 place-items-center text-text">{kindMark(s.type, s.url)}</span>
              <span className="truncate text-[14px] font-semibold leading-tight text-text">
                {s.name || s.label || "source"}
              </span>
            </div>
            <MobileLabel>Type</MobileLabel>
            <input name="sourceType" defaultValue={s.type} className={`${inputClass} min-w-0 font-mono`} aria-label="Source type" />
            <MobileLabel>Link</MobileLabel>
            <div className="min-w-0">
              <input
                name="sourceUrl"
                defaultValue={s.url ?? ""}
                className={`${inputClass} min-w-0 font-mono`}
                aria-label="Source URL"
              />
              {s.url ? null : (
                /* The action drops the link on an inline-text source, so an empty
                   cell here is correct rather than broken — say so instead of
                   leaving a reader to wonder. */
                <p className="mt-1.5 text-[13px] leading-snug text-text-muted">
                  The text travels with the program, so there is no link to fetch.
                </p>
              )}
            </div>
            <input type="hidden" name="sourceLabel" value={s.name ?? s.label ?? ""} />
            <input type="hidden" name="sourceContent" value={typeof s.content === "string" ? s.content : ""} />
            <input type="hidden" name="sourceContentJson" value={s.content !== undefined && typeof s.content !== "string" ? JSON.stringify(s.content) ?? "" : ""} />
            <input type="hidden" name="sourcePublic" value={s.public ? "true" : ""} />
            <input type="hidden" name="sourceSiteUrl" value={s.siteUrl ?? ""} />
          </div>
        ))}
      </div>
    </div>
  );
}

// The onboarding's knowledge-quality meter, on the same numbers the wizard
// itself caps and recommends with, so the two screens can never disagree about
// what a full set of sources is.
function KnowledgeQuality({ count }: { count: number }) {
  const bars = Math.min(count, MAX_SOURCES);
  const note =
    count === 0
      ? "Add at least one source so Pixie has something to read."
      : count < RECOMMENDED_SOURCES
        ? `Add at least ${RECOMMENDED_SOURCES} key resources for the best results.`
        : "That's a full set. You can swap sources any time.";
  return (
    <div className="flex flex-col items-start gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-text">Knowledge quality</p>
        <p className="mt-1 text-[13px] leading-snug text-text-muted">{note}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex gap-1" aria-hidden>
          {Array.from({ length: MAX_SOURCES }, (_, bar) => (
            <span
              key={bar}
              className={`h-3 w-7 rounded-[1px] ${bar < bars ? "bg-lime" : "bg-line-strong"}`}
            />
          ))}
        </div>
        <span className="font-mono text-[13px] tabular-nums text-text-muted">
          {count} / {MAX_SOURCES}
        </span>
      </div>
    </div>
  );
}

// The same mark the Knowledge page draws, from the same kind vocabulary. `url`
// is the catch-all for "a linked page", so a Notion link is recognised by host.
function kindMark(type: string, url: string | undefined): React.ReactNode {
  switch (type) {
    case "gdoc":
      return <PixelIconGoogleDoc size={32} />;
    case "github-dir":
      return <PixelIconGitHub size={32} />;
    case "text":
      return <PixelIconMarkdown size={32} />;
    case "json-faq":
      return <IconBook size={32} />;
    default:
      return isNotion(url) ? <PixelIconNotion size={32} /> : <IconDoc size={32} />;
  }
}

function isNotion(url: string | undefined): boolean {
  try {
    return url ? /(^|\.)notion\.(so|site)$/i.test(new URL(url).hostname) : false;
  } catch {
    return false;
  }
}
