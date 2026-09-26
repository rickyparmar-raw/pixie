import Link from "next/link";
import { listActiveHostedPrograms } from "@/lib/hostedPrograms";
import { relationshipFor, requireWizardSuperadmin } from "@/lib/programAccess";
import { DashboardShell, PageHeader, EmptyState, Notice, StatusBadge } from "@/app/_components/DashboardShell";
import { personaName } from "@/app/_components/format";
import { IconArrowRight } from "@/app/_components/icons";
import type { HostedProgramRow, ProgramRelationship } from "@/lib/types";

const RELATIONSHIP_LABEL: Record<ProgramRelationship, string> = {
  owner: "Owner",
  admin: "Admin",
  helper: "Helper",
  public: "",
};

const ACTION_LABEL: Record<ProgramRelationship, string> = {
  owner: "Manage",
  admin: "Open",
  helper: "Open",
  public: "View",
};

// The one honest state word for a card, and the order of it is the whole rule:
// a program whose configuration never reached Core is not "active", whatever
// its status column says, so a failed sync wins over everything. A muted
// posture is how the product actually pauses a program (`status` has no paused
// value, and a suspended program is not in this list at all), so it reads
// "Paused" — waiting on a person, tang, never lime.
function programState(program: HostedProgramRow): { label: string; error?: string | null } {
  if (program.core_sync_state === "failed") return { label: "Sync failed", error: program.core_sync_error };
  if (program.core_sync_state === "pending") return { label: "Sync pending" };
  if (program.status !== "active") return { label: program.status };
  if (program.posture === "muted" || !program.ai_answers) return { label: "Paused" };
  return { label: "Active" };
}

// The directory — superadmin-only. Everyone else only ever needs the one
// program they actually work on; see requireWizardSuperadmin.
export default async function ProgramsIndex() {
  const session = await requireWizardSuperadmin();

  const programs = await listActiveHostedPrograms().catch(() => []);
  const withRelationship = await Promise.all(
    programs.map(async (p) => ({ program: p, relationship: await relationshipFor(p, session) })),
  );
  // Your programs first (owner, then admin, then helper), each group by name;
  // programs you only have public access to fall to the bottom.
  const rank: Record<ProgramRelationship, number> = { owner: 0, admin: 1, helper: 2, public: 3 };
  withRelationship.sort(
    (a, b) => rank[a.relationship] - rank[b.relationship] || a.program.program_name.localeCompare(b.program.program_name),
  );

  // One honest line under the header, so the failure is on the page before you
  // reach the card that carries it. Same order as programState.
  const failed = withRelationship.filter(({ program }) => program.core_sync_state === "failed");

  return (
    <DashboardShell crumb="Programs">
      <PageHeader
        title="Programs"
        description="Every active hosted Pixie program. Membership only changes what you can manage."
      />

      {/* The same honest warning the program page shows, said once per broken
          program so the directory never looks healthier than the programs in
          it. The card below carries the same truth in one clipped line. */}
      {failed.length > 0 && (
        <div className="mb-6 space-y-3">
          {failed.map(({ program: broken }) => (
            <Notice
              key={broken.id}
              tone="error"
              title={`${broken.program_name} is out of sync with Pixie Core.`}
            >
              {broken.core_sync_error}. Settings are saved and retry automatically.
            </Notice>
          ))}
        </div>
      )}

      {withRelationship.length === 0 ? (
        <EmptyState
          title="No active hosted programs yet."
          hint="Run setup from New program to activate the first one."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {withRelationship.map(({ program: p, relationship }) => {
            const state = programState(p);
            return (
              <li key={p.id}>
                {/* One link per program, as before — the whole card is it, so the
                    old separate "Manage →" link is now the card's own affordance
                    rather than a second control pointing at the same place. */}
                <Link
                  href={`/programs/${p.id}`}
                  prefetch={false}
                  className="pixie-panel group flex h-full flex-col gap-3.5 border-line-strong p-4 transition-colors duration-[90ms] [transition-timing-function:steps(2,end)] hover:border-brand focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-[2px] bg-lime/15 font-display text-[14px] leading-none text-lime">
                      {p.program_name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold leading-tight text-text transition-colors group-hover:text-brand">
                        {p.program_name}
                      </p>
                      <p className="mt-1.5 truncate text-[12px] text-text-muted">
                        {RELATIONSHIP_LABEL[relationship] ? `${RELATIONSHIP_LABEL[relationship]} · ` : ""}
                        {personaName(p)} answers
                      </p>
                    </div>
                  </div>

                  <p className="line-clamp-3 min-h-[2.5rem] text-[13px] leading-relaxed text-text-muted">
                    {p.program_description ?? "No description"}
                  </p>

                  {/* The sync error, in full, clipped to two lines. A program that
                      failed to reach Core must never read as a healthy one. */}
                  {state.error && (
                    <p className="line-clamp-2 border-t border-line pt-3 text-[12px] leading-relaxed text-danger">
                      {state.error}
                    </p>
                  )}

                  <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-3">
                    <StatusBadge status={state.label} />
                    <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-muted transition-colors group-hover:text-brand">
                      {ACTION_LABEL[relationship]}
                      <IconArrowRight size={16} />
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardShell>
  );
}
