import { redirect } from "next/navigation";
import Link from "next/link";
import { listHostedAudit, getPublicProgramProfile, listVisibleHelperIdentityKeys } from "@/lib/hostedPrograms";
import { loadProgramContext } from "@/lib/programAccess";
import { PublicProfile } from "./PublicProfile";
import { coreAnalytics, coreSlackChannels, coreUserInfo, coreRadarList } from "@/lib/pixieCore";
import { PageHeader, Section, MetricRow, StatusBadge, CoreError } from "@/app/_components/DashboardShell";
import type { PublicHelperIdentity } from "@/lib/types";

function healthLabel(status: string, sync: string): string {
  if (status === "active" && sync === "synced") return "Healthy";
  if (sync === "pending") return "Sync pending";
  if (sync === "failed") return "Sync failed";
  return status;
}

export default async function ProgramPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, program, relationship } = await loadProgramContext(id);
  if (!session) redirect("/");
  if (!program) redirect("/programs");

  // Non-member: safe read-only profile. getPublicProgramProfile() is a
  // column-allowlisted projection — there is no admin `program` object in
  // scope here to accidentally pass through.
  if (relationship === "public") {
    const profile = await getPublicProgramProfile(id);
    if (!profile) redirect("/programs");

    const [channelsRes, identityKeys] = await Promise.all([
      profile.publicHelpChannelId ? coreSlackChannels().catch(() => null) : Promise.resolve(null),
      listVisibleHelperIdentityKeys(id).catch(() => []),
    ]);

    let helpChannelDisplay: string | null = null;
    if (profile.publicHelpChannelId) {
      const match = channelsRes?.ok ? channelsRes.channels.find((c) => c.id === profile.publicHelpChannelId) : null;
      helpChannelDisplay = match ? `#${match.name}` : profile.publicHelpChannelId;
    }

    const roster: PublicHelperIdentity[] = (
      await Promise.allSettled(
        identityKeys.map(async ({ slackUserId, role }) => {
          try {
            const info = await coreUserInfo(slackUserId);
            return { role, displayName: info.ok ? info.displayName ?? null : null, avatarUrl: info.ok ? info.avatarUrl ?? null : null };
          } catch {
            return { role, displayName: null, avatarUrl: null };
          }
        }),
      )
    ).map((r, i) => (r.status === "fulfilled" ? r.value : { role: identityKeys[i].role, displayName: null, avatarUrl: null }));

    return <PublicProfile profile={profile} helpChannelDisplay={helpChannelDisplay} roster={roster} />;
  }

  // Overview answers: is support healthy, what needs attention, what happened.
  // Configuration lives in Settings. The audit read is required (throws →
  // error boundary); the two Core widgets degrade on their own.
  const [audit, coreData] = await Promise.all([
    listHostedAudit(id, 8),
    Promise.allSettled([coreAnalytics(id, 30), coreRadarList(id, { status: "active" })]),
  ]);
  const [analyticsR, radarR] = coreData;

  const analytics = analyticsR.status === "fulfilled" ? (analyticsR.value as Record<string, unknown>) : null;
  const coreDown = analyticsR.status === "rejected";
  const byStatus = (analytics?.byStatus ?? {}) as Record<string, number>;
  const openTickets = Object.entries(byStatus)
    .filter(([status]) => status !== "resolved")
    .reduce((sum, [, count]) => sum + count, 0);

  let attention = { critical: 0, high: 0, medium: 0, total: 0 };
  if (radarR.status === "fulfilled") {
    const signals = (radarR.value.signals ?? []) as Array<{ severity: string }>;
    attention = {
      critical: signals.filter((s) => s.severity === "CRITICAL").length,
      high: signals.filter((s) => s.severity === "HIGH").length,
      medium: signals.filter((s) => s.severity === "MEDIUM").length,
      total: signals.length,
    };
  }
  const attentionDetail = [
    attention.critical && `${attention.critical} critical`,
    attention.high && `${attention.high} high`,
    attention.medium && `${attention.medium} medium`,
  ]
    .filter(Boolean)
    .join(", ");

  const events = audit as Array<{ id: string; action: string; created_at: string }>;

  return (
    <>
      <PageHeader
        title={program.program_name}
        description={`${program.support_name ?? `${program.program_name} Help`} · answering as ${program.posture}`}
        actions={<StatusBadge status={healthLabel(program.status, program.core_sync_state)} />}
      />

      {program.core_sync_state === "pending" && (
        <p className="mb-8 border-l-2 border-line pl-3 text-sm text-text-muted">
          Activation saved. Pixie picks up this configuration within a few minutes.
        </p>
      )}
      {program.core_sync_state === "failed" && program.core_sync_error && (
        <p className="mb-8 border-l-2 border-brand/60 pl-3 text-sm text-text-muted">
          {program.core_sync_error}. Settings are saved and retry automatically.
        </p>
      )}

      <div className="space-y-12">
        <Section title="Needs attention">
          <Link
            href={`/programs/${id}/radar`}
            className="flex items-baseline justify-between gap-4 text-sm hover:text-text"
          >
            <span className="text-text">
              {attention.total === 0 ? "Nothing flagged" : `${attention.total} open signal${attention.total === 1 ? "" : "s"}`}
              {attentionDetail && <span className="text-text-muted"> · {attentionDetail}</span>}
            </span>
            <span className="text-xs text-text-muted">Support radar →</span>
          </Link>
        </Section>

        <Section title="Last 30 days" actions={<Link href={`/programs/${id}/analytics`} className="text-xs text-text-muted hover:text-text">Analytics →</Link>}>
          {coreDown ? (
            <CoreError message="Metrics are unavailable right now." />
          ) : (
            <div className="max-w-sm">
              <MetricRow label="Questions" value={String(analytics?.created ?? "—")} />
              <MetricRow label="AI answered" value={String(analytics?.aiAnswered ?? "—")} />
              <MetricRow label="Escalated" value={String(byStatus.escalated ?? "—")} tone="text-brand" />
              <MetricRow label="Open tickets" value={analytics ? openTickets : "—"} tone="text-tang" />
            </div>
          )}
        </Section>

        <Section title="Recent activity" actions={<Link href={`/programs/${id}/audit`} className="text-xs text-text-muted hover:text-text">Audit →</Link>}>
          <ul className="space-y-2 text-sm text-text-muted">
            {events.map((e) => (
              <li key={e.id}>
                <span className="text-text">{e.action}</span>
                <span className="ml-2">{new Date(e.created_at).toLocaleString()}</span>
              </li>
            ))}
            {events.length === 0 && <li>No activity yet.</li>}
          </ul>
        </Section>

        <p className="border-t border-line pt-6 text-sm text-text-muted">
          Behavior, knowledge sources and channels are in{" "}
          <Link href={`/programs/${id}/settings`} className="text-text hover:text-brand">Settings</Link>.
        </p>
      </div>
    </>
  );
}
