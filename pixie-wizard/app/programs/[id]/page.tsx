import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getHostedProgram, listHostedChannels, listHostedAudit, getPublicProgramProfile, listVisibleHelperIdentityKeys } from "@/lib/hostedPrograms";
import { relationshipFor } from "@/lib/programAccess";
import { ProgramSettingsForms } from "./ProgramSettingsForms";
import { ChannelChangeForm } from "./ChannelChangeForm";
import { PublicProfile } from "./PublicProfile";
import { coreAnalytics, coreSlackChannels, coreUserInfo } from "@/lib/pixieCore";
import { PageHeader, SectionCard, MetricCard, StatusBadge } from "@/app/_components/DashboardShell";
import type { PublicHelperIdentity } from "@/lib/types";

export default async function ProgramPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const program = await getHostedProgram(id);
  if (!program) redirect("/programs");

  const relationship = await relationshipFor(program, session);

  // Non-member: safe read-only profile. getPublicProgramProfile() is a
  // column-allowlisted projection — there is no admin `program` object in
  // scope here to accidentally pass through.
  if (relationship === "public") {
    const profile = await getPublicProgramProfile(id);
    if (!profile) redirect("/programs");
    let helpChannelDisplay: string | null = null;
    if (profile.publicHelpChannelId) {
      try {
        const res = await coreSlackChannels();
        const match = res.ok ? res.channels.find((c) => c.id === profile.publicHelpChannelId) : null;
        helpChannelDisplay = match ? `#${match.name}` : profile.publicHelpChannelId;
      } catch {
        helpChannelDisplay = profile.publicHelpChannelId;
      }
    }

    // Identity resolution is best-effort and must never block the page: a
    // slow or unreachable Slack identity provider still has to show the
    // profile, just with role-only rows. Promise.allSettled + a per-lookup
    // try/catch means one failed resolution can't take the others down.
    const identityKeys = await listVisibleHelperIdentityKeys(id).catch(() => []);
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

  const [channels, audit] = await Promise.all([listHostedChannels(id), listHostedAudit(id, 20)]);
  let coreChannels: { id: string; name: string; isMember: boolean }[] = [];
  try {
    const res = await coreSlackChannels();
    if (res.ok) coreChannels = res.channels;
  } catch {
    coreChannels = [];
  }
  let analytics: Record<string, unknown> | null = null;
  try {
    analytics = await coreAnalytics(id, 30);
  } catch {
    analytics = null;
  }
  const byStatus = (analytics?.byStatus ?? {}) as Record<string, number>;
  const open = Object.entries(byStatus).filter(([status]) => status !== "resolved").reduce((sum, [, count]) => sum + count, 0);

  return (
    <main className="max-w-none px-0 py-0">
      <PageHeader eyebrow={`Hosted Pixie · ${program.status}`} title={program.program_name} description={`Support identity ${program.support_name ?? `${program.program_name} Help`} · Core sync ${program.core_sync_state}`} actions={<StatusBadge status={program.status === "active" && program.core_sync_state === "synced" ? "Healthy" : program.core_sync_state === "pending" ? "Sync pending" : program.core_sync_state === "failed" ? "Sync failed" : program.status} />} />
      {program.core_sync_state === "pending" && <p className="-mt-3 mb-5 text-sm text-text-muted">Activation saved. Pixie hasn&apos;t picked up this configuration yet — it syncs automatically within a few minutes.</p>}
      {program.core_sync_state === "failed" && program.core_sync_error && <p className="-mt-3 mb-5 text-sm text-brand">{program.core_sync_error}. Settings are saved and retry automatically.</p>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><MetricCard label="Questions" value={String(analytics?.created ?? "—")} tone="text-text" /><MetricCard label="AI answered" value={String(analytics?.aiAnswered ?? "—")} /><MetricCard label="Escalated" value={String(byStatus.escalated ?? "—")} tone="text-brand" /><MetricCard label="Open tickets" value={analytics ? open : "—"} tone="text-tang" /></div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href={`/programs/${id}/tickets`} className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim">
          Open tickets →
        </Link>
        {[
          ["knowledge", "Knowledge"],
          ["gaps", "FAQ gaps"],
          ["macros", "Macros"],
          ["helpers", "Helpers"],
          ["analytics", "Analytics"],
          ["incidents", "Incidents"],
          ["audit", "Audit"],
          ["retention", "Retention"],
        ].map(([slug, label]) => (
          <Link key={slug} href={`/programs/${id}/${slug}`} className="rounded-md border border-line px-4 py-2 font-heading text-sm text-text-muted hover:text-text">
            {label}
          </Link>
        ))}
      </div>

      <SectionCard title="Channels" description="Claimed support and organizer channels.">
        <ul className="mt-3 space-y-1 text-sm text-text">
          {channels.map((c) => (
            <li key={`${c.workspace_id}:${c.channel_id}`} className="font-mono">
              &lt;#{c.channel_id}&gt; <span className="font-sans text-text-muted">· {c.kind}</span>
            </li>
          ))}
          {channels.length === 0 && <li className="text-text-muted">No channels claimed yet.</li>}
        </ul>
        <ChannelChangeForm programId={id} channels={coreChannels} />
      </SectionCard>

      <div className="mt-6">
        <ProgramSettingsForms program={program} />
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel p-6">
        <h2 className="font-heading text-lg text-text">Recent activity</h2>
        <ul className="mt-3 space-y-2 text-sm text-text-muted">
          {(audit as Array<{ id: string; action: string; created_at: string }>).map((e) => (
            <li key={e.id}>
              <span className="text-text">{e.action}</span> · {new Date(e.created_at).toLocaleString()}
            </li>
          ))}
          {audit.length === 0 && <li>No activity yet.</li>}
        </ul>
      </div>
    </main>
  );
}
