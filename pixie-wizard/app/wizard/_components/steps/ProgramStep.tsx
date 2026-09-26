"use client";

import { useState } from "react";
import {
  OnbIconAlert,
  OnbIconSparkle,
} from "@/app/wizard/_components/OnboardingIcons";
import type { StepProps } from "./stepTypes";
import "../program.css";
import { PixelIconClipboard, PixelIconLaunch, PixelIconMonitor } from "../PixelIcons";

const FALLBACK_NAME = "Your program";
const FALLBACK_REPLY = "Your program's introduction shows up here once you name it.";
const FALLBACK_DESCRIPTION = "No description yet";

// What a launched program puts on the record, in the order it happens.
const WHERE_IT_SHOWS = [
  "Pixie's replies in your help channel",
  "Ticket updates for your helpers",
  "Your dashboard and program page",
];

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// The message Slack would get on day one: who Pixie is here as, then the
// program's own description, then the invitation to ask. The description is
// the only part the user wrote, so it is what the preview is really testing.
function openingMessage(name: string, description: string): string {
  if (!name) return FALLBACK_REPLY;
  const intro = `Hi! I'm the ${name} helper.`;
  return description
    ? `${intro} ${description} Ask me anything.`
    : `${intro} Ask me anything — I'll answer from your program docs.`;
}

export function ProgramStep({ draft, update }: StepProps) {
  // A link that 404s or never resolves must not leave a broken-image glyph in
  // the preview: fall back to the monogram the moment the fetch fails.
  const [iconBroken, setIconBroken] = useState(false);
  const name = draft.programName.trim();
  const slug = draft.programSlug.trim();
  const icon = draft.iconUrl.trim();
  const description = draft.programDescription.trim();
  const showIcon = icon.startsWith("https://") && !iconBroken;
  const iconIssue = icon && !icon.startsWith("https://") ? "The icon URL has to start with https://." : null;
  const monogram = [...name][0]?.toUpperCase() ?? "";
  const slugValue = slug || slugFromName(name) || "my-program";

  return (
    <div className="onboarding-step-section" data-step-panel={0}>
      <div className="onboarding-docs-grid">
        <div className="ob-program-column">
          <div className="onboarding-step-copy" aria-live="polite">
            <p className="onboarding-step-eyebrow ob-program-step">STEP 1 OF 5</p>
            <h1 className="onboarding-title">Create your program</h1>
            <p className="onboarding-lede ob-program-lede">
              This is how Pixie introduces your program in Slack. You can change it later.
            </p>
          </div>
          <div className="ob-program-fields">
            <div className="ob-program-field">
              <label className="onboarding-field-label ob-program-label" htmlFor="pg-name">
                Program name
              </label>
              <input
                id="pg-name"
                className="onboarding-input ob-program-input"
                type="text"
                value={draft.programName}
                maxLength={80}
                placeholder="e.g. Hardware Club"
                onChange={(event) => update({ programName: event.target.value })}
              />
            </div>
            <div className="ob-program-field">
              <label className="onboarding-field-label ob-program-label" htmlFor="pg-description">
                Short description · optional
              </label>
              <textarea
                id="pg-description"
                className="onboarding-textarea ob-program-area"
                value={draft.programDescription}
                maxLength={500}
                rows={4}
                placeholder="A short line about what members are building"
                onChange={(event) => update({ programDescription: event.target.value })}
              />
            </div>
            <div className="ob-program-row">
              <div className="ob-program-field">
                <label className="onboarding-field-label ob-program-label" htmlFor="pg-slug">
                  URL slug · optional
                </label>
                <input
                  id="pg-slug"
                  className="onboarding-input ob-program-input"
                  type="text"
                  value={draft.programSlug}
                  maxLength={60}
                  placeholder={slugFromName(name) || "my-program"}
                  onChange={(event) => update({ programSlug: event.target.value })}
                />
                <p className="ob-program-hint" data-hint={!slug}>
                  Used in links to your program · <span className="ob-program-hint-value">{slugValue}</span>
                </p>
              </div>
              <div className="ob-program-field">
                <label className="onboarding-field-label ob-program-label" htmlFor="pg-icon">
                  Icon URL · optional
                </label>
                <input
                  id="pg-icon"
                  className="onboarding-input ob-program-input"
                  type="url"
                  value={draft.iconUrl}
                  placeholder="https://example.com/icon.png"
                  aria-invalid={iconIssue ? true : undefined}
                  aria-describedby={iconIssue ? "pg-icon-issue" : undefined}
                  onChange={(event) => {
                    setIconBroken(false);
                    update({ iconUrl: event.target.value });
                  }}
                />
                {iconIssue ? (
                  <p className="ob-program-problem" id="pg-icon-issue" role="alert">
                    <OnbIconAlert size={14} />
                    {iconIssue}
                  </p>
                ) : (
                  <p className="ob-program-hint">Shown on Pixie&apos;s messages where your program leads.</p>
                )}
              </div>
            </div>
          </div>
          <div className="ob-program-post">
            <span className="ob-program-post-mark" aria-hidden="true">
              <PixelIconLaunch size={16} />
            </span>
            <div className="ob-program-post-copy">
              <p className="ob-program-post-title">Nothing is posted yet</p>
              <p className="ob-program-post-note">
                Pixie uses this name in Slack once you launch on step 5.
              </p>
            </div>
          </div>
        </div>
        <aside className="onboarding-preview ob-program-preview" aria-labelledby="preview-title">
          <div className="onboarding-preview-heading">
            <span className="onboarding-preview-spark ob-program-spark" aria-hidden="true">
              <OnbIconSparkle size={30} />
            </span>
            <div>
              <h2 className="onboarding-preview-title" id="preview-title">How it appears</h2>
              <p className="onboarding-preview-copy">A live preview of how Pixie introduces your program in Slack.</p>
            </div>
          </div>
          <div className="onboarding-preview-list ob-program-list">
            <article className="onboarding-preview-card ob-program-card">
              <div className="onboarding-preview-card-head">
                <span className="ob-program-avatar" data-empty={!monogram} aria-hidden="true">
                  {showIcon ? (
                    <img src={icon} alt="" onError={() => setIconBroken(true)} />
                  ) : monogram || <PixelIconClipboard size={16} />}
                </span>
                <div className="onboarding-preview-name ob-program-msg">
                  <span className="ob-program-msg-name">
                    {name ? `${name} Help` : FALLBACK_NAME}
                  </span>
                  <span className="onboarding-preview-type">In your help channel</span>
                </div>
              </div>
              <p className="ob-program-msg-body">{openingMessage(name, description)}</p>
            </article>
            <article className="onboarding-preview-card ob-program-where">
              <div className="onboarding-preview-card-head">
                <span className="onboarding-preview-mark ob-program-where-mark" aria-hidden="true">
                  <PixelIconMonitor size={32} />
                </span>
                <div className="onboarding-preview-name ob-program-where-title">Where it shows</div>
              </div>
              <ul className="onboarding-preview-bullets ob-program-where-list">
                {WHERE_IT_SHOWS.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </article>
            <article className="onboarding-preview-card ob-program-home">
              <div className="onboarding-preview-card-head">
                <span className="onboarding-preview-mark ob-program-home-mark" aria-hidden="true">
                  <PixelIconClipboard size={16} />
                </span>
                <div className="onboarding-preview-name ob-program-home-title">
                  In your dashboard
                  <span className="onboarding-preview-type">Your program page</span>
                </div>
              </div>
              <ul className="onboarding-preview-bullets ob-program-home-list">
                <li>{name || FALLBACK_NAME}</li>
                <li>{description || FALLBACK_DESCRIPTION}</li>
                <li>/{slugValue}</li>
              </ul>
            </article>
          </div>
        </aside>
      </div>
    </div>
  );
}
