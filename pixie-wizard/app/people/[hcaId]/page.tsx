import Link from "next/link";
import { requireWizardSuperadmin } from "@/lib/programAccess";
import { getWizardPerson, listProgramAccessForPerson, hasPersistedWizardSuperadmin, isBootstrapSuperadmin } from "@/lib/hostedPrograms";
import { DashboardShell, PageHeader, Section, Chip, EmptyState, Notice, StatusBadge } from "@/app/_components/DashboardShell";
import { IconArrowRight } from "@/app/_components/icons";
import { SuperadminActions } from "./SuperadminActions";
import type { HostedProgramRow } from "@/lib/types";

// The state word for a program, in the order the failures win — the same rule
// the directory card and the workspace table use. Kept local so this page owns
// its own states; see app/programs/page.tsx.
function programState(program: HostedProgramRow): string {
  if (program.core_sync_state === "failed") return "Sync failed";
  if (program.core_sync_state === "pending") return "Sync pending";
  if (program.status !== "active") return program.status;
  if (program.posture === "muted" || !program.ai_answers) return "Paused";
  return "Healthy";
}

const ROLE_LABEL: Record<string, string> = { helper: "Helper", organizer: "Organizer", owner: "Owner" };

export default async function PersonPage({ params }: { params: Promise<{ hcaId: string }> }) {
  await requireWizardSuperadmin();
  const { hcaId } = await params;
  const person = await getWizardPerson(decodeURIComponent(hcaId));
  if (!person) {
    return (
      <DashboardShell crumb="People">
        <PageHeader
          title="Person not found"
          description="Nothing in the directory matches this account id."
        />
        <div className="max-w-3xl space-y-5">
          <EmptyState
            title="No directory record for this account."
            hint="Check the account id, or add the person from People & access."
          />
          {/* The sidebar has the directory, but a page that dead-ends is a page
              with nowhere to go: this is the way back. */}
          <Link href="/people" className="pixie-button pixie-button-quiet pixie-button-sm">
            People &amp; access
            <IconArrowRight size={16} />
          </Link>
        </div>
      </DashboardShell>
    );
  }
  const access = await listProgramAccessForPerson(person.hca_id);
  const persistedSuperadmin = await hasPersistedWizardSuperadmin(person.hca_id);
  const bootstrapSuperadmin = isBootstrapSuperadmin(person.hca_id);
  const isSuperadmin = persistedSuperadmin || bootstrapSuperadmin;
  const initial = person.display_name.slice(0, 1).toUpperCase();

  return (
    <DashboardShell crumb="People">
      {/* The header and the record share one measure, so the avatar lands on the
          header's right edge instead of floating off by itself. */}
      <div className="max-w-4xl">
        <PageHeader
          title={person.display_name}
          description="Identity, global access and program-scoped access."
          actions={
            <span className="grid size-10 place-items-center rounded-[2px] bg-lime font-display text-[16px] leading-none text-lime-ink">
              {initial}
            </span>
          }
        />

        <div className="space-y-8">
          <Section bordered title="Identity">
            <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <div className="min-w-0">
                <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Account</dt>
                <dd className="mt-1.5 truncate text-[13px] text-text">{person.email}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">HCA ID</dt>
                <dd className="mt-1.5 break-all font-mono text-[13px] text-text">{person.hca_id}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Slack</dt>
                <dd className="mt-1.5 truncate font-mono text-[13px] text-text">
                  {person.slack_user_id ? `@${person.slack_user_id}` : <span className="text-text-muted">Not linked</span>}
                </dd>
              </div>
              {/* An invite that has not come back, and a leaver, are the two
                  states this page exists to tell apart — so the record says
                  which one this is, in the directory's own colours. */}
              <div className="min-w-0">
                <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Status</dt>
                <dd className="mt-1.5">
                  <StatusBadge status={person.status} />
                </dd>
              </div>
            </dl>
            {/* A fifth field would be an orphan on its own row, so the date the
                record arrived rides under the four as a footnote. */}
            <p className="mt-5 border-t border-line pt-3.5 text-[12px] text-text-muted">
              Added{" "}
              <span className="font-mono text-text">
                {new Date(person.added_at).toLocaleDateString([], {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </p>
          </Section>

          <Section bordered title="Global access">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[13px] text-text">Superadmin</span>
              {isSuperadmin ? <Chip tone="lime">Yes</Chip> : <Chip>No</Chip>}
            </div>

            {bootstrapSuperadmin && (
              <div className="mt-4">
                <Notice tone="warn" title="Granted by deployment configuration.">
                  Remove this account from PIXIE_WIZARD_SUPERADMIN_ALLOWLIST before revocation can take effect.
                </Notice>
              </div>
            )}

            {persistedSuperadmin && !bootstrapSuperadmin && (
              <div className="mt-5 border-t border-line pt-5">
                <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
                  <span className="pixie-mark bg-danger" aria-hidden="true" />
                  Danger zone
                </p>
                <p className="mt-2.5 max-w-[60ch] text-[13px] text-text-muted">
                  Revoking removes this account from every program directory and from the workspace pages behind
                  People &amp; access. The programs themselves are not touched.
                </p>
                <SuperadminActions hcaId={person.hca_id} />
              </div>
            )}
          </Section>

          <Section bordered title="Program access">
            {access.length ? (
              <ul className="divide-y divide-line">
                {access.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text">{row.program_name}</span>
                    {/* The program's own state, so access to a program that is
                        paused or out of sync reads as it is. */}
                    <StatusBadge status={programState(row)} />
                    <Chip>{ROLE_LABEL[row.role] ?? row.role}</Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No active program access."
                hint="Grant a program from People & access to put this person to work."
              />
            )}
          </Section>
        </div>
      </div>
    </DashboardShell>
  );
}
