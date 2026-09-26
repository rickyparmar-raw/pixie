import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreKnowledgeCandidates, coreKnowledgeStatus, type KnowledgeSourceStatus } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, Section, CoreError, EmptyState, Notice, Chip } from "@/app/_components/DashboardShell";
import { IconAlert, IconArrowRight, IconBook, IconCheck, IconClock, IconDoc, IconGrid } from "@/app/_components/icons";
import {
  PixelIconNotion,
  PixelIconGitHub,
  PixelIconGoogleDoc,
  PixelIconMarkdown,
} from "@/app/_components/PixelIcons";
import { ProposeTicketForm, CandidateCard, RefreshSourcesButton, type Fact } from "./ReviewForms";
import type { DocSource } from "@/lib/types";

export default async function KnowledgePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const { program } = await requireProgramMembership(id);
  const tab = query.tab === "approved" || query.tab === "rejected" ? query.tab : "candidate";

  let candidates: Fact[] = [];
  let loadError: string | null = null;
  try {
    candidates = (await coreKnowledgeCandidates(id, tab)) as Fact[];
  } catch (err) {
    loadError = err instanceof Error ? err.message : "The review queue is unavailable.";
  }

  const sources: DocSource[] = Array.isArray(program.sources) ? program.sources : [];
  let sourceStatus: KnowledgeSourceStatus[] = [];
  try {
    sourceStatus = (await coreKnowledgeStatus(id)).sources;
  } catch {
    sourceStatus = [];
  }
  const identities = await resolveIdentities(candidates.map((candidate) => candidate.author_id));

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="What Pixie answers from, and the answers waiting for your approval."
      />

      <div className="space-y-8">
        <Section
          bordered
          title="Sources"
          /* No description when the list is empty: the empty state below is the
             whole message, and two sentences saying the same thing is noise. */
          description={
            sources.length === 0
              ? undefined
              : `The ${sources.length} ${sources.length === 1 ? "resource" : "resources"} Pixie reads to answer here.`
          }
          actions={<span className="flex flex-wrap gap-2"><RefreshSourcesButton programId={id} /><Link href={`/programs/${id}/settings`} className="pixie-button pixie-button-quiet shrink-0">Edit in Settings <IconArrowRight size={16} /></Link></span>}
        >
          {sources.length === 0 ? (
            <EmptyState title="No sources yet." hint="Add docs, guidelines or an FAQ file in Settings." />
          ) : (
            /* `grid-cols-1` on purpose: a bare `grid` gives the single implicit
               column an `auto` track, and the nowrap url line below then sets
               the column's max-content width and pushes the whole page into a
               horizontal scroll on a phone. */
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {sources.map((s, i) => (
                <SourceCard key={`${s.url ?? s.name ?? s.label ?? "source"}-${i}`} source={s} />
              ))}
            </ul>
          )}
          {sourceStatus.length > 0 && <p className="mt-4 border-t border-line pt-3 text-xs text-text-muted">{sourceStatus.filter((source) => source.status === "Ready").length} of {sourceStatus.length} sources synced.</p>}
        </Section>

        <Section
          bordered
          title={`Review queue${candidates.length ? ` · ${candidates.length}` : ""}`}
          description="Recurring questions your docs miss. Approve an answer and it grounds every future reply."
        >
          {loadError && <CoreError message={loadError} />}
          <ProposeTicketForm programId={id} />
          <nav className="mb-4 flex flex-wrap gap-x-4 text-sm">{([["candidate", "Needs review"], ["approved", "Approved"], ["rejected", "Rejected"]] as const).map(([value, label]) => <Link key={value} href={value === "candidate" ? "?" : `?tab=${value}`} className={`border-b-2 pb-1 ${tab === value ? "border-brand text-text" : "border-transparent text-text-muted"}`}>{label}</Link>)}</nav>
          {tab === "candidate" && <div className="mb-5"><ProposeTicketForm programId={id} /></div>}
          {candidates.length === 0 && !loadError ? (
            <div className="mt-4">
              <EmptyState title="Nothing waiting for review." hint="Pixie promotes a gap here once it keeps coming up." />
            </div>
          ) : (
            <div className="mt-4 space-y-3 border-t border-line pt-4">
              {candidates.map((c) => (
                <CandidateCard key={c.id} programId={id} candidate={c} authorLabel={c.author_id ? labelFor(identities, c.author_id) : undefined} createdLabel={c.created_at ? new Date(c.created_at).toLocaleDateString() : undefined} />
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  One knowledge source, drawn the way the onboarding Docs step draws it: a 32px */
/*  pixel mark for the kind, the name, the kind's own name under it, a state    */
/*  mark in the top-right corner, and everything else indented under the name   */
/*  so a column of cards lines up the way "What Pixie will know" does.          */
/* -------------------------------------------------------------------------- */

// The mark and the kind's name come from one place, so a card can never draw
// Notion's mark above the words "web page". `url` is the wizard's catch-all for
// "a linked page", so a Notion link is recognised by its host — exactly what
// the onboarding's own `SOURCE_KINDS.notion.host` does.
function sourceKind(source: DocSource): { mark: React.ReactNode; label: string } {
  switch (source.type) {
    case "gdoc":
      return { mark: <PixelIconGoogleDoc size={32} />, label: "Google Docs" };
    case "github-dir":
      return { mark: <PixelIconGitHub size={32} />, label: "GitHub" };
    case "text":
      return { mark: <PixelIconMarkdown size={32} />, label: "Markdown" };
    case "json-faq":
      return { mark: <IconBook size={32} />, label: "FAQ file" };
    case "pixl-shop":
      return { mark: <IconGrid size={32} />, label: "Pixie shop" };
    default:
      return isNotion(source.url)
        ? { mark: <PixelIconNotion size={32} />, label: "Notion" }
        : { mark: <IconDoc size={32} />, label: "Web page" };
  }
}

const STATE_TONE: Record<"mint" | "tang" | "danger", string> = {
  mint: "text-mint",
  tang: "text-tang",
  danger: "text-danger",
};

function SourceCard({ source }: { source: DocSource }) {
  const kind = sourceKind(source);
  const state = sourceState(source);
  const StateMark = state.tone === "mint" ? IconCheck : state.tone === "tang" ? IconClock : IconAlert;

  return (
    <li className="pixie-panel-raised min-w-0 p-4">
      <div className="flex items-start gap-5">
        <span className="grid size-8 shrink-0 place-items-center text-text">{kind.mark}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-[1.2] text-text">{sourceName(source)}</p>
          <p className="mt-[5px] text-[12.5px] leading-[1.28] text-text-muted">{kind.label}</p>
        </div>
        {/* The corner is the state, the way the onboarding's ready check is.
            The words are on the line below, so the sprite stays decorative. */}
        <span className={`mt-0.5 grid size-5 shrink-0 place-items-center ${STATE_TONE[state.tone]}`} aria-hidden>
          <StateMark size={16} />
        </span>
      </div>

      {/* 32px mark + 20px gap: the body sits under the name, as the onboarding's
          card bullets do. */}
      <div className="mt-3.5 min-w-0 sm:ml-[52px]">
        <p className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] font-medium ${STATE_TONE[state.tone]}`}>
          {state.label}
          <Chip>{source.public ? "public" : "private"}</Chip>
        </p>

        {state.tone === "danger" ? (
          /* A source Pixie cannot read at all is a real failure, so it keeps a
             real notice rather than a quiet tint. */
          <div className="mt-2.5">
            <Notice tone="error">{state.detail}</Notice>
          </div>
        ) : (
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">{state.detail}</p>
        )}

        {source.url ? (
          <p className="mt-1.5 truncate font-mono text-[11px] text-text-muted/70">{source.url}</p>
        ) : null}
      </div>
    </li>
  );
}

function isNotion(url: string | undefined): boolean {
  try {
    return url ? /(^|\.)notion\.(so|site)$/i.test(new URL(url).hostname) : false;
  } catch {
    return false;
  }
}

// What the dashboard can honestly say about a source. Pixie Core reads inline
// text straight out of the config and fetches a URL when it builds the corpus;
// it silently skips a source with neither. It reports no per-source sync state
// back, so the three states here are the three the engine itself can act on —
// never a "synced" claim the Core never made.
function sourceState(source: DocSource): { tone: "mint" | "tang" | "danger"; label: string; detail: string } {
  if (source.content !== undefined && source.content !== null) {
    return {
      tone: "mint",
      label: "In the index",
      detail: "The text travels with the program, so there is nothing to fetch.",
    };
  }
  if (source.url) {
    return {
      tone: "tang",
      label: "Reads on demand",
      detail: "Pixie fetches the link when it builds the corpus.",
    };
  }
  return {
    tone: "danger",
    label: "Nothing to read",
    detail: "This source has no link and no text, so Pixie skips it.",
  };
}

function sourceName(source: DocSource): string {
  return source.name || source.label || hostname(source.url) || "source";
}

function hostname(url: string | undefined): string {
  if (!url) return "source";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
