import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTicketDetail, coreMacrosList } from "@/lib/pixieCore";
import { Section, CoreError, StatusDot, EmptyState } from "@/app/_components/DashboardShell";
import { shortTime, userLabel } from "@/app/_components/format";
import { TicketActions } from "./TicketActions";
import { CopilotPanel } from "./CopilotPanel";
import { MacroSendForm, type MacroRow } from "../../macros/MacroForms";

type TicketDetail = {
  ticket: {
    id: number;
    program_id: string;
    channel: string;
    thread_ts: string;
    requester_id: string;
    question: string;
    summary: string | null;
    category: string | null;
    priority: string | null;
    status: string;
    assignee_id: string | null;
    ai_confidence: number | null;
    ai_decision: string | null;
    created_at: number;
    resolved_at: number | null;
  };
  events: Array<{ id: number; event_type?: string; kind?: string; actor_id: string | null; detail?: string | null; note?: string | null; created_at: number }>;
  notes: Array<{ id: number; author_id: string; body: string; created_at: number }>;
};

export default async function TicketPage({ params }: { params: Promise<{ id: string; ticketId: string }> }) {
  const { id, ticketId } = await params;
  await requireProgramMembership(id);

  let detail: TicketDetail | null = null;
  let loadError: string | null = null;
  try {
    detail = (await coreTicketDetail(Number(ticketId), id)) as TicketDetail;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "This ticket could not be loaded.";
  }

  if (loadError || !detail) {
    return (
      <>
        <Crumb programId={id} ticketId={ticketId} />
        <CoreError message={loadError ?? "Ticket not found."} />
      </>
    );
  }

  const { ticket } = detail;
  const events = Array.isArray(detail.events) ? detail.events : [];
  const notes = Array.isArray(detail.notes) ? detail.notes : [];

  let macros: MacroRow[] = [];
  try {
    macros = (await coreMacrosList(id)) as MacroRow[];
  } catch {
    macros = [];
  }

  const meta = [
    `from ${userLabel(ticket.requester_id)}`,
    ticket.assignee_id ? `assigned ${userLabel(ticket.assignee_id)}` : null,
    ticket.category,
    ticket.priority && ticket.priority !== "normal" ? ticket.priority : null,
    typeof ticket.ai_confidence === "number" ? `AI confidence ${Math.round(ticket.ai_confidence * 100)}%` : null,
    `opened ${shortTime(ticket.created_at)}`,
  ].filter(Boolean);

  return (
    <>
      <Crumb programId={id} ticketId={String(ticket.id)} />

      <div className="mb-8">
        <StatusDot status={ticket.status}>{ticket.status.replace(/_/g, " ")}</StatusDot>
        <h1 className="mt-2 text-lg leading-snug text-text">{ticket.question}</h1>
        <p className="mt-2 font-mono text-xs text-text-muted">{meta.join("  ·  ")}</p>
        {ticket.summary && (
          <p className="mt-3 border-l-2 border-line pl-3 text-sm text-text-muted">{ticket.summary}</p>
        )}
      </div>

      <div className="space-y-10">
        <TicketActions programId={id} ticketId={ticket.id} />
        <MacroSendForm programId={id} ticketId={ticket.id} macros={macros.filter((m) => m.enabled)} />
        <CopilotPanel programId={id} ticketId={ticket.id} question={ticket.question} threadTs={ticket.thread_ts} />

        <Section title="Timeline">
          {events.length === 0 ? (
            <EmptyState title="No events yet." />
          ) : (
            <ol>
              {events.map((e, i) => (
                <li key={e.id} className="grid grid-cols-[1.5rem_1fr] gap-x-3">
                  <div className="flex flex-col items-center">
                    <span className="mt-1 size-1.5 rounded-full bg-text-muted" aria-hidden />
                    {i < events.length - 1 && <span className="w-px flex-1 bg-line" aria-hidden />}
                  </div>
                  <div className="pb-4">
                    <p className="text-sm text-text">
                      {(e.event_type || e.kind || "event").replace(/_/g, " ")}{" "}
                      {e.actor_id && <span className="font-mono text-xs text-text-muted">{userLabel(e.actor_id)}</span>}{" "}
                      <span className="font-mono text-xs text-text-muted">{shortTime(e.created_at)}</span>
                    </p>
                    {(e.detail || e.note) && <p className="mt-1 text-sm text-text-muted">{e.detail || e.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Internal notes">
          {notes.length === 0 ? (
            <EmptyState title="No notes yet." hint="Notes stay on the ticket and never reach the asker." />
          ) : (
            <ul className="space-y-3 text-sm">
              {notes.map((n) => (
                <li key={n.id} className="border-l-2 border-line pl-3">
                  <p className="text-text">{n.body}</p>
                  <p className="mt-1 font-mono text-xs text-text-muted">
                    {userLabel(n.author_id)} · {shortTime(n.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function Crumb({ programId, ticketId }: { programId: string; ticketId: string }) {
  return (
    <p className="mb-6 font-mono text-xs text-text-muted">
      <Link href={`/programs/${programId}/tickets`} className="hover:text-text">
        Tickets
      </Link>
      <span className="px-1.5 text-text-muted/50">/</span>#{ticketId}
    </p>
  );
}
