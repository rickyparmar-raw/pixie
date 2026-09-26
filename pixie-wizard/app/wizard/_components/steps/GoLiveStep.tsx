"use client";

import { useState } from "react";
import {
  DEMO_PEOPLE,
  draftProblems,
  dryRun,
  usableSources,
  type DryRunResult,
  type StepIndex,
} from "@/lib/onboardingDraft";
import { OnbIconAlert, OnbIconCheckCircle, OnbIconSparkle } from "../OnboardingIcons";
import { PixelIconClock, PixelIconInfo } from "../PixelIcons";
import type { GoLiveStepProps } from "./stepTypes";
import "../golive.css";

type Check = {
  key: string;
  label: string;
  ok: boolean;
  // Shown under the label while the row is open, and only then.
  problem: string | null;
  // A row the user cannot act on: nothing to fix, so it wears the muted clock
  // instead of an empty checklist ring. Core being down is not a step.
  pending: boolean;
  // The step a "Fix" button jumps to, and the draftProblems step this row
  // stands in for. The Slack row has neither.
  fixStep: StepIndex | null;
  covers: StepIndex | null;
};

function helperName(slackId: string | null, demoMode: boolean): string {
  if (!slackId) return "the helpers channel";
  const person = demoMode ? DEMO_PEOPLE[slackId] : undefined;
  return person ? person.name : slackId;
}

function DryRunCard({ result, demoMode }: { result: DryRunResult; demoMode: boolean }) {
  if (result.kind === "answer") {
    return (
      <div className="ob-golive-result-card">
        <p className="ob-golive-result-head">
          <span>Would answer from</span>
          <span className="ob-golive-who">{result.sourceLabel}</span>
        </p>
        <p className="ob-golive-result-body">{result.snippet}</p>
      </div>
    );
  }
  return (
    <div className="ob-golive-result-card">
      <p className="ob-golive-result-head">
        <span>Would hand off</span>
        {result.tag ? (
          <>
            <span className="ob-golive-arrow" aria-hidden="true">→</span>
            <span className="ob-golive-tag">{result.tag}</span>
          </>
        ) : null}
        <span className="ob-golive-arrow" aria-hidden="true">→</span>
        <span className="ob-golive-who">{helperName(result.helperId, demoMode)}</span>
      </p>
      <p className="ob-golive-result-body">
        {result.linkSourcesPending
          ? `${result.linkSourcesPending} link source${result.linkSourcesPending === 1 ? " is" : "s are"} read when Pixie launches, so the live answer can be fuller.`
          : "Nothing in your docs covers this, and no helper is tagged for it yet."}
      </p>
    </div>
  );
}

export function GoLiveStep({
  draft,
  update,
  channels,
  coreLive,
  creatorSlackId,
  demoMode,
  serverError,
}: GoLiveStepProps) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const problems = draftProblems(draft);
  const problemFor = (step: StepIndex, fallback: string): string =>
    problems.find((problem) => problem.step === step)?.message ?? fallback;
  const helpersReady = draft.helpers.length > 0 || Boolean(creatorSlackId);

  const checks: Check[] = [
    {
      key: "core",
      label: coreLive ? "Slack connected" : "Slack connection pending",
      ok: coreLive,
      problem: "Core syncs later — you can still launch.",
      pending: true,
      fixStep: null,
      covers: null,
    },
    {
      key: "channels",
      label: "Channels selected",
      ok: !problems.some((problem) => problem.step === 1),
      problem: problemFor(1, "Pick a help channel and a private helpers channel."),
      pending: false,
      fixStep: 1,
      covers: 1,
    },
    {
      key: "knowledge",
      label: "Knowledge ready",
      ok: !problems.some((problem) => problem.step === 2),
      problem: problemFor(2, "Add at least one doc source."),
      pending: false,
      fixStep: 2,
      covers: 2,
    },
    {
      key: "helpers",
      label: "Helpers configured",
      ok: helpersReady,
      problem: "Add a helper, or launch without one — questions queue until someone joins.",
      pending: false,
      fixStep: 3,
      covers: null,
    },
  ];

  const ask = () => {
    const text = question.trim();
    if (!text) return;
    setAsked(text);
  };

  // Problems no checklist row stands in for — the program name today — so a
  // disabled Launch always has a reason beside it.
  const extraProblems = problems.filter(
    (problem) => !checks.some((check) => check.covers === problem.step),
  );
  const programName = draft.programName.trim();
  const helpChannel = channels.find((channel) => channel.id === draft.helpChannelId.trim());
  const helperCount = draft.helpers.length;
  const sourceCount = usableSources(draft.sources).length;

  return (
    <div className="onboarding-step-section ob-golive" data-step-panel={4}>
      <div className="onboarding-docs-grid">
        <div className="ob-golive-main">
          <div className="onboarding-step-copy" aria-live="polite">
            <p className="onboarding-step-eyebrow">STEP 5 OF 5</p>
            <h1 className="onboarding-title">You&apos;re ready.</h1>
            <p className="onboarding-lede">Check the basics, try a question, then launch.</p>
          </div>
          {/* The surface, not the list: the demo line is this panel's footer row,
              and a caption floating between two bordered boxes reads as neither
              belonging to one nor the other. Both live inside .ob-golive-board so
              the checklist surface can carry the whole block. */}
          <div className="ob-golive-board">
            <ul className="ob-golive-checks" aria-label="Launch checklist">
              {checks.map((check) => {
                const { fixStep } = check;
                return (
                  <li className="ob-golive-check" data-state={check.ok ? "done" : "todo"} key={check.key}>
                    <span
                      className="ob-golive-check-mark"
                      data-state={check.ok ? "done" : check.pending ? "pending" : "todo"}
                    >
                      {check.ok ? (
                        <OnbIconCheckCircle size={18} />
                      ) : check.pending ? (
                        <PixelIconClock size={16} />
                      ) : null}
                    </span>
                    <span className="ob-golive-check-copy">
                      <span className="ob-golive-check-label">{check.label}</span>
                      {check.ok || !check.problem ? null : (
                        <span className="ob-golive-check-problem">{check.problem}</span>
                      )}
                    </span>
                    {check.ok || fixStep === null ? null : (
                      <button
                        className="ob-golive-fix"
                        type="button"
                        onClick={() => update((current) => ({ ...current, step: fixStep }))}
                      >
                        Fix
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {demoMode ? (
              <p className="ob-golive-demo">
                <span className="ob-golive-demo-mark" aria-hidden="true">
                  <PixelIconInfo size={16} />
                </span>
                <span>Demo mode — launching is turned off.</span>
              </p>
            ) : null}
          </div>
          <div className="ob-golive-test">
            <label className="ob-golive-test-label" htmlFor="golive-test-question">
              Ask Pixie a test question
            </label>
            <div className="ob-golive-test-row">
              <input
                id="golive-test-question"
                className="onboarding-input ob-golive-input"
                type="text"
                value={question}
                placeholder="Where&apos;s my hardware grant?"
                onChange={(event) => {
                  setQuestion(event.target.value);
                  setAsked(null);
                }}
                onKeyDown={(event) => {
                  // Never let Enter submit the launch form from the dry-run box.
                  if (event.key === "Enter") {
                    event.preventDefault();
                    ask();
                  }
                }}
              />
              <button
                className="onboarding-button ob-golive-ask"
                type="button"
                onClick={ask}
                disabled={!question.trim()}
              >
                Ask
              </button>
            </div>
            <p className="ob-golive-caption">
              Dry run on this device — the real answer runs after launch.
            </p>
            <div className="ob-golive-result" aria-live="polite">
              {asked ? (
                <DryRunCard result={dryRun(asked, draft)} demoMode={demoMode} />
              ) : (
                <p className="ob-golive-result-empty">
                  Try a question your community asks often. Pixie searches what you uploaded, then routes
                  anything it can&apos;t answer.
                </p>
              )}
            </div>
          </div>
          <div className="ob-golive-notes">
            {extraProblems.map((problem) => (
              <p className="ob-golive-note" key={problem.message}>
                <span>{problem.message}</span>
                <button
                  className="ob-golive-fix"
                  type="button"
                  onClick={() => update((current) => ({ ...current, step: problem.step }))}
                >
                  Fix
                </button>
              </p>
            ))}
            {serverError ? (
              <p className="onboarding-error ob-golive-alert" role="alert">
                <span className="ob-golive-alert-icon" aria-hidden="true">
                  <OnbIconAlert size={16} />
                </span>
                <span>{serverError}</span>
              </p>
            ) : null}
          </div>
        </div>
        <aside className="onboarding-preview" aria-labelledby="golive-panel-title">
          <div className="onboarding-preview-heading">
            <span className="onboarding-preview-spark" aria-hidden="true">
              <OnbIconSparkle size={34} />
            </span>
            <div>
              <h2 className="onboarding-preview-title" id="golive-panel-title">What happens at launch</h2>
              <p className="onboarding-preview-copy">
                Three steps, in order. Nothing is read or sent to Slack before you press Launch.
              </p>
            </div>
          </div>
          <ol className="ob-golive-plan">
            <li className="ob-golive-plan-card">
              <span className="ob-golive-plan-copy">
                <span className="ob-golive-plan-title">
                  <span className="ob-golive-plan-num" aria-hidden="true">1</span>Program saved
                </span>
                <span className="ob-golive-plan-note">
                  {programName
                    ? `${programName} keeps ${sourceCount} source${sourceCount === 1 ? "" : "s"} and ${helperCount} helper${helperCount === 1 ? "" : "s"}.`
                    : "Name your program in step 1 before you launch."}
                </span>
              </span>
            </li>
            <li className="ob-golive-plan-card">
              <span className="ob-golive-plan-copy">
                <span className="ob-golive-plan-title">
                  <span className="ob-golive-plan-num" aria-hidden="true">2</span>
                  {coreLive ? "Synced to Pixie Core" : "Synced when Core is back"}
                </span>
                <span className="ob-golive-plan-note">
                  {coreLive
                    ? "Your program reaches Core in the same step, and sources are read there."
                    : "Core isn't reachable, so the save still lands and the sync waits."}
                </span>
              </span>
            </li>
            <li className="ob-golive-plan-card">
              <span className="ob-golive-plan-copy">
                <span className="ob-golive-plan-title">
                  <span className="ob-golive-plan-num" aria-hidden="true">3</span>Pixie starts answering
                </span>
                <span className="ob-golive-plan-note">
                  {helpChannel
                    ? `Questions in #${helpChannel.name} reach Pixie, and anything it can't answer goes to your helpers.`
                    : "Questions in your help channel reach Pixie, and anything it can't answer goes to your helpers."}
                </span>
              </span>
            </li>
          </ol>
        </aside>
      </div>
    </div>
  );
}
