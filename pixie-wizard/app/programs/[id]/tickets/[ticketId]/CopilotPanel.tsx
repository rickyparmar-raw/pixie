"use client";

import { useState } from "react";
import { hostedCopilot } from "@/app/wizard/hostedActions";
import { Section, Notice } from "@/app/_components/DashboardShell";
import { IconSparkle, IconDoc, IconSearch } from "@/app/_components/icons";
import { inputClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

type CopilotAction = "draft" | "improve" | "summarize" | "factcheck" | "similar" | "ask";

const ACTION_LABEL: Record<CopilotAction, string> = {
  draft: "Draft reply",
  improve: "Improve writing",
  summarize: "Thread summary",
  factcheck: "Fact check",
  similar: "Similar tickets",
  ask: "Answer",
};

function CopilotResult({ body }: { body: unknown }) {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const headline =
      typeof b.draft === "string" ? b.draft
      : typeof b.summary === "string" ? b.summary
      : typeof b.improved === "string" ? b.improved
      : null;
    return (
      <div className="mt-2 space-y-2 text-[13px]">
        {headline && <p className="whitespace-pre-wrap text-text">{headline}</p>}
        {typeof b.grounded === "boolean" && (
          <p className={`text-[12px] ${b.grounded ? "text-mint" : "text-tang"}`}>
            {b.grounded ? "Grounded in cited sources." : "Not grounded. Verify against docs before sending."}
          </p>
        )}
        {Array.isArray(b.notes) && b.notes.length > 0 && (
          <ul className="list-disc space-y-1 pl-4 text-[12px] text-text-muted">
            {(b.notes as string[]).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {Array.isArray(b.candidates) && (
          <ul className="space-y-1.5 text-[12px]">
            {(b.candidates as Array<{ ticketId: number; question: string; similarity: number; resolution: string | null }>).map((c) => (
              <li key={c.ticketId} className="border-b border-line pb-1.5 text-text-muted last:border-b-0 last:pb-0">
                <span className="font-mono text-text-muted">#{c.ticketId}</span>{" "}
                <span className="font-mono text-brand">{Math.round(c.similarity * 100)}%</span> — {c.question}
                {c.resolution ? <span className="block text-mint">→ {c.resolution}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {Array.isArray(b.verdicts) && (
          <ul className="space-y-1.5 text-[12px]">
            {(b.verdicts as Array<{ sentence: string; verdict: string }>).map((v, i) => (
              <li key={i} className="border-b border-line pb-1.5 last:border-b-0 last:pb-0">
                {/* The verdict is whatever vocabulary Core returns, so it is
                    labelled, not coloured — guessing a tone from the word
                    would paint a refuted claim green. */}
                <span className="pixie-chip">{v.verdict}</span>{" "}
                <span className="text-text-muted">{v.sentence}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-text">{JSON.stringify(body, null, 2)}</pre>;
}

export function CopilotPanel({
  programId,
  ticketId,
  question,
  threadTs,
}: {
  programId: string;
  ticketId: number;
  question: string;
  threadTs: string;
}) {
  const [busy, setBusy] = useState<CopilotAction | null>(null);
  const [output, setOutput] = useState<{ action: CopilotAction; body: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");

  async function run(action: CopilotAction, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    try {
      const res = await hostedCopilot({ programId, ticketId, action, threadTs, ...extra });
      if (!res.ok) setError(res.error ?? "Copilot failed.");
      else setOutput({ action, body: res.data });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copilot failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Copilot" bordered>
      <div className="space-y-3">
        <div className="flex items-center gap-2.5 border-b border-line pb-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-[2px] bg-lime/15 text-lime">
            <IconSparkle size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-text">Pixie</p>
            <p className="text-[11px] text-text-muted">Grounded in this program&apos;s docs. You review every draft.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button disabled={busy !== null} onClick={() => run("draft", { question })} className={btnPrimary}>
            <IconSparkle size={16} />
            {busy === "draft" ? "Drafting…" : "Draft reply"}
          </button>
          <button disabled={busy !== null} onClick={() => run("summarize")} className={btnQuiet}>
            <IconDoc size={16} />
            {busy === "summarize" ? "Summarizing…" : "Summarize thread"}
          </button>
          <button disabled={busy !== null} onClick={() => run("similar", { question })} className={btnQuiet}>
            <IconSearch size={16} />
            {busy === "similar" ? "Searching…" : "Find similar"}
          </button>
        </div>

        <div>
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Fact-check a reply, or ask Pixie about this ticket"
            aria-label="Fact-check a reply, or ask Pixie about this ticket"
            className={inputClass}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={busy !== null || !freeText.trim()} onClick={() => run("factcheck", { text: freeText })} className={btnQuiet}>
              Fact check
            </button>
            <button disabled={busy !== null || !freeText.trim()} onClick={() => run("improve", { text: freeText })} className={btnQuiet}>
              Improve writing
            </button>
            <button disabled={busy !== null || !freeText.trim()} onClick={() => run("ask", { question: freeText })} className={btnQuiet}>
              Ask Pixie
            </button>
          </div>
        </div>

        {error && <Notice tone="error">{error}</Notice>}

        {output && (
          <div className="pixie-panel-raised p-3">
            <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
              <span className="pixie-mark" aria-hidden="true" />
              {ACTION_LABEL[output.action]}
            </p>
            <CopilotResult body={output.body} />
          </div>
        )}
      </div>
    </Section>
  );
}
