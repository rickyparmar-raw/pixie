import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreKnowledgeCandidates, coreKnowledgeStatus, type KnowledgeSourceStatus } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, Section, CoreError, EmptyState, StatusDot } from "@/app/_components/DashboardShell";
import { shortTime } from "@/app/_components/format";
import { ProposeTicketForm, CandidateCard, RefreshSourcesButton, type Fact } from "./ReviewForms";
import type { DocSource } from "@/lib/types";

const SOURCE_KIND: Record<string, string> = {
  url: "web page",
  "json-faq": "FAQ file",
  gdoc: "Google Doc",
  "github-dir": "GitHub docs",
  text: "text",
};

const FACT_TABS: Array<[value: string, label: string]> = [
  ["candidate", "Needs review"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
];

export default async function KnowledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { program } = await requireProgramMembership(id);
  const tab = query.tab === "approved" || query.tab === "rejected" ? query.tab : "candidate";

  let facts: Fact[] = [];
  let loadError: string | null = null;
  try {
    facts = (await coreKnowledgeCandidates(id, tab)) as Fact[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "The review queue is unavailable.";
  }

  let sourceStatus: KnowledgeSourceStatus[] | null = null;
  let statusError: string | null = null;
  try {
    sourceStatus = (await coreKnowledgeStatus(id)).sources;
  } catch (err) {
    statusError = err instanceof Error ? err.message : "Source status is unavailable.";
  }

  const configured: DocSource[] = Array.isArray(program.sources) ? program.sources : [];
  const identities = await resolveIdentities(facts.map((f) => f.author_id));

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="What Pixie answers from, and the answers waiting for your approval."
      />

      <div className="space-y-12">
        <Section
          title="Sources"
          description="Sync state per feed. Re-sync re-fetches every source in the background."
          actions={<RefreshSourcesButton programId={id} />}
        >
          {statusError && <CoreError message={statusError} />}
          {sourceStatus === null && !statusError ? (
            <EmptyState title="Source status is unavailable." hint="Core may predate the status endpoint." />
          ) : (sourceStatus ?? []).length === 0 ? (
            configured.length === 0 ? (
              <EmptyState title="No sources yet." hint="Add docs, guidelines or an FAQ file in Settings." />
            ) : (
              // Core without per-source status: fall back to the declared
              // config so the page still shows what feeds the index.
              <ul className="divide-y divide-line border-y border-line">
                {configured.map((s, i) => (
                  <li key={`${s.url}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5">
                    <span className="text-sm text-text">{s.label || hostname(s.url)}</span>
                    <span className="font-mono text-xs text-text-muted">{SOURCE_KIND[s.type] ?? s.type}</span>
                    <span className="font-mono text-xs text-text-muted">{s.public ? "public" : "private"}</span>
                    <span className="w-full truncate font-mono text-[11px] text-text-muted/70">{s.url}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {(sourceStatus ?? []).map((s) => (
                <li key={s.name} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text">{s.name}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted/70">
                      {[SOURCE_KIND[s.type ?? ""] ?? s.type, s.url].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-text-muted/70">
                      {s.lastSyncedAt ? `synced ${shortTime(s.lastSyncedAt)}` : "never synced"}
                      {s.lastSuccessAt ? ` · last good ${shortTime(s.lastSuccessAt)}` : ""}
                      {s.chunks !== null ? ` · ${s.chunks} chunks` : ""}
                    </p>
                    {s.error && <p className="mt-0.5 truncate text-xs text-brand">{s.error}</p>}
                  </div>
                  <StatusDot status={s.status}>{s.status}</StatusDot>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title={`Learned facts${facts.length ? ` · ${facts.length}` : ""}`}
          description="Recurring questions your docs miss. Approve an answer and it grounds every future reply; retire one and Pixie stops answering from it."
        >
          <nav className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {FACT_TABS.map(([value, label]) => {
              const active = tab === value;
              return (
                <Link
                  key={value}
                  href={value === "candidate" ? "?" : `?tab=${value}`}
                  aria-current={active ? "page" : undefined}
                  className={`border-b-2 pb-1 transition-colors ${
                    active ? "border-brand text-text" : "border-transparent text-text-muted hover:text-text"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
          {loadError && <CoreError message={loadError} />}
          {tab === "candidate" && (
            <div className="mt-1">
              <ProposeTicketForm programId={id} />
            </div>
          )}
          {facts.length === 0 && !loadError ? (
            <div className="mt-6">
              <EmptyState
                title={tab === "candidate" ? "Nothing waiting for review." : `No ${tab} facts.`}
                hint={tab === "candidate" ? "Pixie promotes a gap here once it keeps coming up." : undefined}
              />
            </div>
          ) : (
            <div className="mt-6 space-y-8">
              {facts.map((c) => (
                <CandidateCard
                  key={c.id}
                  programId={id}
                  candidate={c}
                  authorLabel={c.author_id ? labelFor(identities, c.author_id) : undefined}
                  createdLabel={shortTime(c.created_at)}
                />
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function hostname(url: string | undefined): string {
  if (!url) return "source";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
