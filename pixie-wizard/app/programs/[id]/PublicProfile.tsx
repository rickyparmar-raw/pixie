import Link from "next/link";
import type { PublicProgramProfile, PublicHelperIdentity } from "@/lib/types";
import { PageHeader, Section, Chip, EmptyState, Notice, StatusBadge } from "@/app/_components/DashboardShell";
import { IconArrowRight } from "@/app/_components/icons";

const ROLE_LABEL: Record<"owner" | "organizer" | "helper", string> = {
  owner: "Owner",
  organizer: "Admin",
  helper: "Helper",
};

// Read-only view for anyone who isn't a member of this program. Every value
// comes from getPublicProgramProfile()'s column-allowlisted SELECT — there is
// no admin object in scope. Deliberately shell-less: a non-member must never
// see a nav bar offering Tickets/Audit/Settings links that would just
// redirect them right back here. It still sits on Pixie's night ground, with
// the same masked horizon art behind it, so a public profile looks like the
// same product as the pages behind the sign-in.
export function PublicProfile({
  profile,
  helpChannelDisplay,
  roster,
}: {
  profile: PublicProgramProfile;
  helpChannelDisplay: string | null;
  roster: PublicHelperIdentity[];
}) {
  return (
    <div className="pixie-night min-h-screen bg-ink text-text">
      <div className="pixie-night-art" aria-hidden="true">
        <img src="/pixie-night-background.png" alt="" width={1672} height={940} />
      </div>

      <main className="relative z-10 mx-auto min-h-screen w-full max-w-2xl px-6 py-12 lg:px-10">
        <Link
          href="/programs"
          className="pixie-button pixie-button-quiet pixie-button-sm"
        >
          <IconArrowRight size={16} className="rotate-180" />
          All programs
        </Link>

        <PageHeader
          eyebrow="Public profile"
          title={profile.programName}
          description={profile.supportName ? `Answers as ${profile.supportName}` : undefined}
          actions={
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-[2px] bg-lime/15 font-display text-[16px] leading-none text-lime">
                {profile.programName.slice(0, 2).toUpperCase()}
              </span>
              <StatusBadge status={profile.status === "active" ? "Active" : profile.status} />
            </div>
          }
        />

        <div className="space-y-8">
          {profile.description ? (
            <p className="text-sm leading-relaxed text-text-muted">{profile.description}</p>
          ) : (
            <EmptyState
              title="No description for this program yet."
              hint="The owner hasn't published one."
            />
          )}

          <Section bordered title="At a glance">
            <dl className="divide-y divide-line">
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-[13px] text-text-muted">Help channel</dt>
                <dd className="min-w-0 truncate text-right font-mono text-[13px] text-text">
                  {helpChannelDisplay ?? <span className="text-text-muted">Not public</span>}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-[13px] text-text-muted">Public knowledge sources</dt>
                <dd className="font-mono text-[13px] tabular-nums text-text">{profile.publicSourceCount}</dd>
              </div>
            </dl>
          </Section>

          <Section title="Support roster">
            {roster.length === 0 ? (
              <EmptyState
                title="No public roster for this program."
                hint="Support names are only shown when the owner publishes them."
              />
            ) : (
              <ul className="divide-y divide-line">
                {roster.map((entry, i) => (
                  <li key={i} className="flex items-center gap-2.5 py-2.5">
                    {entry.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external Slack CDN avatar, not a local asset
                      <img src={entry.avatarUrl} alt="" className="size-6 shrink-0 rounded-[2px] object-cover" />
                    ) : (
                      <span className="grid size-6 shrink-0 place-items-center rounded-[2px] bg-panel-2 font-mono text-[10px] leading-none text-text-muted">
                        {ROLE_LABEL[entry.role].slice(0, 1)}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-[13px] text-text">
                      {entry.displayName ?? ROLE_LABEL[entry.role]}
                    </span>
                    {entry.displayName && <Chip>{ROLE_LABEL[entry.role]}</Chip>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Notice tone="info">
            You&apos;re viewing the public profile. Only members can manage this program.
          </Notice>
        </div>
      </main>
    </div>
  );
}
