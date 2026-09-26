import { requireProgramMembership } from "@/lib/programAccess";
import { listHostedHelpers } from "@/lib/hostedPrograms";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { Chip, EmptyState, PageHeader, Section } from "@/app/_components/DashboardShell";
import { PersonGrantForm } from "@/app/people/PersonGrantForm";
import { PersonAccessActions } from "./PersonAccessActions";

// The onboarding's person tile: a 1px outlined square holding either a real
// Slack avatar (pixelated, so a photo can never soften the world) or the
// person's initial in the pixel face.
function PersonAvatar({ label, avatarUrl }: { label: string; avatarUrl: string | null }) {
  const initial = (label.startsWith("@") ? label.slice(1) : label).slice(0, 1).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-[2px] border border-line-strong bg-panel-2 font-display text-[14px] leading-none text-text"
    >
      {avatarUrl ? <img src={avatarUrl} alt="" className="pixel-art size-full object-cover" /> : initial}
    </span>
  );
}

export default async function ProgramPeoplePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { relationship } = await requireProgramMembership(id);
  const helpers = await listHostedHelpers(id);
  // One Core round trip for the whole roster; each row degrades to "@<id>" on
  // its own if Core is down or doesn't know the user.
  const identities = await resolveIdentities(helpers.map((h) => h.slack_user_id));

  return <>
    <PageHeader title="People" description="Program-scoped access. Visibility never changes permissions." />
    <div className="space-y-8">
      <Section
        title={`Roster${helpers.length ? ` · ${helpers.length}` : ""}`}
        description="Everyone with access to this program. The role on each row is the saved one; the control beside it is the change."
      >
        {helpers.length ? (
          <ul className="pixie-panel divide-y divide-line">
            {helpers.map((helper) => {
              const label = labelFor(identities, helper.slack_user_id);
              // Core's fallback label IS "@<id>", so an unknown person keeps
              // one line that says the id rather than two that repeat it.
              const named = label !== `@${helper.slack_user_id}`;
              return (
                <li key={helper.slack_user_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <PersonAvatar label={label} avatarUrl={identities.get(helper.slack_user_id)?.avatarUrl ?? null} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{label}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {named && <span className="font-mono text-xs text-text-muted">@{helper.slack_user_id}</span>}
                      <Chip>{helper.role}</Chip>
                    </span>
                  </span>
                  <PersonAccessActions programId={id} slackUserId={helper.slack_user_id} role={helper.role} />
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            title="No people assigned."
            hint="Grant someone access below and they can pick up tickets in this program."
          />
        )}
      </Section>
      {(relationship === "owner" || relationship === "admin") && (
        <Section
          title="Add person"
          description="Grants land on this program. Change or revoke someone's role from the roster above."
          bordered
        >
          <PersonGrantForm programId={id} />
        </Section>
      )}
    </div>
  </>;
}
