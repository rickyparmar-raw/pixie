import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreIncidents, coreIncidentDetail, coreIncidentAffected } from "@/lib/pixieCore";
import { IncidentDetectButton, IncidentControls } from "./IncidentControls";

interface Incident {
  id: number;
  title: string;
  status: string;
  reason: string | null;
  confidence: number | null;
  started_at: number;
}

export default async function IncidentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program } = await requireProgramMembership(id);

  let incidents: Incident[] = [];
  let loadError: string | null = null;
  try {
    incidents = (await coreIncidents(id)) as Incident[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load incidents.";
  }

  return (
    <main className="max-w-none px-0 py-0">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">{program.program_name} · incidents</p>
      <h1 className="font-heading mt-3 text-2xl text-text">Outages & bursts</h1>
      <p className="mt-2 text-sm text-text-muted">Candidates never notify anyone. Confirm, then post the announcement yourself.</p>

      <div className="mt-6">
        <IncidentDetectButton programId={id} />
      </div>
      {loadError && <p className="mt-4 rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{loadError} — is Pixie Core running?</p>}

      <ul className="mt-6 space-y-3">
        {incidents.map((inc) => (
          <li key={inc.id} className="rounded-lg border border-line bg-panel p-4">
            <Link href={`/programs/${id}/incidents/${inc.id}`} className="text-sm text-text hover:underline">
              <span className="font-heading text-xs text-text-muted">#{inc.id} · {inc.status}{inc.confidence ? ` · ${Math.round(inc.confidence * 100)}%` : ""}</span>
              <span className="mt-1 block">{inc.title}</span>
            </Link>
            {inc.reason && <p className="mt-1 text-xs text-text-muted">{inc.reason}</p>}
          </li>
        ))}
      </ul>
      {incidents.length === 0 && !loadError && <p className="mt-6 text-sm text-text-muted">No incidents. Bursts of similar tickets will surface here as candidates.</p>}

      <Link href={`/programs/${id}`} className="mt-8 inline-block text-sm text-text-muted underline">← Back</Link>
    </main>
  );
}

export async function IncidentDetailSection({ programId, incidentId }: { programId: string; incidentId: number }) {
  const detail = (await coreIncidentDetail(incidentId)) as {
    incident: Incident & { description?: string | null; public_message?: string | null };
    tickets: Array<{ id: number; question: string; status: string }>;
  };
  const affected = await coreIncidentAffected(incidentId).catch(() => null);
  return (
    <div className="space-y-6">
      <div>
        <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">#{detail.incident.id} · {detail.incident.status}</p>
        <h1 className="font-heading mt-3 text-xl text-text">{detail.incident.title}</h1>
        {detail.incident.reason && <p className="mt-2 text-sm text-text-muted">{detail.incident.reason}</p>}
        {detail.incident.description && <p className="mt-2 text-sm text-text-muted">{detail.incident.description}</p>}
        {detail.incident.public_message && <p className="mt-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-xs text-text-muted">What Pixie tells askers: &ldquo;{detail.incident.public_message}&rdquo;</p>}
        {affected && affected.total > 0 && (
          <p className="mt-2 text-sm text-text-muted">{affected.total} affected thread{affected.total === 1 ? "" : "s"} tracked{affected.unnotified > 0 ? ` — ${affected.unnotified} can be notified` : " — all notified"}.</p>
        )}
      </div>
      <IncidentControls programId={programId} incidentId={detail.incident.id} status={detail.incident.status} />
      <div className="rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Linked tickets ({detail.tickets.length})</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {detail.tickets.map((t) => (
            <li key={t.id}>
              <Link href={`/programs/${programId}/tickets/${t.id}`} className="text-text hover:underline">#{t.id} · {t.status}</Link>
              <span className="text-text-muted"> — {t.question}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
