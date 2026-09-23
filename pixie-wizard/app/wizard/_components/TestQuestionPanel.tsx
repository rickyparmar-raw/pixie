"use client";

import { useState } from "react";
import { askTestQuestion } from "@/app/wizard/hostedActions";
import type { TestQuestionResult } from "@/lib/pixieCore";
import { inputClass, labelClass, btnPrimary } from "./formStyles";
import { Select } from "@/app/_components/Select";

const ACTION_LABEL: Record<TestQuestionResult["expectedAction"], string> = {
  reply: "Pixie would reply",
  silence: "Pixie would stay silent",
  "ticket+helper": "Pixie would open a ticket and ping a helper",
  uncertain: "Pixie would say it can't verify that, without guessing",
};

// Wizard step 6: "Ask a test question" against the sandbox program. Calls
// Core's test-question probe, which retrieves and drafts a grounded answer
// with no Slack or ticket side effects.
export function TestQuestionPanel({ programId }: { programId: string }) {
  const [question, setQuestion] = useState("");
  const [role, setRole] = useState<"help" | "main">("help");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestQuestionResult | null>(null);

  const ask = async () => {
    const q = question.trim();
    if (!q || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await askTestQuestion({ programId, question: q, role });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res.data as TestQuestionResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test question failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
        <div>
          <label htmlFor="testRole" className={labelClass}>Ask as</label>
          <Select
            id="testRole"
            name="testRole"
            defaultValue={role}
            ariaLabel="Channel role"
            options={[
              { value: "help", label: "Help channel" },
              { value: "main", label: "Main channel" },
            ]}
            onValueChange={(v) => setRole(v === "main" ? "main" : "help")}
          />
        </div>
        <div>
          <label htmlFor="testQuestion" className={labelClass}>Test question</label>
          <input
            id="testQuestion"
            className={inputClass}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How do I submit my project?"
            maxLength={1000}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
          />
        </div>
      </div>
      <button type="button" onClick={ask} disabled={pending || !question.trim()} className={btnPrimary}>
        {pending ? "Asking…" : "Ask a test question"}
      </button>
      {error && <p className="rounded-md border border-brand/40 bg-brand/10 p-3 text-sm text-brand">{error}</p>}
      {result && (
        <dl className="divide-y divide-line rounded-md border border-line text-sm">
          <div className="flex justify-between gap-4 px-3 py-2.5">
            <dt className="text-text-muted">Would do</dt>
            <dd className="text-right text-text">{ACTION_LABEL[result.expectedAction]}</dd>
          </div>
          <div className="flex justify-between gap-4 px-3 py-2.5">
            <dt className="text-text-muted">Grounded in your docs</dt>
            <dd className="text-right text-text">{result.grounded ? "Yes" : "No"}</dd>
          </div>
          <div className="flex justify-between gap-4 px-3 py-2.5">
            <dt className="text-text-muted">Sources used</dt>
            <dd className="text-right text-text">{result.sources.length > 0 ? result.sources.join(", ") : "None"}</dd>
          </div>
          {result.intent && (
            <div className="flex justify-between gap-4 px-3 py-2.5">
              <dt className="text-text-muted">Classifier intent</dt>
              <dd className="text-right font-mono text-xs text-text">{result.intent}</dd>
            </div>
          )}
          {result.answerPreview && (
            <div className="px-3 py-2.5">
              <dt className="mb-1 text-text-muted">Answer preview</dt>
              <dd className="whitespace-pre-wrap text-xs leading-relaxed text-text">{result.answerPreview}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
