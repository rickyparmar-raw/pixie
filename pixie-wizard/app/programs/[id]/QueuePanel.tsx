"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Section, DataRow, EmptyState, Notice } from "@/app/_components/DashboardShell";
import { IconHand, IconChat } from "@/app/_components/icons";
import { timeAgo } from "@/app/_components/format";
import { getMyQueue, type QueueResult } from "./queueActions";

const POLL_MS = 20_000;

// The dashboard's one genuinely live surface: what's assigned to you and
// what's waiting to be claimed, re-fetched on an interval instead of only on
// page load — a helper working a queue shouldn't have to hit refresh to see
// a new ticket land. Server-rendered `initial` avoids a loading flash; the
// poll only ever replaces it, never blanks it (a slow/failed tick keeps
// showing the last good result).
export function QueuePanel({ programId, initial, hasSlack }: { programId: string; initial: QueueResult; hasSlack: boolean }) {
  const [queue, setQueue] = useState(initial);
  const [live, setLive] = useState(false);
  const [, startTransition] = useTransition();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!hasSlack) return;
    const tick = () => {
      startTransition(async () => {
        try {
          const next = await getMyQueue(programId);
          if (mounted.current) {
            setQueue(next);
            setLive(true);
          }
        } catch {
          // Keep showing the last good queue — a missed tick isn't an error
          // worth surfacing, the next one will just try again.
        }
      });
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [programId, hasSlack]);

  const empty = queue.assigned.length === 0 && queue.claimable.length === 0;

  return (
    <Section
      bordered
      title="Your queue"
      description={hasSlack ? "Assigned to you, and what you can claim right now." : "Link a Slack account to see tickets assigned to you."}
      actions={
        hasSlack ? (
          <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <span className={`size-1.5 rounded-[1px] ${live ? "bg-mint" : "bg-line-strong"}`} aria-hidden />
            {live ? "Live" : "Loading…"}
          </span>
        ) : undefined
      }
    >
      {empty ? (
        <EmptyState title="Nothing in your queue." hint="Tickets assigned to you, or waiting to be claimed, show up here." />
      ) : (
        <div className="space-y-5">
          {queue.assigned.length > 0 && (
            <div>
              <p className="pixie-eyebrow mb-1.5 flex items-center gap-2 text-text-muted">
                <span className="pixie-mark" aria-hidden="true" />
                Assigned to you
                <span className="font-mono text-[11px] tabular-nums normal-case tracking-normal text-text">
                  {queue.assigned.length}
                </span>
              </p>
              <ul className="divide-y divide-line">
                {queue.assigned.map((t) => (
                  <li key={t.id}>
                    <DataRow
                      href={`/programs/${programId}/tickets/${t.id}`}
                      lead={
                        <span className="grid size-6 place-items-center rounded-[2px] bg-brand/15 text-brand">
                          <IconChat size={16} />
                        </span>
                      }
                      title={t.title}
                      sub={<span>{t.status.replace(/_/g, " ")} · {t.requesterLabel}</span>}
                      meta={timeAgo(t.createdAt)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {queue.claimable.length > 0 && (
            <div>
              <p className="pixie-eyebrow mb-1.5 flex items-center gap-2 text-text-muted">
                <span className="pixie-mark" aria-hidden="true" />
                You can claim
                <span className="font-mono text-[11px] tabular-nums normal-case tracking-normal text-text">
                  {queue.claimable.length}
                </span>
              </p>
              <ul className="divide-y divide-line">
                {queue.claimable.map((t) => (
                  <li key={t.id}>
                    <DataRow
                      href={`/programs/${programId}/tickets/${t.id}`}
                      lead={
                        <span className="grid size-6 place-items-center rounded-[2px] bg-tang/15 text-tang">
                          <IconHand size={16} />
                        </span>
                      }
                      title={t.title}
                      sub={<span>waiting · {t.requesterLabel}</span>}
                      meta={timeAgo(t.createdAt)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {!hasSlack && (
        <div className="mt-4">
          <Notice tone="warn">
            Your Hack Club Auth account isn&apos;t linked to a Slack identity, so Pixie can&apos;t match
            tickets to you personally.
          </Notice>
        </div>
      )}
    </Section>
  );
}
