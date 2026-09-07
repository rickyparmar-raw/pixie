import Link from "next/link";
import type { PublicProgramProfile, PublicHelperIdentity } from "@/lib/types";
import { StatusBadge } from "@/app/_components/DashboardShell";

const ROLE_LABEL: Record<"owner" | "organizer" | "helper", string> = {
  owner: "Owner",
  organizer: "Admin",
  helper: "Helper",
};

// Read-only view for anyone who isn't a member of this program. Every value
// rendered here comes from getPublicProgramProfile()'s column-allowlisted
// SELECT — there is no admin object in scope to accidentally leak a field
// from. Deliberately its own simple shell, not DashboardShell: a non-member
// must never see a nav bar offering Tickets/Audit/Settings links that would
// just redirect them right back here.
export function PublicProfile({
  profile,
  helpChannelDisplay,
  roster,
}: {
  profile: PublicProgramProfile;
  helpChannelDisplay: string | null;
  // Identity-resolved where possible; a null displayName means resolution
  // failed or Slack had nothing to offer — rendered as a role-only row.
  roster: PublicHelperIdentity[];
}) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-6 py-16">
      <Link href="/programs" className="text-xs text-text-muted hover:text-text">
        ← All programs
      </Link>
      <div className="mt-6 flex items-start gap-4">
        <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-brand/70 text-lg text-ink">
          {profile.programName.slice(0, 2).toUpperCase()}
        </span>
        <div>
          <h1 className="font-heading text-2xl text-text">{profile.programName}</h1>
          {profile.supportName && <p className="mt-1 text-sm text-text-muted">Support identity: {profile.supportName}</p>}
        </div>
        <div className="ml-auto">
          <StatusBadge status={profile.status === "active" ? "Active" : profile.status} />
        </div>
      </div>

      {profile.description && <p className="mt-6 text-sm leading-relaxed text-text-muted">{profile.description}</p>}

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <div className="pixie-panel p-4">
          <p className="text-xs text-text-muted">Help channel</p>
          <p className="mt-2 text-sm text-text">{helpChannelDisplay ?? "Not public"}</p>
        </div>
        <div className="pixie-panel p-4">
          <p className="text-xs text-text-muted">Public knowledge sources</p>
          <p className="mt-2 text-sm text-text">{profile.publicSourceCount}</p>
        </div>
      </div>

      <div className="mt-8 pixie-panel p-5">
        <h2 className="text-sm text-text">Support roster</h2>
        {roster.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">No public roster for this program.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm text-text-muted">
            {roster.map((entry, i) => (
              <li key={i} className="flex items-center gap-2">
                {entry.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external Slack CDN avatar, not a local asset
                  <img src={entry.avatarUrl} alt="" className="size-6 rounded-full" />
                ) : (
                  <span className="grid size-6 place-items-center rounded-full bg-panel-2 text-[10px] text-text-muted">
                    {ROLE_LABEL[entry.role].slice(0, 1)}
                  </span>
                )}
                <span className="text-text">{entry.displayName ?? ROLE_LABEL[entry.role]}</span>
                {entry.displayName && <span className="text-text-muted">· {ROLE_LABEL[entry.role]}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-8 text-xs text-text-muted">You&apos;re viewing the public profile. Only members can manage this program.</p>
    </main>
  );
}
