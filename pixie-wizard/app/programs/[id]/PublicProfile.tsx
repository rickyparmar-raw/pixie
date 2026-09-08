import Link from "next/link";
import type { PublicProgramProfile, PublicHelperIdentity } from "@/lib/types";
import { StatusBadge } from "@/app/_components/DashboardShell";

const ROLE_LABEL: Record<"owner" | "organizer" | "helper", string> = {
  owner: "Owner",
  organizer: "Admin",
  helper: "Helper",
};

// Read-only view for anyone who isn't a member of this program. Every value
// comes from getPublicProgramProfile()'s column-allowlisted SELECT — there is
// no admin object in scope. Deliberately shell-less: a non-member must never
// see a nav bar offering Tickets/Audit/Settings links that would just
// redirect them right back here.
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
    <main className="mx-auto min-h-screen max-w-xl px-6 py-16">
      <Link href="/programs" className="text-xs text-text-muted hover:text-text">← All programs</Link>

      <div className="mt-8 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-panel-2 text-xs text-text-muted">
          {profile.programName.slice(0, 2).toUpperCase()}
        </span>
        <div>
          <h1 className="font-heading text-xl text-text">{profile.programName}</h1>
          {profile.supportName && <p className="mt-0.5 text-sm text-text-muted">Answers as {profile.supportName}</p>}
        </div>
        <div className="ml-auto">
          <StatusBadge status={profile.status === "active" ? "Active" : profile.status} />
        </div>
      </div>

      {profile.description && <p className="mt-6 text-sm leading-relaxed text-text-muted">{profile.description}</p>}

      <dl className="mt-10 space-y-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-text-muted">Help channel</dt>
          <dd className="text-text">{helpChannelDisplay ?? "Not public"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-text-muted">Public knowledge sources</dt>
          <dd className="tabular-nums text-text">{profile.publicSourceCount}</dd>
        </div>
      </dl>

      <div className="mt-10">
        <h2 className="text-sm font-medium text-text">Support roster</h2>
        {roster.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">No public roster for this program.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
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

      <p className="mt-12 border-t border-line pt-6 text-xs text-text-muted">
        You&apos;re viewing the public profile. Only members can manage this program.
      </p>
    </main>
  );
}
