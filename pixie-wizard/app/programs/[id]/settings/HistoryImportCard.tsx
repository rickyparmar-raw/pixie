"use client";

import { useActionState } from "react";
import { runHistoryImportAction } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import type { CoreHistoryImportProgress } from "@/lib/pixieCore";
import { Chip, Notice, Section } from "@/app/_components/DashboardShell";
import { SubmitButton } from "@/app/wizard/_components/SubmitButton";

const initialState: ActionState = { error: null };

export function HistoryImportCard({
  programId,
  progress,
  loadError,
  canRun,
}: {
  programId: string;
  progress: CoreHistoryImportProgress | null;
  loadError: string | null;
  canRun: boolean;
}) {
  const [state, formAction] = useActionState(runHistoryImportAction, initialState);
  const current = progress?.status || "pending";
  const complete = current === "done";
  return (
    <Section
      bordered
      title="History import"
      description="Bring every help thread into the ticket history without posting anything to Slack."
      actions={<Chip tone={complete ? "lime" : undefined}>{current}</Chip>}
    >
      {loadError && <Notice tone="warn">{loadError}</Notice>}
      {progress ? (
        <div className="space-y-3">
          <div className="grid gap-2 text-[13px] text-text-muted sm:grid-cols-4">
            <span><strong className="font-mono text-text">{progress.messagesScanned}</strong> messages</span>
            <span><strong className="font-mono text-text">{progress.ticketsCreated}</strong> tickets</span>
            <span><strong className="font-mono text-text">{progress.resolved}</strong> resolved</span>
            <span><strong className="font-mono text-text">{progress.closed}</strong> closed</span>
          </div>
          <p className="text-xs text-text-muted">{progress.channels.length} help channel{progress.channels.length === 1 ? "" : "s"} · {progress.queuedForJudge} queued for review.</p>
          {progress.lastError && <Notice tone="error">{progress.lastError}</Notice>}
          {canRun && (
            <form action={formAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="programId" value={programId} />
              <SubmitButton pendingLabel="Starting…">Run import</SubmitButton>
              {state.error && <span className="text-sm text-danger">{state.error}</span>}
            </form>
          )}
        </div>
      ) : (
        <Notice tone="warn">{loadError || "History import progress is unavailable."}</Notice>
      )}
    </Section>
  );
}
