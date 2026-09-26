"use client";

import Link from "next/link";
import { useActionState, useCallback, useEffect, useState } from "react";
import { activateHostedProgram } from "@/app/wizard/hostedActions";
import type { CoreChannel } from "@/lib/pixieCore";
import type { ActionState } from "@/lib/types";
import {
  DEMO_DRAFT,
  EMPTY_DRAFT,
  ONBOARDING_STEPS,
  draftProblems,
  draftStorageKey,
  helperTagRows,
  parseStoredDraft,
  sourceFormRows,
  stepDone,
  type OnboardingDraft,
  type StepIndex,
} from "@/lib/onboardingDraft";
import { OnbIconArrowLeft, OnbIconArrowRight } from "@/app/wizard/_components/OnboardingIcons";
import {
  PixelIconChannels,
  PixelIconDocs,
  PixelIconHelpers,
  PixelIconLaunch,
  PixelIconProgram,
} from "./PixelIcons";
import { SubmitButton } from "./SubmitButton";
import { ChannelsStep } from "./steps/ChannelsStep";
import { DocsStep } from "./steps/DocsStep";
import { GoLiveStep } from "./steps/GoLiveStep";
import { HelpersStep } from "./steps/HelpersStep";
import { ProgramStep } from "./steps/ProgramStep";
import type { StepProps } from "./steps/stepTypes";
import "./onboarding.css";
import "./onboarding-shared.css";
import "./art.css";

const initialState: ActionState = { error: null };
const LAST_STEP = 4;

const stepIcons = [
  PixelIconProgram,
  PixelIconChannels,
  PixelIconDocs,
  PixelIconHelpers,
  PixelIconLaunch,
] as const;

export function HostedSetupView({
  channels,
  coreLive,
  demoMode,
  userKey,
  creatorSlackId,
}: {
  channels: CoreChannel[];
  coreLive: boolean;
  demoMode: boolean;
  userKey: string;
  creatorSlackId: string | null;
}) {
  const [state, formAction] = useActionState(activateHostedProgram, initialState);
  const [draft, setDraft] = useState<OnboardingDraft>(demoMode ? DEMO_DRAFT : EMPTY_DRAFT);
  const [maxReached, setMaxReached] = useState<StepIndex>(demoMode ? LAST_STEP : EMPTY_DRAFT.step);
  const [hydrated, setHydrated] = useState(false);
  const [validated, setValidated] = useState(false);
  const [storageBroken, setStorageBroken] = useState(false);
  const storageKey = draftStorageKey(userKey);
  const step = draft.step;

  const update = useCallback<StepProps["update"]>((patch) => {
    setValidated(false);
    setDraft((current) => (typeof patch === "function" ? patch(current) : { ...current, ...patch }));
  }, []);

  useEffect(() => {
    if (hydrated) return;
    setHydrated(true);
    if (demoMode) return;
    try {
      const stored = parseStoredDraft(window.localStorage.getItem(storageKey));
      if (stored) {
        setDraft(stored);
        setMaxReached(stored.step);
      }
    } catch {
      setStorageBroken(true);
    }
  }, [demoMode, hydrated, storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(draft));
      setStorageBroken(false);
    } catch {
      setStorageBroken(true);
    }
  }, [draft, hydrated, storageKey]);

  useEffect(() => {
    if (!hydrated || !state.error) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      setStorageBroken(true);
    }
  }, [draft, hydrated, state.error, storageKey]);

  const clearStored = () => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      setStorageBroken(true);
    }
  };

  const move = (target: number) => {
    const next = Math.max(0, Math.min(LAST_STEP, target)) as StepIndex;
    if (!demoMode && next > maxReached + 1) return;
    setMaxReached((current) => (current > next ? current : next));
    update({ step: next });
  };

  const allProblems = draftProblems(draft);

  const next = () => {
    if (allProblems.some((problem) => problem.step === step)) {
      setValidated(true);
      return;
    }
    move(step + 1);
  };

  const problems = allProblems.filter((problem) => problem.step === step);
  const sourceRows = sourceFormRows(draft.sources);
  const tagRows = helperTagRows(draft.helpers);
  const helperIds = draft.helpers
    .filter((helper) => helper.slackId !== creatorSlackId)
    .map((helper) => helper.slackId)
    .join(", ");
  const panelProps: StepProps & { serverError: string | null } = {
    draft,
    update,
    demoMode,
    coreLive,
    channels,
    creatorSlackId,
    serverError: state.error,
  };

  return (
    <main className="onboarding-page">
      <div className="ob-art" aria-hidden="true">
        <img className="ob-art-img" src="/pixie-night-background.png" alt="" />
        <span className="ob-art-stars" />
      </div>
      <div className="onboarding-shell">
        <header className="onboarding-header">
          <Link className="onboarding-logo" href="/">pixie<span>.</span></Link>
          <div className="onboarding-header-actions">
            <span className="onboarding-setup-label">Setup</span>
            {!coreLive ? (
              <span
                className="onboarding-sync-note"
                title="Pixie Core is unreachable right now. Your setup is saved and syncs when you launch."
              >
                <span className="onboarding-sync-dot" aria-hidden="true" />
                Core syncs later
              </span>
            ) : null}
            <Link className="onboarding-exit" href="/programs">Exit setup</Link>
          </div>
        </header>
        <nav className="onboarding-stepper" aria-label="Onboarding progress">
          {ONBOARDING_STEPS.map((label, index) => {
            const Icon = stepIcons[index];
            const state = index === step ? "active" : stepDone(draft, index as StepIndex) ? "done" : "todo";
            return (
              <div className="onboarding-step-item" key={label}>
                <button
                  type="button"
                  className="onboarding-step-button"
                  data-state={state}
                  data-step-index={index}
                  aria-current={index === step ? "step" : undefined}
                  onClick={() => move(index)}
                >
                  <span className="onboarding-step-number">{index + 1}</span>
                  <span className="onboarding-step-icon">
                    <Icon size={32} />
                  </span>
                  <span className="onboarding-step-label">{label}</span>
                </button>
                {/* Connectors sit to the LEFT of their box, so the first box has none. */}
                {index > 0 ? <span className="onboarding-step-connector" aria-hidden="true" /> : null}
              </div>
            );
          })}
        </nav>
        {/* Phone widths cannot fit five labelled tiles, so the nav above is
            replaced by this one row: the same move() rules, no duplicated
            data-step-index, and the tiles stay in the DOM for desktop. */}
        <div className="onboarding-stepper-compact">
          <div className="onboarding-compact-meta">
            <span className="onboarding-compact-eyebrow">Step {step + 1} of 5</span>
            <span className="onboarding-compact-name">{ONBOARDING_STEPS[step]}</span>
          </div>
          {ONBOARDING_STEPS.map((label, index) => {
            const compactState =
              index === step ? "active" : stepDone(draft, index as StepIndex) ? "done" : "todo";
            return (
              <button
                type="button"
                className="onboarding-compact-segment"
                data-state={compactState}
                data-compact-step={index}
                aria-current={index === step ? "step" : undefined}
                aria-label={`Go to step ${index + 1}: ${label}`}
                key={label}
                onClick={() => move(index)}
              />
            );
          })}
        </div>
        <form className="onboarding-form" action={formAction} onSubmit={clearStored}>
          {/* Every step renders its own two-column body (content + right-hand
              preview) inside `.onboarding-docs-grid`, so all five share the
              Docs screen's geometry. */}
          <div className="onboarding-main-grid onboarding-main-grid-docs">
            {step === 0 ? <ProgramStep {...panelProps} /> : null}
            {step === 1 ? <ChannelsStep {...panelProps} /> : null}
            {step === 2 ? <DocsStep {...panelProps} /> : null}
            {step === 3 ? <HelpersStep {...panelProps} /> : null}
            {step === 4 ? <GoLiveStep {...panelProps} /> : null}
          </div>
          <input type="hidden" name="programName" value={draft.programName} />
          <input type="hidden" name="programDescription" value={draft.programDescription} />
          <input type="hidden" name="programSlug" value={draft.programSlug} />
          <input type="hidden" name="iconUrl" value={draft.iconUrl} />
          <input type="hidden" name="helpChannelId" value={draft.helpChannelId} />
          <input type="hidden" name="organizerChannelId" value={draft.organizerChannelId} />
          {sourceRows.map((row, index) => (
            <span key={index}>
              <input type="hidden" name="sourceType" value={row.type} />
              <input type="hidden" name="sourceLabel" value={row.label} />
              <input type="hidden" name="sourceUrl" value={row.url} />
              <input type="hidden" name="sourceContent" value={row.content} />
            </span>
          ))}
          <input type="hidden" name="initialHelperIds" value={helperIds} />
          {tagRows.map((row) => <input type="hidden" name="helperTags" value={row} key={row} />)}
          <input type="hidden" name="supportName" value={draft.programName.trim() ? `${draft.programName.trim()} Help` : ""} />
          <input type="hidden" name="aiAnswers" value="on" />
          <input type="hidden" name="ticketsEnabled" value="on" />
          <input type="hidden" name="autoEscalate" value="on" />
          <input type="hidden" name="posture" value="active" />
          <input type="hidden" name="scope" value="program" />
          <input type="hidden" name="allowPublicOrganizer" value="off" />
          <input type="hidden" name="autoAssign" value="off" />
          {validated && problems.length ? (
            <div role="alert">
              {problems.map((problem) => (
                <p className="onboarding-error" key={problem.message}>{problem.message}</p>
              ))}
            </div>
          ) : null}
          {storageBroken ? (
            <p className="onboarding-note">This browser is blocking local storage — your setup is lost if you close the tab.</p>
          ) : null}
          <footer className="onboarding-footer">
            <button
              className="onboarding-button onboarding-button-quiet"
              type="button"
              onClick={() => move(step - 1)}
              disabled={step === 0}
            >
              <span className="onboarding-button-arrow" aria-hidden="true">
                <OnbIconArrowLeft size={18} />
              </span>
              Back
            </button>
            <div className="onboarding-footer-progress">
              <span>Step {step + 1} of 5</span>
              <span className="onboarding-footer-progress-bar" aria-hidden="true">
                {ONBOARDING_STEPS.map((label, index) => <span data-filled={index <= step} key={label} />)}
              </span>
            </div>
            {step === LAST_STEP ? (
              <SubmitButton
                className="onboarding-button onboarding-button-primary"
                pendingLabel="Launching…"
                disabled={demoMode || allProblems.length > 0}
              >
                Launch Pixie{" "}
                <span className="onboarding-button-arrow" aria-hidden="true">
                  <OnbIconArrowRight size={18} />
                </span>
              </SubmitButton>
            ) : (
              <button className="onboarding-button onboarding-button-primary" type="button" onClick={next}>
                Continue{" "}
                <span className="onboarding-button-arrow" aria-hidden="true">
                  <OnbIconArrowRight size={18} />
                </span>
              </button>
            )}
          </footer>
        </form>
      </div>
    </main>
  );
}
