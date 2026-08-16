"use client";

import { useActionState } from "react";
import { saveLlmKey, type ActionState } from "@/app/wizard/actions";
import { StepShell } from "./StepShell";
import { SubmitButton } from "./SubmitButton";
import { inputClass, labelClass } from "./formStyles";

const initialState: ActionState = { error: null };

export function LlmKeyStep() {
  const [state, formAction] = useActionState(saveLlmKey, initialState);

  return (
    <StepShell
      step={2}
      title="Bring your own LLM key"
      subtitle="Every trial uses its own key so one busy bot can't rate-limit everyone else's."
    >
      <form action={formAction} className="space-y-5">
        <div>
          <label htmlFor="apiKey" className={labelClass}>
            API key
          </label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            placeholder="sk-... or a Zen/OpenCode key"
            className={inputClass}
          />
        </div>
        <details className="text-xs text-text-muted">
          <summary className="cursor-pointer select-none text-text">
            Using something other than opencode Zen?
          </summary>
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="baseUrl" className={labelClass}>
                Base URL
              </label>
              <input
                id="baseUrl"
                name="baseUrl"
                placeholder="https://opencode.ai/zen/v1"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="model" className={labelClass}>
                Model
              </label>
              <input
                id="model"
                name="model"
                placeholder="deepseek-v4-flash-free"
                className={inputClass}
              />
            </div>
          </div>
        </details>
        {state.error && (
          <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">
            {state.error}
          </p>
        )}
        <SubmitButton pendingLabel="Checking the key…">Validate &amp; continue</SubmitButton>
      </form>
    </StepShell>
  );
}
