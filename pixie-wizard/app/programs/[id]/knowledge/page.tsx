import { requireProgramMembership } from "@/lib/programAccess";
import { coreKnowledgeCandidates } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError, EmptyState } from "@/app/_components/DashboardShell";
import { ProposeTicketForm, CandidateCard } from "./ReviewForms";
import type { DocSource } from "@/lib/types";

type Candidate = {
  id: number;
  question: string;
  answer: string;
  status: string;
  category: string | null;
  ticket_id: number | null;
  resolver_id: string | null;
  created_at: number;
};

const SOURCE_KIND: Record<string, string> = {
  url: "web page",
  "json-faq": "FAQ file",
  gdoc: "Google Doc",
  "github-dir": "GitHub docs",
  text: "text",
};

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { program } = await requireProgramMembership(id);

  let candidates: Candidate[] = [];
  let loadError: string | null = null;
  try {
    candidates = (await coreKnowledgeCandidates(id)) as Candidate[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "The review queue is unavailable.";
  }

  const sources: DocSource[] = Array.isArray(program.sources) ? program.sources : [];

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="What Pixie answers from, and the answers waiting for your approval."
      />

      <div className="space-y-12">
        <Section
          title="Sources"
          description={`${sources.length} feed${sources.length === 1 ? "" : "s"} the retrieval index. Edit these in Settings.`}
        >
          {sources.length === 0 ? (
            <EmptyState title="No sources yet." hint="Add docs, guidelines or an FAQ file in Settings." />
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {sources.map((s, i) => (
                <li key={`${s.url}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5">
                  <span className="text-sm text-text">{s.label || hostname(s.url)}</span>
                  <span className="font-mono text-xs text-text-muted">{SOURCE_KIND[s.type] ?? s.type}</span>
                  <span className="font-mono text-xs text-text-muted">{s.public ? "public" : "private"}</span>
                  <span className="w-full truncate font-mono text-[11px] text-text-muted/70">{s.url}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title={`Review queue${candidates.length ? ` · ${candidates.length}` : ""}`}
          description="Recurring questions your docs miss. Approve an answer and it grounds every future reply."
        >
          {loadError && <CoreError message={loadError} />}
          <div className="mt-1">
            <ProposeTicketForm programId={id} />
          </div>
          {candidates.length === 0 && !loadError ? (
            <div className="mt-6">
              <EmptyState title="Nothing waiting for review." hint="Pixie promotes a gap here once it keeps coming up." />
            </div>
          ) : (
            <div className="mt-6 space-y-8">
              {candidates.map((c) => (
                <CandidateCard key={c.id} programId={id} candidate={c} />
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
