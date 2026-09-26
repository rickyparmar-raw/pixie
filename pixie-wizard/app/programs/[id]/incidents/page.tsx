import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreIncidents, coreIncidentDetail, coreIncidentAffected } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError, StatusBadge, StatusDot, EmptyState, Notice } from "@/app/_components/DashboardShell";
import { shortTime, timeAgo } from "@/app/_components/format";
import { IconChevronRight, IconChat } from "@/app/_components/icons";
import { IncidentDetectButton, IncidentControls, ManualIncidentForm } from "./IncidentControls";

type Incident = {
  id: number;
  title: string;
  status: string;
  reason: string | null;
  confidence: number | null;
  started_at: number;
  // Core does not send a severity today; when it does, the row shows the word
  // next to its marker. Nothing here invents one.
  severity?: string | null;
};

// Two colours for an incident, and neither of them is invented here.
//
// The severity marker: one square (never a round dot) whose tone is the
// severity Core reports, or the state the incident is actually in when it
// reports none. `word` is only set when Core really sent a severity, so the
// row never prints one the data doesn't have.
function severityOf(inc: Incident): { fill: string; text: string; word: string | null } {
  const raw = (inc.severity ?? "").trim().toUpperCase();
  if (raw === "CRITICAL" || raw === "HIGH") return { fill: "bg-danger", text: "text-danger", word: raw };
  if (raw === "MEDIUM") return { fill: "bg-tang", text: "text-tang", word: raw };
  if (raw) return { fill: "bg-text-muted", text: "text-text-muted", word: raw };
  if (inc.status === "confirmed") return { fill: "bg-danger", text: "text-danger", word: null };
  if (inc.status === "candidate") return { fill: "bg-tang", text: "text-tang", word: null };
  if (inc.status === "resolved") return { fill: "bg-mint", text: "text-mint", word: null };
  return { fill: "bg-text-muted", text: "text-text-muted", word: null };
}

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

  // The one incident of record, if there is one. It gets the danger header —
  // an open incident is the only state on this page that is actively bad.
  const open = incidents.find((inc) => inc.status === "confirmed") ?? null;

  return (
    <>
      <PageHeader
        title="Incidents"
        description="A candidate never notifies anyone. Confirm one, then post the announcement yourself."
        actions={<IncidentDetectButton programId={id} />}
      />

      {loadError ? (
        <CoreError message={loadError} />
      ) : (
        <div className="space-y-6">
          <ManualIncidentForm programId={id} />
          {open && (
            <Notice tone="error" title={`Open incident · #${open.id}`}>
              <p>
                <span className="text-text">{open.title}</span>
                {open.reason ? ` — ${open.reason}` : ""} · started {timeAgo(open.started_at)}
              </p>
              <Link
                href={`/programs/${id}/incidents/${open.id}`}
                className="pixie-button pixie-button-ghost pixie-button-sm mt-1 -ml-2 text-text"
              >
                <IconChevronRight size={16} />
                Open the incident
              </Link>
            </Notice>
          )}

          {incidents.length === 0 ? (
            <EmptyState
              title="No incidents."
              hint="A burst of similar tickets surfaces here as a candidate for you to confirm."
            />
          ) : (
            <ul className="pixie-panel divide-y divide-line">
              {incidents.map((inc) => {
                const sev = severityOf(inc);
                return (
                  <li key={inc.id}>
                    <Link
                      href={`/programs/${id}/incidents/${inc.id}`}
                      className="group flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-panel-2"
                    >
                      <span className={`mt-1.5 size-2 shrink-0 rounded-[1px] ${sev.fill}`} aria-hidden />
                      <span className="min-w-[12rem] flex-1">
                        <span className="block truncate text-sm text-text transition-colors group-hover:text-brand">
                          <span className="font-mono text-xs text-text-muted">#{inc.id}</span>
                          <span className="ml-2">{inc.title}</span>
                        </span>
                        {inc.reason && <span className="mt-0.5 block truncate text-xs text-text-muted">{inc.reason}</span>}
                      </span>
                      <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
                        {sev.word && (
                          <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${sev.text}`}>{sev.word}</span>
                        )}
                        <StatusBadge status={inc.status} />
                        <span className="font-mono text-xs tabular-nums text-text-muted">{timeAgo(inc.started_at)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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
  const isOpen = inc.status === "confirmed";

  // The support-signal timeline for an incident: detected → updates → resolved.
  // A candidate was never declared, so its first node is the detection; the
  // declared node is danger while the incident is still open, tang once it is
  // history.
  const events: Array<{ label: string; at: number | null | undefined; body?: string; tone?: string }> = [
    {
      label: inc.declared_at ? "Declared" : "Detected",
      at: inc.declared_at ?? inc.started_at,
      tone: isOpen ? "danger" : "tang",
    },
    ...(detail.updates ?? []).map((u) => ({ label: "Update", at: u.created_at, body: u.body })),
    ...(inc.resolved_at ? [{ label: "Resolved", at: inc.resolved_at, tone: "mint" }] : []),
  ];

  const eventFill = (tone?: string) =>
    tone === "danger" ? "bg-danger" : tone === "tang" ? "bg-tang" : tone === "mint" ? "bg-mint" : "bg-text-muted";

  return (
    <div>
      <Link
        href={`/programs/${programId}/incidents`}
        className="pixie-button pixie-button-ghost pixie-button-sm -ml-3"
      >
        <IconChevronRight size={16} className="rotate-180" />
        Incidents
      </Link>

      <div className="mt-3">
        <PageHeader
          title={inc.title}
          description={inc.description || inc.reason || undefined}
          actions={
            /* The status word is coloured by the shared `StatusBadge`: a
               candidate is un-reviewed (tang), a confirmed incident is live and
               hurting (danger), a resolved one is mint, a dismissed one is grey.
               That is the table this page used to keep to itself, so the badge
               takes its tone from the one place every other status on the
               dashboard takes it from.
               Right-aligned against the title once the header puts it in a
               column of its own; on a phone the header drops the actions under
               the description, where right-aligning a short badge would leave it
               hanging in the middle of nowhere. */
            <div className="flex flex-col items-start gap-1.5 sm:items-end">
              <StatusBadge status={inc.status} />
              <span className="font-mono text-[11px] tabular-nums text-text-muted">started {timeAgo(inc.started_at)}</span>
            </div>
          }
        />
      </div>

      <div className="space-y-6">
        {isOpen && (
          <Notice tone="error" title="Open incident · this is the incident of record">
            <p>
              Questions that match it are answered with this incident&rsquo;s message instead of a normal answer, and
              every one of them is linked here. Resolve it when the fault is fixed, then notify the affected threads.
            </p>
          </Notice>
        )}

        {inc.public_message && (
          <div className="pixie-panel flex max-w-3xl items-start gap-3 p-4">
            <IconChat size={16} className="mt-0.5 shrink-0 text-text-muted" />
            <div className="min-w-0">
              <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
                <span className="pixie-mark" aria-hidden="true" />
                What Pixie tells askers
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-text">&ldquo;{inc.public_message}&rdquo;</p>
            </div>
          </div>
        )}

        {affected && affected.total > 0 && (
          <p className="font-mono text-xs text-text-muted">
            {affected.total} affected thread{affected.total === 1 ? "" : "s"} tracked
            {affected.unnotified > 0 ? (
              <>
                {" · "}
                <span className="text-tang">{affected.unnotified} can still be notified</span>
              </>
            ) : (
              " · all notified"
            )}
          </p>
        )}

        <IncidentControls programId={programId} incidentId={inc.id} status={inc.status} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <Section title="Timeline">
          <ol>
            {events.map((e, i) => (
              <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
                <div className="flex flex-col items-center">
                  <span className={`mt-1 size-2 shrink-0 rounded-[1px] ${eventFill(e.tone)}`} aria-hidden />
                  {i < events.length - 1 && <span className="w-px flex-1 bg-line" aria-hidden />}
                </div>
                <div className="pb-5">
                  <p className="text-sm text-text">
                    {e.label} <span className="font-mono text-xs tabular-nums text-text-muted">{shortTime(e.at)}</span>
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
                    <span className="min-w-0 flex-1 truncate text-text transition-colors group-hover:text-brand">{t.question}</span>
                    <StatusDot status={t.status}>{t.status.replace(/_/g, " ")}</StatusDot>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
