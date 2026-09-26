"use client";

import { useEffect, useRef, useState } from "react";
import { lookupSlackPeople } from "@/app/wizard/hostedActions";
import {
  DEMO_PEOPLE,
  HELPER_TAGS,
  isSlackUserId,
  routeTag,
} from "@/lib/onboardingDraft";
import {
  OnbIconArrowRight,
  OnbIconClose,
  OnbIconSparkle,
} from "@/app/wizard/_components/OnboardingIcons";
import type { StepProps } from "./stepTypes";
import "../helpers.css";

type Person = { name: string; handle: string | null; avatarUrl: string | null };

const EXAMPLE_QUESTIONS = [
  "Where’s my hardware grant?",
  "I can’t sign in to my account.",
] as const;
const LOOKUP_NOTE = "Couldn’t load names from Slack — IDs still work.";
const ROUTING_RULES = [
  "A helper with no tags is still used when nothing matches.",
  "Tags, people, and channels can all change after launch.",
];

function RouteExample({ tag, owned, target, question }: {
  tag: string | null;
  owned: boolean;
  target: string | null;
  question: string;
}) {
  return (
    <div className="ob-helpers-flow">
      <p className="ob-helpers-label ob-helpers-label-flow">Member asks</p>
      <p className="ob-helpers-question">&ldquo;{question}&rdquo;</p>
      <span className="ob-helpers-link" aria-hidden="true"><OnbIconArrowRight size={16} /></span>
      <p className="ob-helpers-label ob-helpers-label-flow">Closest tag</p>
      <p className="ob-helpers-chain">
        <span className="ob-helpers-tag" data-on={owned}>{tag ?? "No tag"}</span>
        <span className="ob-helpers-link" aria-hidden="true"><OnbIconArrowRight size={16} /></span>
        <span className="ob-helpers-target" data-empty={target ? undefined : "true"}>
          {target ?? "No one tagged yet"}
        </span>
      </p>
      <p className="ob-helpers-verdict">
        {target
          ? `Pixie hands this to ${target}.`
          : tag
            ? `No one has the ${tag} tag yet — Pixie answers it.`
            : "No tag matches, so Pixie answers it from your docs."}
      </p>
    </div>
  );
}

export function HelpersStep({ draft, update, demoMode, creatorSlackId }: StepProps) {
  const [raw, setRaw] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const [people, setPeople] = useState<Record<string, Person | null>>({});
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const asked = useRef(new Set<string>());

  const added = [...new Set(draft.helpers.map((helper) => helper.slackId))];
  const rows = creatorSlackId
    ? [creatorSlackId, ...added.filter((id) => id !== creatorSlackId)]
    : added;
  const rowsKey = rows.join(" ");

  useEffect(() => {
    const wanted = rowsKey ? rowsKey.split(" ") : [];
    const fresh = wanted.filter((id) => !asked.current.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => asked.current.add(id));
    if (demoMode) {
      setPeople((current) => ({
        ...current,
        ...Object.fromEntries(fresh.map((id) => {
          const person = DEMO_PEOPLE[id];
          return [id, person ? { name: person.name, handle: person.handle, avatarUrl: null } : null];
        })),
      }));
      return;
    }
    let live = true;
    let settled = false;
    void lookupSlackPeople(fresh).then(
      (result) => {
        settled = true;
        if (!live) return;
        setPeople((current) => ({ ...current, ...result.people }));
        setLookupNote(result.ok ? null : LOOKUP_NOTE);
      },
      () => {
        settled = true;
        if (!live) return;
        setExpired(true);
      },
    );
    return () => {
      live = false;
      // A discarded in-flight lookup (StrictMode remount, rows changed) must be
      // retried by the next run, not remembered as already asked.
      if (!settled) fresh.forEach((id) => asked.current.delete(id));
    };
  }, [rowsKey, demoMode]);

  const add = () => {
    const typed = raw.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
    if (!typed.length) {
      setIssue("Paste a Slack user ID.");
      return;
    }
    const ids = typed.map((part) => part.toUpperCase());
    const bad = ids.findIndex((id) => !isSlackUserId(id));
    if (bad >= 0) {
      setIssue(`${typed[bad]} isn’t a Slack user ID — they look like U0123ABCD.`);
      return;
    }
    const fresh = ids.filter((id) => id !== creatorSlackId && !draft.helpers.some((helper) => helper.slackId === id));
    if (!fresh.length) {
      setIssue(ids.every((id) => id === creatorSlackId)
        ? "You’re already the owner of this program."
        : "Those helpers are already on the list.");
      return;
    }
    update((d) => ({ ...d, helpers: [...d.helpers, ...fresh.map((slackId) => ({ slackId, tags: [] }))] }));
    setRaw("");
    setIssue(null);
  };

  const remove = (slackId: string) => {
    update((d) => ({ ...d, helpers: d.helpers.filter((helper) => helper.slackId !== slackId) }));
  };

  const toggleTag = (slackId: string, tag: string) => {
    update((d) => {
      const helper = d.helpers.find((entry) => entry.slackId === slackId);
      if (!helper) return d;
      const tags = helper.tags.includes(tag)
        ? helper.tags.filter((entry) => entry !== tag)
        : [...helper.tags, tag];
      return {
        ...d,
        helpers: tags.length
          ? d.helpers.map((entry) => (entry.slackId === slackId ? { slackId, tags } : entry))
          : d.helpers.filter((entry) => entry.slackId !== slackId),
      };
    });
  };

  const tagsFor = (slackId: string): string[] =>
    draft.helpers.find((helper) => helper.slackId === slackId)?.tags ?? [];

  // Two fixed questions, routed by the same tag rules the live answer uses, so
  // toggling a chip below moves the name above. The pair covers both outcomes:
  // a tag somebody owns, and a tag nobody has tagged yet.
  const nameOf = (slackId: string, person: Person | null): string => {
    const base = person?.name ?? slackId;
    if (slackId === creatorSlackId) return `${base} · you`;
    return person?.handle ? `${base} · @${person.handle}` : base;
  };

  const routes = EXAMPLE_QUESTIONS.map((question) => {
    const tag = routeTag(question);
    const owner = tag ? draft.helpers.find((helper) => helper.tags.includes(tag)) : undefined;
    const ownerPerson = owner ? people[owner.slackId] ?? null : null;
    return {
      question,
      tag,
      owned: Boolean(owner),
      target: owner ? nameOf(owner.slackId, ownerPerson) : null,
    };
  });

  return (
    <div className="onboarding-step-section" data-step-panel={3}>
      <div className="onboarding-docs-grid">
        <div>
          <div className="onboarding-step-copy">
            <p className="onboarding-step-eyebrow">STEP 4 OF 5</p>
            <h1 className="onboarding-title">Add your helpers</h1>
            <p className="onboarding-lede">
              Pick the people Pixie hands questions to, and what each one knows best.
            </p>
          </div>

          <div className="ob-helpers-add">
            <div className="ob-helpers-add-row">
              <label className="ob-helpers-add-field">
                <span className="ob-helpers-label">Add by Slack ID</span>
                <input
                  className="ob-helpers-input"
                  type="text"
                  value={raw}
                  placeholder="U0123ABCD, W0123ABCD"
                  data-invalid={issue ? "true" : undefined}
                  onChange={(event) => {
                    setRaw(event.target.value);
                    setIssue(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      add();
                    }
                  }}
                />
              </label>
              <button className="ob-helpers-add-btn" type="button" onClick={add}>
                Add
              </button>
            </div>
            {!issue ? (
              <p className="ob-helpers-hint">
                Open someone&apos;s profile in Slack and copy their User ID — it looks like U0123ABCD.
              </p>
            ) : null}
            {issue ? <p className="ob-helpers-issue" role="alert">{issue}</p> : null}
            {expired ? (
              <p className="ob-helpers-expired" role="alert">
                Your session expired.{" "}
                <a href="/api/auth/login">Sign in again</a> to load names — IDs still work.
              </p>
            ) : null}
            {!expired && lookupNote ? <p className="ob-helpers-lookup">{lookupNote}</p> : null}
          </div>

          {rows.length === 0 ? (
            <p className="ob-helpers-empty">Pick at least one person Pixie can hand questions to.</p>
          ) : (
            <>
              <p className="ob-helpers-tags-hint">Tap the topics each person knows.</p>
              <ul className="ob-helpers-list">
                {rows.map((slackId) => {
                  const person = people[slackId] ?? null;
                  const isCreator = slackId === creatorSlackId;
                  return (
                    <li className="ob-helpers-row" key={slackId}>
                      <div className="ob-helpers-row-body">
                        <div className="ob-helpers-row-top">
                          <span className="ob-helpers-avatar" aria-hidden="true">
                            {person?.avatarUrl ? (
                              <img src={person.avatarUrl} alt="" />
                            ) : (
                              (person?.name ?? slackId).slice(0, 1).toUpperCase()
                            )}
                          </span>
                          <span className="ob-helpers-copy">
                            <span className="ob-helpers-name">{person?.name ?? (isCreator ? "You" : slackId)}</span>
                            <span className="ob-helpers-sub">{person?.handle ? `@${person.handle}` : slackId}</span>
                          </span>
                        </div>
                        <div className="ob-helpers-tags">
                          {HELPER_TAGS.map((tagName) => {
                            const on = tagsFor(slackId).includes(tagName);
                            return (
                              <button
                                className="ob-helpers-tag"
                                data-on={on}
                                type="button"
                                key={tagName}
                                aria-pressed={on}
                                onClick={() => toggleTag(slackId, tagName)}
                              >
                                {tagName}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      {isCreator ? (
                        <span className="ob-helpers-owner">You · owner</span>
                      ) : (
                        <button
                          className="ob-helpers-remove"
                          type="button"
                          aria-label={`Remove ${person?.name ?? slackId}`}
                          onClick={() => remove(slackId)}
                        >
                          <OnbIconClose size={11} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <p className="ob-helpers-foot">
            Helpers are optional. Pixie answers from your docs on its own and only hands a question over
            when a person is the better answer.
          </p>
        </div>

        <aside className="onboarding-preview" aria-labelledby="preview-title">
          <div className="onboarding-preview-heading">
            <span className="onboarding-preview-spark ob-helpers-spark" aria-hidden="true">
              <OnbIconSparkle size={26} />
            </span>
            <div>
              <h2 className="onboarding-preview-title" id="preview-title">How routing works</h2>
              <p className="onboarding-preview-copy">
                Pixie reads the question, picks the closest tag, and hands it to whoever has that tag.
              </p>
            </div>
          </div>
          <div className="onboarding-preview-list">
            {routes.map((route) => (
              <div className="onboarding-preview-card" key={route.question}>
                <RouteExample {...route} />
              </div>
            ))}
          </div>
          <ul className="ob-helpers-rules">
            {ROUTING_RULES.map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
        </aside>
      </div>
    </div>
  );
}
