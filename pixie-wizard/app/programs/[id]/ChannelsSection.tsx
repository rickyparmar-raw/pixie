import { listHostedChannels } from "@/lib/hostedPrograms";
import { workspaceSlackChannels } from "@/lib/coreChannels";
import { ChannelChangeForm } from "./ChannelChangeForm";
import { Chip, EmptyState, Notice, Section } from "@/app/_components/DashboardShell";
import { PixelIconLock } from "@/app/_components/PixelIcons";
import type { CoreChannel } from "@/lib/pixieCore";

// What each claim is called, in the onboarding Channels step's own words, and
// whether the channel is one the product keeps private. The organizer channel
// is where ticket notes, claims and escalations land, so it is labelled
// "helpers" rather than by its storage column name and marked with a lock.
const KIND_TITLE: Record<string, string> = {
  help: "Help channel",
  organizer: "Helpers channel",
};

const KIND_HINT: Record<string, string> = {
  help: "Where members ask questions. Pixie replies in threads here.",
  organizer: "Where tickets, claims and escalations land. Keep it private.",
};

const PRIVATE_KINDS = new Set(["organizer"]);

// help first, then the private helpers channel, then anything else by name —
// the order the onboarding step puts them in.
const KIND_ORDER = ["help", "organizer"];

export async function ChannelsSection({ programId, workspaceId }: { programId: string; workspaceId: string }) {
  // Streamed in its own Suspense boundary: the workspace channel list is the
  // slowest Core call on the settings page and nothing else depends on it.
  // Both reads fail soft — the claimed-channel list collapses to empty, and the
  // workspace list comes back as { ok: false } with a reason rather than
  // throwing, so the raw channel-ID field stays available either way.
  const [claimed, list] = await Promise.all([
    listHostedChannels(programId).catch(() => []),
    workspaceSlackChannels(workspaceId),
  ]);

  // The same list the move form offers, so a bound channel reads by name. A
  // claim the workspace list doesn't carry (an archived channel, a stale
  // workspace, a failed Core read) keeps its raw id and says so.
  const byId = new Map(list.channels.map((c) => [c.id, c]));
  const groups = groupClaims(claimed.map((c) => ({ ...c, channel: byId.get(c.channel_id) ?? null })));

  return (
    <Section
      bordered
      title="Channels"
      description="Where Pixie answers, and where work lands for your helpers."
    >
      {claimed.length === 0 ? (
        <EmptyState
          title="No channels claimed yet."
          hint="Claim one below and Pixie starts answering where your people already ask."
        />
      ) : (
        /* The same measure as the move form below it, so the two blocks read as
           one control stack rather than as a short list in a wide panel. */
        <div className="max-w-lg space-y-5">
          {groups.map((group) => (
            <section key={group.kind}>
              <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
                <span className="pixie-mark" aria-hidden="true" />
                {KIND_TITLE[group.kind] ?? group.kind}
                {PRIVATE_KINDS.has(group.kind) ? (
                  <span className="font-normal text-text-muted/70">· private</span>
                ) : null}
              </p>
              {KIND_HINT[group.kind] ? (
                <p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-text-muted">{KIND_HINT[group.kind]}</p>
              ) : null}
              <ul className="mt-2.5 divide-y divide-line">
                {group.rows.map((row) => (
                  <ClaimedRow key={`${row.workspace_id}:${row.channel_id}`} row={row} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!list.ok && (
        <div className="mt-5">
          <Notice tone="warn" title="Slack channel list unavailable">
            Pixie couldn&apos;t read this workspace&apos;s channels
            {list.reason ? `: ${list.reason}` : ""}. Paste a channel ID below instead — it works either way.
          </Notice>
        </div>
      )}

      <ChannelChangeForm programId={programId} channels={list.channels} />
    </Section>
  );
}

type ClaimRow = {
  workspace_id: string;
  channel_id: string;
  kind: string;
  channel: CoreChannel | null;
};

// One bound channel: the Slack name when Core knows it, the raw id underneath in
// operational type (it is what the move form and /pixie-program both take), and
// a lock on the private one, right against the name it qualifies. When only the
// id is known the id moves up to the name line in mono, so the row is still
// readable and never looks empty.
function ClaimedRow({ row }: { row: ClaimRow }) {
  const name = row.channel?.name;
  const privateChannel = PRIVATE_KINDS.has(row.kind);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold leading-tight text-text">
          <span className={`min-w-0 truncate ${name ? "" : "font-mono"}`}>{name ? `#${name}` : `#${row.channel_id}`}</span>
          {privateChannel ? (
            <span className="grid size-4 shrink-0 place-items-center text-text-muted" role="img" aria-label="Private channel">
              <PixelIconLock size={16} />
            </span>
          ) : null}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-text-muted/80">
          <span>{row.kind}</span>
          {name ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{row.channel_id}</span>
            </>
          ) : null}
          {row.channel && !row.channel.isMember ? <Chip>invite @Pixie</Chip> : null}
        </p>
      </div>
    </li>
  );
}

// Group the claims by kind, help first then the private helpers channel, then
// whatever else this program has claimed, alphabetically.
function groupClaims(rows: ClaimRow[]): { kind: string; rows: ClaimRow[] }[] {
  const byKind = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    const bucket = byKind.get(row.kind);
    if (bucket) bucket.push(row);
    else byKind.set(row.kind, [row]);
  }
  return Array.from(byKind.entries())
    .sort(([a], [b]) => {
      const ia = KIND_ORDER.indexOf(a);
      const ib = KIND_ORDER.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    })
    .map(([kind, list]) => ({ kind, rows: list }));
}
