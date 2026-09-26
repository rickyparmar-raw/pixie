import { requireProgramMembership } from "@/lib/programAccess";
import { coreMacrosList, coreMacroTemplates, coreMacrosWaiting } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError, EmptyState } from "@/app/_components/DashboardShell";
import { MacroCreateForm, MacroRowCard, BulkMacroSendForm, MacroTemplateCard, type MacroRow, type MacroTemplate } from "./MacroForms";

export default async function MacrosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session } = await requireProgramMembership(id);

  let macros: MacroRow[] = [];
  let loadError: string | null = null;
  try {
    macros = (await coreMacrosList(id)) as MacroRow[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "Could not load macros.";
  }
  let templates: MacroTemplate[] = [];
  let waitingCount = 0;
  // Templates and the waiting queue are helper reads in Core, keyed on the
  // linked Slack identity; an unlinked account simply doesn't get them.
  if (session.slackId) {
    try { templates = (await coreMacroTemplates(id, session.slackId)).templates as MacroTemplate[]; } catch {}
    try { waitingCount = (await coreMacrosWaiting(id, session.slackId)).count; } catch {}
  }

  return (
    <>
      <PageHeader
        title="Macros"
        description="Saved replies a helper can send from a ticket. Placeholders fill in on send, including live queue context."
      />

      {loadError && <CoreError message={loadError} />}

      <div className="space-y-8">
        {templates.length > 0 && <Section title="Suggested templates" description="Start with an approved reply, then edit it in your saved replies."><div className="grid gap-4 sm:grid-cols-2">{templates.map((template) => <MacroTemplateCard key={template.trigger} programId={id} template={template} />)}</div></Section>}
        <MacroCreateForm programId={id} />
        {waitingCount > 0 && <BulkMacroSendForm programId={id} macros={macros.filter((m) => m.enabled)} waitingCount={waitingCount} />}

        {(macros.length > 0 || !loadError) && (
          <Section
            title="Saved replies"
            actions={
              <span className="font-mono text-xs tabular-nums text-text-muted">{macros.length}</span>
            }
          >
            {macros.length === 0 ? (
              <EmptyState
                title="No macros yet."
                hint="Create one above and a helper can send it straight from a ticket."
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {macros.map((m) => (
                  <MacroRowCard key={m.id} programId={id} macro={m} />
                ))}
              </div>
            )}
          </Section>
        )}
      </div>
    </>
  );
}
