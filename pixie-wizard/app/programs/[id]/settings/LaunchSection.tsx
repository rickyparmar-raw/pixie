"use client";

import { useActionState } from "react";
import { launchProgramAction } from "@/app/wizard/hostedActions";
import type { ActionState, RuntimeStatus } from "@/lib/types";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";
import { Section } from "@/app/_components/DashboardShell";

const initialState: ActionState = { error: null };

// Sandbox → live as one deliberate confirm action. Only rendered for
// sandbox programs; live/paused programs show their state instead.
export function LaunchSection({ programId, runtimeStatus }: { programId: string; runtimeStatus: RuntimeStatus | undefined }) {
  const [state, formAction] = useActionState(launchProgramAction, initialState);
  if (runtimeStatus !== "sandbox") {
    return (
      <Section title="Launch" description="This program is out of the sandbox.">
        <p className="text-sm text-text-muted">
          Status: <span className="font-mono text-text">{runtimeStatus ?? "live"}</span>
        </p>
      </Section>
    );
  }
  return (
    <Section title="Launch" description="This program is still a sandbox — only test questions reach it.">
      <form action={formAction} className="max-w-lg space-y-3">
        <input type="hidden" name="programId" value={programId} />
        <label className="flex items-center gap-2.5 text-sm text-text">
          <input type="checkbox" name="confirm" value="launch" required className="accent-brand" />
          Launch this program — Pixie starts answering in its channels.
        </label>
        {state.error && <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{state.error}</p>}
        <SubmitButton pendingLabel="Launching…">Launch program</SubmitButton>
      </form>
    </Section>
  );
}
