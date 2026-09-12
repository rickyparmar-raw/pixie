"use server";

import { linkedSlackSession, loadProgramContext } from "@/lib/programAccess";
import { coreTicketSearch } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";

// Personalized, pollable slice of a program's tickets — "what's mine to work
// on right now" — separate from the page's own server-rendered fetch so the
// client can re-run it on an interval (see QueuePanel) without a full page
// reload. A plain async function works as the polling target here since
// Server Actions are just POST-able RPCs once "use server" marks the file;
// no route handler needed.

type CoreTicketRow = {
  id: number;
  question: string | null;
  summary: string | null;
  status: string;
  requester_id: string;
  assignee_id: string | null;
  created_at: number;
};

export type QueueTicket = {
  id: number;
  title: string;
  status: string;
  requesterLabel: string;
  createdAt: number;
};

export type QueueResult = {
  assigned: QueueTicket[];
  claimable: QueueTicket[];
};

const EMPTY: QueueResult = { assigned: [], claimable: [] };

export async function getMyQueue(programId: string): Promise<QueueResult> {
  const session = await linkedSlackSession();
  if (!session) return EMPTY;

  // Being able to open the dashboard isn't the same as being a helper on
  // this specific program — same scoping every ticket-touching action uses.
  const { relationship } = await loadProgramContext(programId);
  if (relationship === "public") return EMPTY;

  let rows: CoreTicketRow[];
  try {
    const res = await coreTicketSearch({ programId, limit: "60" });
    rows = (res.rows ?? []) as CoreTicketRow[];
  } catch {
    return EMPTY;
  }

  const assignedRaw = rows
    .filter((t) => t.assignee_id === session.slackId && t.status !== "resolved")
    .sort((a, b) => a.created_at - b.created_at);
  const claimableRaw = rows
    .filter((t) => t.status === "waiting_for_helper" && !t.assignee_id)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, 8);

  const identities = await resolveIdentities([...assignedRaw, ...claimableRaw].map((t) => t.requester_id));
  const toQueueTicket = (t: CoreTicketRow): QueueTicket => ({
    id: t.id,
    title: t.summary || t.question || "Ticket",
    status: t.status,
    requesterLabel: labelFor(identities, t.requester_id),
    createdAt: t.created_at,
  });

  return {
    assigned: assignedRaw.map(toQueueTicket),
    claimable: claimableRaw.map(toQueueTicket),
  };
}
