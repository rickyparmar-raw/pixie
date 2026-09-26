"use client";

import { Select } from "@/app/_components/Select";

import { useActionState } from "react";
import { hostedMacroSave, hostedMacroDelete, hostedMacroSend, hostedMacroBulkSend } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass, btnPrimary } from "@/app/wizard/_components/formStyles";
import { Section, Notice, Chip } from "@/app/_components/DashboardShell";
import { IconMacro, IconPlus, IconExit, IconArrowRight } from "@/app/_components/icons";

const initialState: ActionState = { error: null };

export interface MacroRow {
  id: number;
  trigger: string;
  name: string;
  description: string | null;
  content: string;
  enabled: number;
  on_send_transition: string | null;
}

export interface MacroTemplate {
  trigger: string;
  name: string;
  description?: string | null;
  content: string;
  on_send_transition?: string | null;
}

// A save/delete/send failure is a failure: danger, never the lime that means
// "Pixie answered". Same sentence, honest tone.
function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return <Notice tone="error">{state.error}</Notice>;
}

export function MacroCreateForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedMacroSave, initialState);
  return (
    <form action={formAction} className="max-w-3xl">
      <Section
        title="New macro"
        description="A trigger a helper types in a ticket, and the approved reply that goes out in its place."
        bordered
      >
        <div className="space-y-4">
          <input type="hidden" name="programId" value={programId} />
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <label className="block">
              <span className={labelClass}>Trigger</span>
              <input name="trigger" placeholder="?shipping" aria-label="Trigger" className={`${inputClass} font-mono`} />
            </label>
            <label className="block">
              <span className={labelClass}>Name</span>
              <input name="macroName" placeholder="Shipping address update window" aria-label="Name" className={inputClass} />
            </label>
          </div>
          <label className="block">
            <span className={labelClass}>Description · when to use it (optional)</span>
            <input
              name="macroDescription"
              placeholder="Sent when a requester asks to change their address after submitting."
              aria-label="Description"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Content · the approved reply</span>
            <textarea
              name="macroContent"
              rows={4}
              placeholder="Approved reply. {requester} {ticket_id} {program} {status} {helper} {queue_depth} {typical_wait} {position}."
              aria-label="Content"
              className={inputClass}
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[16rem] flex-1">
              <p className={labelClass}>On-send transition</p>
              <Select
                name="macroTransition"
                ariaLabel="On-send transition"
                options={[
                  { value: "", label: "No ticket transition on send" },
                  { value: "resolved", label: "Resolve ticket on send" },
                  { value: "closed", label: "Close ticket on send" },
                  { value: "snoozed", label: "Snooze 24h on send" },
                ]}
              />
            </div>
            <button type="submit" className={btnPrimary}>
              <IconPlus size={16} />
              Save macro
            </button>
          </div>
          <p className="text-[12px] text-text-muted">Live tokens: <code>{"{queue_depth}"}</code>, <code>{"{typical_wait}"}</code>, and <code>{"{position}"}</code> update when Pixie sends the reply.</p>
          <ErrorLine state={state} />
        </div>
      </Section>
    </form>
  );
}

export function MacroTemplateCard({ programId, template }: { programId: string; template: MacroTemplate }) {
  const [state, formAction] = useActionState(hostedMacroSave, initialState);
  return (
    <article className="pixie-panel-raised flex flex-col gap-3 p-4">
      <div><p className="font-mono text-[12px] text-brand">{template.trigger}</p><h3 className="mt-1 text-sm text-text">{template.name}</h3></div>
      {template.description && <p className="text-xs text-text-muted">{template.description}</p>}
      <p className="text-[13px] leading-relaxed text-text">{template.content}</p>
      <form action={formAction} className="mt-auto">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="trigger" value={template.trigger} />
        <input type="hidden" name="macroName" value={template.name} />
        <input type="hidden" name="macroDescription" value={template.description ?? ""} />
        <input type="hidden" name="macroContent" value={template.content} />
        <input type="hidden" name="macroTransition" value={template.on_send_transition ?? ""} />
        <button type="submit" className={btnPrimary}><IconPlus size={16} />Add</button>
        {state.error && <div className="mt-2"><ErrorLine state={state} /></div>}
      </form>
    </article>
  );
}

export function BulkMacroSendForm({ programId, macros, waitingCount }: { programId: string; macros: MacroRow[]; waitingCount: number }) {
  const [state, formAction] = useActionState(hostedMacroBulkSend, initialState);
  if (macros.length === 0) return null;
  const result = state.data as { sent?: number[]; skipped?: Array<{ ticketId: number; reason: string }> } | undefined;
  return (
    <form action={formAction} className="pixie-panel max-w-3xl space-y-4 p-4">
      <input type="hidden" name="programId" value={programId} />
      <p className="pixie-eyebrow flex items-center gap-2 text-text-muted"><span className="pixie-mark" aria-hidden="true" />Send a macro to everyone waiting</p>
      <p className="text-[13px] text-text-muted">{waitingCount} ticket{waitingCount === 1 ? " is" : "s are"} waiting for a helper. Choose a reply, optionally narrow it by category, then confirm below.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select name="macroId" ariaLabel="Bulk macro" options={macros.map((m) => ({ value: String(m.id), label: `${m.trigger} — ${m.name}` }))} />
        <input name="category" placeholder="Category (optional)" aria-label="Category (optional)" className={inputClass} />
      </div>
      <input type="hidden" name="selector" value="waiting_for_helper" />
      <label className="flex items-start gap-2 text-[12px] text-text-muted"><input type="checkbox" required className="mt-0.5 accent-[var(--color-brand)]" />I confirm this sends the selected macro to every matching waiting ticket.</label>
      <button type="submit" className={btnPrimary}><IconArrowRight size={16} />Send to {waitingCount} waiting</button>
      {state.error && <ErrorLine state={state} />}
      {result && <Notice tone="success">Sent to {result.sent?.length ?? 0}; skipped {result.skipped?.length ?? 0}.</Notice>}
    </form>
  );
}

export function MacroRowCard({ programId, macro }: { programId: string; macro: MacroRow }) {
  const [state, deleteAction] = useActionState(hostedMacroDelete, initialState);
  return (
    <article className="pixie-panel flex flex-col p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-[2px] bg-panel-2 text-text-muted" aria-hidden>
          <IconMacro size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px] text-text">{macro.trigger}</p>
          <h3 className="mt-1 text-sm leading-snug text-text">{macro.name}</h3>
        </div>
      </div>

      {macro.description && <p className="mt-3 text-xs text-text-muted">{macro.description}</p>}

      {/* The reply itself, on a raised surface so long copy never fights the
          page ground — the same nested-card move the onboarding preview uses. */}
      <div className="pixie-panel-raised mt-3 p-3">
        <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
          <span className="pixie-mark" aria-hidden="true" />
          Preview
        </p>
        <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-text">{macro.content}</p>
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {macro.on_send_transition && <Chip>sends → {macro.on_send_transition}</Chip>}
            {!macro.enabled && <Chip>disabled</Chip>}
          </div>
          <form action={deleteAction} className="ml-auto">
            <input type="hidden" name="programId" value={programId} />
            <input type="hidden" name="macroId" value={macro.id} />
            <button type="submit" className="pixie-button pixie-button-danger pixie-button-sm">
              <IconExit size={16} />
              Delete
            </button>
          </form>
        </div>
        <ErrorLine state={state} />
      </div>
    </article>
  );
}

export function MacroSendForm({ programId, ticketId, macros }: { programId: string; ticketId: number; macros: MacroRow[] }) {
  const [state, formAction] = useActionState(hostedMacroSend, initialState);
  if (macros.length === 0) return null;
  return (
    <form action={formAction} className="pixie-panel max-w-2xl p-4">
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
        <span className="pixie-mark" aria-hidden="true" />
        Send a macro
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select
          name="macroId"
          ariaLabel="Macro"
          className="min-w-[14rem] flex-1"
          options={macros.map((m) => ({ value: String(m.id), label: `${m.trigger} — ${m.name}` }))}
        />
        <button type="submit" className="pixie-button pixie-button-quiet pixie-button-sm">
          <IconArrowRight size={16} />
          Send
        </button>
      </div>
      <div className="mt-3">
        <ErrorLine state={state} />
      </div>
    </form>
  );
}
