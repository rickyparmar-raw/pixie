"use client";

import { useState, type ReactNode } from "react";
import { isSlackChannelId } from "@/lib/onboardingDraft";
import type { CoreChannel } from "@/lib/pixieCore";
import {
  OnbIconAlert,
  OnbIconArrowRight,
  OnbIconCheckCircle,
  OnbIconSparkle,
} from "../OnboardingIcons";
import type { StepProps } from "./stepTypes";
import "../channels.css";
import { PixelIconLock } from "../PixelIcons";

// Six entries is as much as a calm picker shows before it becomes a directory.
const MAX_ROWS = 6;

// Offline reads as instructions, not a status: a first-timer has to learn where
// the ID lives inside Slack and what happens to it before they can carry on.
const OFFLINE_NOTICE =
  "Slack isn’t reachable right now, so channels can’t be listed. Paste each " +
  "channel’s ID (in Slack: channel name → About → Channel ID). Pixie checks " +
  "access when Core syncs.";

const EMPTY_CHANNELS_NOTICE =
  "No channels yet. Run /invite @Pixie in a channel, then refresh.";

function channelMatches(channel: CoreChannel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return channel.name.toLowerCase().includes(needle) || channel.id.toLowerCase().includes(needle);
}

function Picker({
  label,
  fieldLabel,
  hint,
  value,
  channels,
  query,
  placeholder,
  onQuery,
  onPick,
  issue,
}: {
  label: ReactNode;
  fieldLabel: string;
  hint: string;
  value: string;
  channels: CoreChannel[];
  query: string;
  placeholder: string;
  onQuery: (next: string) => void;
  onPick: (id: string) => void;
  issue: ReactNode;
}) {
  // A pasted ID Core doesn't list (or any ID while Core is offline) still has
  // to read as the current choice, so it gets a synthetic row.
  const selected = channels.find((channel) => channel.id === value)
    ?? (value ? { id: value, name: value, isMember: true } : undefined);
  const typedId = query.trim().toUpperCase();
  const typed = isSlackChannelId(typedId) ? typedId : "";
  const matches = channels.filter((channel) => channelMatches(channel, query));
  const rows = matches.slice(0, MAX_ROWS);
  const pinned = selected && !rows.some((row) => row.id === selected.id) ? selected : null;

  const commit = () => {
    if (typed) onPick(typed);
  };

  return (
    <section className="ob-channels-block">
      <div className="ob-channels-block-head">
        <span className="ob-channels-mark" aria-hidden="true">
          #
        </span>
        <h2 className="ob-channels-label">{label}</h2>
      </div>
      <p className="ob-channels-hint">{hint}</p>
      <div
        className="ob-channels-search"
        data-count={!typed && matches.length > MAX_ROWS ? "true" : undefined}
      >
        <input
          className="ob-channels-input"
          type="text"
          value={query}
          placeholder={placeholder}
          aria-label={fieldLabel}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        {typed ? (
          <button className="ob-channels-use" type="button" onClick={commit}>
            Use ID
          </button>
        ) : matches.length > MAX_ROWS ? (
          <span className="ob-channels-count">
            {matches.length} channels
          </span>
        ) : null}
      </div>
      {pinned || rows.length ? (
        <ul className="ob-channels-list">
          {pinned ? <Row channel={pinned} selected onPick={onPick} key={pinned.id} /> : null}
          {rows.map((channel) => (
            <Row channel={channel} selected={channel.id === value} onPick={onPick} key={channel.id} />
          ))}
        </ul>
      ) : null}
      {query.trim() && !rows.length && !typed ? (
        <p className="ob-channels-miss">No channel matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : null}
      {issue}
    </section>
  );
}

function Row({
  channel,
  selected,
  onPick,
}: {
  channel: CoreChannel;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <li>
      <button
        className="ob-channels-row"
        type="button"
        data-selected={selected}
        aria-pressed={selected}
        onClick={() => onPick(channel.id)}
      >
        <span className="ob-channels-row-name">{channel.name === channel.id ? channel.id : `#${channel.name}`}</span>
        {channel.isMember ? null : <span className="ob-channels-note">invite @Pixie</span>}
        {selected ? (
          <OnbIconCheckCircle size={17} className="ob-channels-row-check" />
        ) : null}
      </button>
    </li>
  );
}

function Issue({ tone, children }: { tone: "hint" | "error"; children: ReactNode }) {
  if (tone === "error") {
    return (
      <p className="onboarding-error ob-channels-issue" role="alert">
        <OnbIconAlert size={13} className="ob-channels-issue-icon" />
        <span>{children}</span>
      </p>
    );
  }
  return (
    <p className="ob-channels-issue ob-channels-hint-issue">
      <OnbIconAlert size={13} className="ob-channels-issue-icon" />
      <span>{children}</span>
    </p>
  );
}

export function ChannelsStep({ draft, update, coreLive, channels }: StepProps) {
  const [helpQuery, setHelpQuery] = useState("");
  const [helpersQuery, setHelpersQuery] = useState("");
  const help = draft.helpChannelId.trim();
  const helpers = draft.organizerChannelId.trim();
  const duplicate = Boolean(help) && help === helpers;
  const helpChannel = channels.find((channel) => channel.id === help);
  const helpersChannel = channels.find((channel) => channel.id === helpers);

  const notice = !coreLive
    ? OFFLINE_NOTICE
    : channels.length === 0
      ? EMPTY_CHANNELS_NOTICE
      : null;

  const pickHelp = (id: string) => {
    setHelpQuery("");
    update({ helpChannelId: id });
  };

  const pickHelpers = (id: string) => {
    setHelpersQuery("");
    update({ organizerChannelId: id });
  };

  return (
    <div className="ob-channels onboarding-step-section" data-step-panel={1}>
      <div className="onboarding-docs-grid">
        <div>
          <div className="onboarding-step-copy" aria-live="polite">
            <p className="onboarding-step-eyebrow ob-channels-eyebrow">STEP 2 OF 5</p>
            <h1 className="onboarding-title">Choose your channels</h1>
            <p className="onboarding-lede">
              Pixie answers in your help channel and hands anything it can&rsquo;t answer to your
              helpers, privately.
            </p>
          </div>
          {notice ? (
            <p className="ob-channels-notice">
              <OnbIconAlert size={14} className="ob-channels-notice-icon" />
              <span>{notice}</span>
            </p>
          ) : null}
          <div className="ob-channels-stack">
            <Picker
              label="Help channel"
              fieldLabel="Search or paste the help channel"
              hint="Where members ask questions. Pixie replies in threads here."
              value={help}
              channels={channels}
              query={helpQuery}
              placeholder="Search channels, or paste an ID"
              onQuery={setHelpQuery}
              onPick={pickHelp}
              issue={
                helpChannel && !helpChannel.isMember ? (
                  <Issue tone="hint">Invite @Pixie to #{helpChannel.name} before launch.</Issue>
                ) : null
              }
            />
            <Picker
              label={
                <>
                  Helpers channel
                  <span className="ob-channels-label-flag"> &middot; Private</span>
                </>
              }
              fieldLabel="Search or paste the private helpers channel"
              hint="Where tickets, claims and escalations land. Keep it private."
              value={helpers}
              channels={channels}
              query={helpersQuery}
              placeholder="Search channels, or paste an ID"
              onQuery={setHelpersQuery}
              onPick={pickHelpers}
              issue={
                duplicate ? (
                  <Issue tone="error">The help and helpers channels must be different.</Issue>
                ) : helpersChannel && !helpersChannel.isMember ? (
                  <Issue tone="hint">Invite @Pixie to #{helpersChannel.name} before launch.</Issue>
                ) : null
              }
            />
          </div>
        </div>
        <aside className="onboarding-preview ob-channels-panel" aria-labelledby="channels-preview-title">
          <div className="onboarding-preview-heading">
            <span className="onboarding-preview-spark" aria-hidden="true">
              <OnbIconSparkle size={34} />
            </span>
            <div>
              <h2 className="onboarding-preview-title" id="channels-preview-title">In Slack</h2>
              <p className="onboarding-preview-copy">
                What Pixie posts, and where your helpers pick it up.
              </p>
            </div>
          </div>
          <div className="ob-channels-feed">
            <article className="ob-channels-post">
              <div className="ob-channels-post-head">
                <span className="ob-channels-post-name">
                  {helpChannel ? `#${helpChannel.name}` : help || "#help-channel"}
                </span>
                {helpChannel && !helpChannel.isMember ? (
                  <span className="ob-channels-note">invite @Pixie</span>
                ) : null}
              </div>
              <p className="ob-channels-post-line">A member asks: How do I…?</p>
              <p className="ob-channels-post-out">
                <OnbIconArrowRight size={13} className="ob-channels-post-arrow" />
                Pixie replied in thread
              </p>
            </article>
            <article className="ob-channels-post">
              <div className="ob-channels-post-head">
                <span className="ob-channels-post-name">
                  {helpersChannel ? `#${helpersChannel.name}` : helpers || "#helpers-channel"}
                </span>
                <span className="ob-channels-lock" role="img" aria-label="Private channel"><PixelIconLock size={16} /></span>
              </div>
              <p className="ob-channels-post-line">Ticket #12 &middot; Needs a human</p>
              <p className="ob-channels-post-out">Queued for a helper</p>
            </article>
            <article className="ob-channels-private">
              <div className="ob-channels-post-head">
                <span className="ob-channels-lock ob-channels-lock-lead" aria-hidden="true"><PixelIconLock size={16} /></span>
                <span className="ob-channels-post-name">What stays private</span>
              </div>
              <ul className="ob-channels-private-list">
                <li>Ticket notes and claims</li>
                <li>Helper discussion</li>
                <li>Escalation details</li>
              </ul>
            </article>
            <p className="ob-channels-post-foot">Nothing is posted until you launch.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
