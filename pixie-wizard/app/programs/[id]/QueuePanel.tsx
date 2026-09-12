"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Section, DataRow, EmptyState } from "@/app/_components/DashboardShell";
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
            <span className={`size-1.5 rounded-full ${live ? "bg-mint" : "bg-line"}`} aria-hidden />
            {live ? "Live" : "Loading…"}
          </span>
        ) : undefined
      }
    >
      {empty ? (
        <EmptyState title="Nothing in your queue." hint="Tickets assigned to you, or waiting to be claimed, show up here." />
      ) : (
        <div className="space-y-6">
          {queue.assigned.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-text-muted">Assigned to you · {queue.assigned.length}</p>
              <ul className="divide-y divide-line">
                {queue.assigned.map((t) => (
                  <li key={t.id}>
                    <DataRow
                      href={`/programs/${programId}/tickets/${t.id}`}
                      lead={<span className="grid size-5 place-items-center rounded-full bg-brand/15 text-brand"><IconChat size={11} /></span>}
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
              <p className="mb-1 text-xs font-medium text-text-muted">You can claim · {queue.claimable.length}</p>
              <ul className="divide-y divide-line">
                {queue.claimable.map((t) => (
                  <li key={t.id}>
                    <DataRow
                      href={`/programs/${programId}/tickets/${t.id}`}
                      lead={<span className="grid size-5 place-items-center rounded-full bg-tang/15 text-tang"><IconHand size={11} /></span>}
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
        <p className="mt-4 text-xs text-text-muted">
          Your Hack Club Auth account isn&apos;t linked to a Slack identity, so Pixie can&apos;t match tickets to you personally.
        </p>
      )}
    </Section>
  );
}
