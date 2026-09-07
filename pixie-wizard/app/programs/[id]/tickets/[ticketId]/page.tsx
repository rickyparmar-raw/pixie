import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram } from "@/lib/hostedPrograms";
import { coreTicketDetail } from "@/lib/pixieCore";
import { TicketActions } from "./TicketActions";
import { CopilotPanel } from "./CopilotPanel";
import { MacroSendForm, type MacroRow } from "../../macros/MacroForms";
import { coreMacrosList } from "@/lib/pixieCore";

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
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program || program.owner_hca_id !== session.hcaId) redirect("/wizard");

  let detail: TicketDetail | null = null;
  let loadError: string | null = null;
  try {
    detail = (await coreTicketDetail(Number(ticketId), id)) as TicketDetail;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load the ticket.";
  }

  if (loadError || !detail) {
    return (
      <main className="max-w-none px-0 py-0">
        <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>
        <Link href={`/programs/${id}/tickets`} className="mt-4 inline-block text-sm text-text-muted underline">← Back to queue</Link>
      </main>
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
    <main className="max-w-none px-0 py-0">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">
        {program.program_name} · ticket #{ticket.id} · {ticket.status}
      </p>
      <h1 className="font-heading mt-3 text-xl text-text">{ticket.question}</h1>
      <p className="mt-2 text-sm text-text-muted">
        from &lt;@{ticket.requester_id}&gt; in &lt;#{ticket.channel}&gt;
        {ticket.assignee_id && <> · claimed by &lt;@{ticket.assignee_id}&gt;</>}
        {ticket.category && <> · {ticket.category}</>}
        {ticket.priority && <> · {ticket.priority}</>}
        {ticket.ai_confidence !== null && <> · AI confidence {Math.round(ticket.ai_confidence * 100)}%</>}
      </p>
      {ticket.summary && <p className="mt-3 rounded-md border border-line bg-panel p-3 text-sm text-text">{ticket.summary}</p>}

      <div className="mt-6">
        <TicketActions programId={id} ticketId={ticket.id} />
      </div>

      <div className="mt-6">
        <MacroSendForm programId={id} ticketId={ticket.id} macros={macros.filter((m) => m.enabled)} />
      </div>

      <div className="mt-6">
        <CopilotPanel programId={id} ticketId={ticket.id} question={ticket.question} threadTs={ticket.thread_ts} />
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Timeline</h2>
        <ul className="mt-3 space-y-2 text-sm text-text-muted">
          {events.map((e) => (
            <li key={e.id}>
              <span className="text-text">{e.event_type}</span>
              {e.actor_id && <> by &lt;@{e.actor_id}&gt;</>} · {new Date(e.created_at).toLocaleString()}
            </li>
          ))}
          {events.length === 0 && <li>No events yet.</li>}
        </ul>
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Internal notes</h2>
        <ul className="mt-3 space-y-3 text-sm">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-line bg-panel-2 p-3">
              <p className="text-text">{n.body}</p>
              <p className="mt-1 text-xs text-text-muted">&lt;@{n.author_id}&gt; · {new Date(n.created_at).toLocaleString()}</p>
            </li>
          ))}
          {notes.length === 0 && <li className="text-text-muted">No notes yet.</li>}
        </ul>
      </div>

      <Link href={`/programs/${id}/tickets`} className="mt-8 inline-block text-sm text-text-muted underline">← Back to queue</Link>
    </main>
  );
}
