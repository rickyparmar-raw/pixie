import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTicketDetail, coreMacrosList } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";
import { TicketActions } from "./TicketActions";
import { CopilotPanel } from "./CopilotPanel";
import { MacroSendForm, type MacroRow } from "../../macros/MacroForms";

interface TicketDetail {
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
  events: Array<{ id: number; event_type: string; actor_id: string | null; detail: string | null; created_at: number }>;
  notes: Array<{ id: number; author_id: string; body: string; created_at: number }>;
}

export default async function TicketPage({
  params,
}: {
  params: Promise<{ id: string; ticketId: string }>;
}) {
  const { id, ticketId } = await params;
  await requireProgramMembership(id);

  let detail: TicketDetail | null = null;
  let loadError: string | null = null;
  try {
    detail = (await coreTicketDetail(Number(ticketId), id)) as TicketDetail;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load the ticket.";
  }

  if (loadError || !detail) {
    return (
      <>
        <CoreError message={loadError ?? "Ticket not found."} />
        <Link href={`/programs/${id}/tickets`} className="text-sm text-text-muted hover:text-text">← Support queue</Link>
      </>
    );
  }

  const { ticket, events, notes } = detail;

  let macros: MacroRow[] = [];
  try {
    macros = (await coreMacrosList(id)) as MacroRow[];
  } catch {
    macros = [];
  }

  return (
    <>
      <PageHeader
        title={ticket.question}
        description={[
          `#${ticket.id} · ${ticket.status}`,
          `from <@${ticket.requester_id}> in <#${ticket.channel}>`,
          ticket.assignee_id && `claimed by <@${ticket.assignee_id}>`,
          ticket.category,
          ticket.priority,
          ticket.ai_confidence !== null && `AI confidence ${Math.round(ticket.ai_confidence * 100)}%`,
        ]
          .filter(Boolean)
          .join(" · ")}
      />

      {ticket.summary && (
        <p className="mb-8 border-l-2 border-line pl-3 text-sm text-text">{ticket.summary}</p>
      )}

      <div className="space-y-10">
        <TicketActions programId={id} ticketId={ticket.id} />

        <MacroSendForm programId={id} ticketId={ticket.id} macros={macros.filter((m) => m.enabled)} />

        <CopilotPanel programId={id} ticketId={ticket.id} question={ticket.question} threadTs={ticket.thread_ts} />

        <Section title="Timeline">
          <ul className="space-y-2 text-sm text-text-muted">
            {events.map((e) => (
              <li key={e.id}>
                <span className="text-text">{e.event_type}</span>
                {e.actor_id && <> by &lt;@{e.actor_id}&gt;</>} · {new Date(e.created_at).toLocaleString()}
              </li>
            ))}
            {events.length === 0 && <li>No events yet.</li>}
          </ul>
        </Section>

        <Section title="Internal notes">
          <ul className="space-y-3 text-sm">
            {notes.map((n) => (
              <li key={n.id} className="border-l-2 border-line pl-3">
                <p className="text-text">{n.body}</p>
                <p className="mt-1 text-xs text-text-muted">&lt;@{n.author_id}&gt; · {new Date(n.created_at).toLocaleString()}</p>
              </li>
            ))}
            {notes.length === 0 && <li className="text-text-muted">No notes yet.</li>}
          </ul>
        </Section>
      </div>
    </>
  );
}
