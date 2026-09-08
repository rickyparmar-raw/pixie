import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreIncidents, coreIncidentDetail, coreIncidentAffected } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError, StatusDot, EmptyState } from "@/app/_components/DashboardShell";
import { shortTime, timeAgo } from "@/app/_components/format";
import { IncidentDetectButton, IncidentControls } from "./IncidentControls";

type Incident = {
  id: number;
  title: string;
  status: string;
  reason: string | null;
  confidence: number | null;
  started_at: number;
};

export default async function IncidentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  let incidents: Incident[] = [];
  let loadError: string | null = null;
  try {
    incidents = (await coreIncidents(id)) as Incident[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Incidents are unavailable.";
  }

  return (
    <>
      <PageHeader
        title="Incidents"
        description="A candidate never notifies anyone. Confirm one, then post the announcement yourself."
        actions={<IncidentDetectButton programId={id} />}
      />

      {loadError ? (
        <CoreError message={loadError} />
      ) : incidents.length === 0 ? (
        <EmptyState title="No incidents." hint="A burst of similar tickets surfaces here as a candidate for you to confirm." />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {incidents.map((inc) => (
            <li key={inc.id}>
              <Link href={`/programs/${id}/incidents/${inc.id}`} className="group grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text group-hover:text-brand">
                    <span className="font-mono text-xs text-text-muted">#{inc.id}</span> {inc.title}
                  </p>
                  {inc.reason && <p className="mt-0.5 truncate text-xs text-text-muted">{inc.reason}</p>}
                </div>
                <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-0.5">
                  <StatusDot status={inc.status}>{inc.status}</StatusDot>
                  <span className="font-mono text-xs text-text-muted">{timeAgo(inc.started_at)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

type IncidentDetail = {
  incident: Incident & { description?: string | null; public_message?: string | null; declared_at?: number; resolved_at?: number | null };
  updates?: Array<{ id: number; body: string; created_at: number }>;
  tickets: Array<{ id: number; question: string; status: string }>;
};

export async function IncidentDetailSection({ programId, incidentId }: { programId: string; incidentId: number }) {
  const detail = (await coreIncidentDetail(incidentId)) as IncidentDetail;
  const affected = await coreIncidentAffected(incidentId).catch(() => null);
  const inc = detail.incident;

  // The support-signal timeline for an incident: declared → updates → resolved.
  const events: Array<{ label: string; at: number | null | undefined; body?: string; tone?: string }> = [
    { label: "Declared", at: inc.declared_at ?? inc.started_at, tone: "brand" },
    ...(detail.updates ?? []).map((u) => ({ label: "Update", at: u.created_at, body: u.body })),
    ...(inc.resolved_at ? [{ label: "Resolved", at: inc.resolved_at, tone: "mint" }] : []),
  ];

  return (
    <div className="space-y-10">
      <div>
        <p className="mb-4 font-mono text-xs text-text-muted">
          <Link href={`/programs/${programId}/incidents`} className="hover:text-text">
            Incidents
          </Link>
          <span className="px-1.5 text-text-muted/50">/</span>#{inc.id}
        </p>
        <StatusDot status={inc.status}>{inc.status}</StatusDot>
        <h1 className="font-heading mt-2 text-xl text-text">{inc.title}</h1>
        {(inc.reason || inc.description) && (
          <p className="mt-2 max-w-prose text-sm text-text-muted">{inc.description || inc.reason}</p>
        )}
        {inc.public_message && (
          <p className="mt-3 border-l-2 border-line pl-3 text-sm text-text-muted">
            Pixie tells askers: &ldquo;{inc.public_message}&rdquo;
          </p>
        )}
        {affected && affected.total > 0 && (
          <p className="mt-2 font-mono text-xs text-text-muted">
            {affected.total} affected thread{affected.total === 1 ? "" : "s"} tracked
            {affected.unnotified > 0 ? ` · ${affected.unnotified} can still be notified` : " · all notified"}
          </p>
        )}
      </div>

      <IncidentControls programId={programId} incidentId={inc.id} status={inc.status} />

      <Section title="Timeline">
        <ol>
          {events.map((e, i) => (
            <li key={i} className="grid grid-cols-[1.5rem_1fr] gap-x-3">
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1 size-2 rounded-full ${e.tone === "brand" ? "bg-brand" : e.tone === "mint" ? "bg-mint" : "bg-text-muted"}`}
                  aria-hidden
                />
                {i < events.length - 1 && <span className="w-px flex-1 bg-line" aria-hidden />}
              </div>
              <div className="pb-5">
                <p className="text-sm text-text">
                  {e.label} <span className="font-mono text-xs text-text-muted">{shortTime(e.at)}</span>
                </p>
                {e.body && <p className="mt-1 text-sm text-text-muted">{e.body}</p>}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={`Linked tickets · ${detail.tickets.length}`}>
        {detail.tickets.length === 0 ? (
          <EmptyState title="No tickets linked." />
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {detail.tickets.map((t) => (
              <li key={t.id} className="py-2">
                <Link href={`/programs/${programId}/tickets/${t.id}`} className="group flex items-baseline gap-3 text-sm">
                  <span className="font-mono text-xs text-text-muted">#{t.id}</span>
                  <span className="min-w-0 flex-1 truncate text-text group-hover:text-brand">{t.question}</span>
                  <StatusDot status={t.status}>{t.status.replace(/_/g, " ")}</StatusDot>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
