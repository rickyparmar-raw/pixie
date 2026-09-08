"use client";

import { useState } from "react";
import { hostedCopilot } from "@/app/wizard/hostedActions";
import { inputClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

type CopilotAction = "draft" | "improve" | "summarize" | "factcheck" | "similar" | "ask";

function CopilotResult({ body }: { body: unknown }) {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const headline =
      typeof b.draft === "string" ? b.draft
      : typeof b.summary === "string" ? b.summary
      : typeof b.improved === "string" ? b.improved
      : null;
    return (
      <div className="mt-2 space-y-2">
        {headline && <p className="whitespace-pre-wrap">{headline}</p>}
        {typeof b.grounded === "boolean" && (
          <p className="text-xs text-text-muted">{b.grounded ? "Grounded in cited sources." : "Not grounded. Verify against docs before sending."}</p>
        )}
        {Array.isArray(b.notes) && b.notes.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-text-muted">
            {(b.notes as string[]).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {Array.isArray(b.candidates) && (
          <ul className="space-y-1 text-xs">
            {(b.candidates as Array<{ ticketId: number; question: string; similarity: number; resolution: string | null }>).map((c) => (
              <li key={c.ticketId}>#{c.ticketId} ({Math.round(c.similarity * 100)}%) — {c.question}{c.resolution ? ` → ${c.resolution}` : ""}</li>
            ))}
          </ul>
        )}
        {Array.isArray(b.verdicts) && (
          <ul className="space-y-1 text-xs">
            {(b.verdicts as Array<{ sentence: string; verdict: string }>).map((v, i) => (
              <li key={i}><span className="text-text">{v.verdict}</span> · {v.sentence}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <pre className="mt-2 whitespace-pre-wrap font-sans">{JSON.stringify(body, null, 2)}</pre>;
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
    <div className="max-w-2xl space-y-3">
      <h2 className="text-sm font-medium text-text">Copilot</h2>
      <p className="text-xs text-text-muted">Grounded in this program&apos;s docs. You review every draft before it sends.</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={busy !== null} onClick={() => run("draft", { question })} className={btnPrimary}>
          {busy === "draft" ? "Drafting…" : "Draft reply"}
        </button>
        <button disabled={busy !== null} onClick={() => run("summarize")} className={btnQuiet}>
          {busy === "summarize" ? "Summarizing…" : "Summarize thread"}
        </button>
        <button disabled={busy !== null} onClick={() => run("similar", { question })} className={btnQuiet}>
          {busy === "similar" ? "Searching…" : "Find similar"}
        </button>
      </div>
      <input value={freeText} onChange={(e) => setFreeText(e.target.value)} placeholder="Fact-check a reply, or ask Pixie about this ticket" className={inputClass} />
      <div className="flex flex-wrap gap-2">
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
      {error && <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{error}</p>}
      {output && (
        <div className="border-l-2 border-line pl-3 text-sm text-text">
          <p className="text-xs text-text-muted">{output.action}</p>
          <CopilotResult body={output.body} />
        </div>
      )}
    </div>
  );
}
