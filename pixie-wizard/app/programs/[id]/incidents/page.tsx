import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreIncidents, coreIncidentDetail, coreIncidentAffected } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";
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
  await requireProgramMembership(id);

  let incidents: Incident[] = [];
  let loadError: string | null = null;
  try {
    incidents = (await coreIncidents(id)) as Incident[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load incidents.";
  }

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Candidates never notify anyone. Confirm one, then post the announcement yourself."
        actions={<IncidentDetectButton programId={id} />}
      />

      {loadError && <CoreError message={loadError} />}

      <ul className="divide-y divide-line border-t border-line">
        {incidents.map((inc) => (
          <li key={inc.id} className="py-3">
            <Link href={`/programs/${id}/incidents/${inc.id}`} className="group block">
              <p className="text-xs text-text-muted">
                #{inc.id} · {inc.status}
                {inc.confidence ? ` · ${Math.round(inc.confidence * 100)}%` : ""}
              </p>
              <p className="mt-0.5 text-sm text-text group-hover:text-brand">{inc.title}</p>
              {inc.reason && <p className="mt-0.5 text-xs text-text-muted">{inc.reason}</p>}
            </Link>
          </li>
        ))}
      </ul>
      {incidents.length === 0 && !loadError && (
        <p className="text-sm text-text-muted">No incidents. Bursts of similar tickets surface here as candidates.</p>
      )}
    </>
  );
}

export async function IncidentDetailSection({ programId, incidentId }: { programId: string; incidentId: number }) {
  const detail = (await coreIncidentDetail(incidentId)) as {
    incident: Incident & { description?: string | null; public_message?: string | null };
    tickets: Array<{ id: number; question: string; status: string }>;
  };
  const affected = await coreIncidentAffected(incidentId).catch(() => null);

  return (
    <div className="space-y-10">
      <div>
        <p className="text-xs text-text-muted">#{detail.incident.id} · {detail.incident.status}</p>
        <h1 className="mt-1 text-lg font-medium text-text">{detail.incident.title}</h1>
        {detail.incident.reason && <p className="mt-2 text-sm text-text-muted">{detail.incident.reason}</p>}
        {detail.incident.description && <p className="mt-2 text-sm text-text-muted">{detail.incident.description}</p>}
        {detail.incident.public_message && (
          <p className="mt-3 border-l-2 border-line pl-3 text-sm text-text-muted">
            Pixie tells askers: &ldquo;{detail.incident.public_message}&rdquo;
          </p>
        )}
        {affected && affected.total > 0 && (
          <p className="mt-2 text-sm text-text-muted">
            {affected.total} affected thread{affected.total === 1 ? "" : "s"} tracked
            {affected.unnotified > 0 ? ` · ${affected.unnotified} can be notified` : " · all notified"}.
          </p>
        )}
      </div>

      <IncidentControls programId={programId} incidentId={detail.incident.id} status={detail.incident.status} />

      <Section title={`Linked tickets (${detail.tickets.length})`}>
        <ul className="space-y-1 text-sm">
          {detail.tickets.map((t) => (
            <li key={t.id}>
              <Link href={`/programs/${programId}/tickets/${t.id}`} className="text-text hover:text-brand">
                #{t.id} · {t.status}
              </Link>
              <span className="text-text-muted"> — {t.question}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
