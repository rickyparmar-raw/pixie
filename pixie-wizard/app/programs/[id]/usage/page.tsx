import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreUsage, type CoreUsageAggregate } from "@/lib/pixieCore";
import { getQuota, type QuotaResult } from "@/lib/quota";
import {
  BarList,
  Chip,
  CoreError,
  EmptyState,
  MetricCard,
  MetricRow,
  MiniBar,
  Notice,
  PageHeader,
  Section,
  StatusBadge,
} from "@/app/_components/DashboardShell";
import { shortTime } from "@/app/_components/format";

type Range = "24h" | "7d" | "30d" | "all";

const RANGES: readonly Range[] = ["24h", "7d", "30d", "all"];

function isRange(value: string | string[] | undefined): value is Range {
  return typeof value === "string" && RANGES.includes(value as Range);
}

function rangeDates(range: Range, now = new Date()): { from: string; to: string } {
  const to = now.toISOString();
  if (range === "all") return { from: new Date(0).toISOString(), to };
  const hours = range === "24h" ? 24 : Number.parseInt(range, 10) * 24;
  return { from: new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString(), to };
}

function number(value: number | null | undefined): string {
  return value == null ? "—" : new Intl.NumberFormat("en-US").format(value);
}

function cost(cents: number | null): string {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

function precisionLabel(precision: CoreUsageAggregate["precision"]): string {
  return precision.toUpperCase();
}

// Entitlement state in the semantic colours StatusBadge uses, extended for the
// two states StatusBadge's matcher doesn't cover. Lime is never a state here: an
// unattached plan is missing information, not a result.
const QUOTA_STATUS_TONE: Record<string, string> = {
  active: "text-mint",
  past_due: "text-tang",
  suspended: "text-danger",
  unavailable: "text-text-muted",
};

// The quota bar's fill takes its colour from the same two states the status
// chip already uses — nothing here decides a new warning. An active plan is
// simply the brand accent, the way every other bar on this page is drawn.
const QUOTA_FILL_TONE: Record<string, string> = {
  active: "bg-brand",
  past_due: "bg-tang",
  suspended: "bg-danger",
  unavailable: "bg-line-strong",
};

export default async function UsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const { id } = await params;
  const { range: requestedRange } = await searchParams;
  const range = isRange(requestedRange) ? requestedRange : "30d";
  await requireProgramMembership(id);
  const dates = rangeDates(range);
  const hourly = range === "24h" || range === "7d";

  let usage: CoreUsageAggregate | null = null;
  let quota: QuotaResult | null = null;
  let loadError: string | null = null;
  try {
    [usage, quota] = await Promise.all([
      coreUsage(id, { ...dates, interval: hourly ? "hour" : "day" }),
      getQuota(id, dates.from, dates.to),
    ]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Usage data is unavailable.";
  }

  const summary = usage?.summary;
  const totalTokens = summary ? summary.inputTokens + summary.outputTokens : null;
  // Hoisted out of the bar loop: every bucket is measured against the same
  // peak, so the window's busiest bucket is computed once.
  const bucketMax = Math.max(1, ...(usage?.timeseries ?? []).map((item) => item.requests));

  return (
    <>
      <PageHeader
        title="Quota & usage"
        description="Authoritative usage reported by Pixie Core for this program."
        actions={<RangeControls programId={id} selected={range} />}
      />

      {loadError ? <CoreError message={loadError} /> : null}
      <div className="space-y-8">
        <Section title="Summary" description={`Selected window: ${rangeTitle(range)}.`}>
          {/* Eleven figures never fit one grid without ending on a ragged row,
              and at the same weight none of them is the headline. Four
              headline figures on the left, the rest as a compact ledger on the
              right: the panel says what matters at 28px and keeps the tail
              readable at 13px. */}
          <div className="pixie-panel p-5">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-10">
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-1">
                <MetricCard label="Requests" value={number(summary?.requests)} />
                <MetricCard
                  label="Cost"
                  value={cost(summary?.costCents ?? null)}
                  detail={usage ? precisionLabel(usage.precision) : "UNAVAILABLE"}
                />
                <MetricCard label="Grounded answers" value={number(summary?.groundedAnswers)} />
                <MetricCard label="Errors" value={number(summary?.errors)} tone={toneForCount(summary?.errors)} />
              </div>
              <div className="border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
                <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
                  <span className="pixie-mark" aria-hidden="true" />
                  Every other measure
                </p>
                <div className="mt-3.5">
                  <MetricRow label="Input tokens" value={number(summary?.inputTokens)} />
                  <MetricRow label="Output tokens" value={number(summary?.outputTokens)} />
                  <MetricRow label="Total tokens" value={number(totalTokens)} />
                  <MetricRow label="Fallbacks" value={number(summary?.fallbacks)} />
                  <MetricRow label="Suppressed" value={number(summary?.suppressed)} />
                  <MetricRow
                    label="Average latency"
                    value={summary?.latencyMs == null ? "—" : `${number(Math.round(summary.latencyMs))} ms`}
                  />
                  <MetricRow
                    label="429s"
                    value={number(summary?.rateLimited)}
                    tone={toneForCount(summary?.rateLimited)}
                  />
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="Usage over time"
          description={`Requests per ${hourly ? "hour" : "day"} bucket. Pixie Core returns an aggregate for the selected window, not a line per request.`}
        >
          {usage && usage.timeseries.length > 0 ? (
            <BarList>
              {usage.timeseries.map((point) => (
                <MiniBar
                  key={point.at}
                  label={formatBucket(point.at, hourly)}
                  value={point.requests}
                  max={bucketMax}
                  tone="bg-brand"
                />
              ))}
            </BarList>
          ) : (
            <EmptyState title="No usage measurements for this window." hint="No aggregate was returned by Pixie Core." />
          )}
        </Section>

        <Section title="Provider and model breakdown" description="Requests by provider.">
          {usage && usage.provider.length > 0 ? <Breakdown rows={usage.provider} /> : <EmptyState title="No provider usage for this window." />}
        </Section>

        <Section title="Pipeline operations" description="Requests by operation.">
          {usage && usage.operation.length > 0 ? <Breakdown rows={usage.operation} /> : <EmptyState title="No pipeline operations for this window." />}
        </Section>

        <Section title="Top consumers" description="Metadata only; message content is never shown here.">
          {usage && usage.topConsumers.length > 0 ? <Breakdown rows={usage.topConsumers.map((row) => ({ ...row, name: row.consumerId }))} /> : <EmptyState title="No consumer metadata for this window." />}
        </Section>

        <Section title="Recent usage" description="The last metadata rows Pixie Core reported for this window.">
          {usage && usage.recent.length > 0 ? <RecentRows rows={usage.recent} /> : <EmptyState title="No metadata rows for this window." />}
        </Section>

        <Section title="Quota health" description="Included allowance, what this window used, and what is left on it.">
          {usage && quota ? <QuotaHealth quota={quota} /> : <EmptyState title="Quota health unavailable." hint="No quota result was returned for the selected window." />}
        </Section>
      </div>
    </>
  );
}

function QuotaHealth({ quota }: { quota: QuotaResult }) {
  const missing = quota.status === "unavailable" || !quota.plan;
  // The bar is a ratio of two real numbers. No allowance, or a cost Core could
  // not price, means there is no ratio to draw — the notice above already says
  // which of the two is missing. Clamped at 1: an overage still fills the
  // track, and the caption below says the allowance is used up.
  const included = quota.includedCents;
  const used = quota.usedCents;
  const ratio = included != null && included > 0 && used != null ? Math.min(1, used / included) : null;
  const spent = ratio == null ? null : Math.round(ratio * 100);
  return (
    <>
      {missing && (
        <Notice tone="info" title="No plan attached to this program yet">
          Pixie Core reported no entitlement for this window, so the allowance and the remaining balance are unknown.
          Requests, tokens and cost are still counted in the summary above.
        </Notice>
      )}
      <div className={`pixie-panel p-5 ${missing ? "mt-4" : ""}`}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,17rem)_1fr] lg:items-start lg:gap-10">
          <div className="min-w-0">
            <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
              <span className="pixie-mark" aria-hidden="true" />
              Plan
            </p>
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              {quota.plan ? <Chip tone="lime">{quota.plan.toUpperCase()}</Chip> : <Chip>NO PLAN</Chip>}
              <Chip>
                <span
                  className={`inline-flex items-center gap-1.5 font-mono ${QUOTA_STATUS_TONE[quota.status] ?? "text-text-muted"}`}
                >
                  <span aria-hidden className="size-1.5 shrink-0 rounded-[1px] bg-current" />
                  {quota.status.toUpperCase()}
                </span>
              </Chip>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-x-6 gap-y-5 border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
            <MetricCard label="Plan allowance" value={cost(quota.includedCents)} />
            <MetricCard label="Used" value={cost(quota.usedCents)} detail={precisionLabel(quota.precision)} />
            <MetricCard label="Remaining" value={cost(quota.remainingCents)} />
          </div>
        </div>
        <div className="mt-5 border-t border-line pt-4">
          {ratio != null && spent != null ? (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[12px] text-text-muted">
                  {spent === 100 ? "The included allowance for this window is used up." : `Used ${spent}% of the included allowance.`}
                </span>
                <span className="font-mono text-[12px] tabular-nums text-text">
                  {cost(used)} of {cost(included)}
                </span>
              </div>
              <div
                className="mt-2 h-1.5 bg-line/60"
                role="img"
                aria-label={`${spent}% of the included allowance used`}
              >
                <div
                  className={`h-full rounded-[1px] ${QUOTA_FILL_TONE[quota.status] ?? "bg-brand"}`}
                  style={{ width: `${Math.max(ratio * 100, spent > 0 ? 1 : 0)}%` }}
                />
              </div>
            </>
          ) : (
            <p className="text-[12px] text-text-muted">
              {included == null
                ? "No allowance to measure against — the plan reports no included amount for this window."
                : "No allowance to measure against — Pixie Core could not price the cost of this window."}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// Bars have a fixed label column, so buckets are stamped as short as their
// granularity allows: a day is a date, an hour is a date and its hour.
function formatBucket(value: string, hourly: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  if (!hourly) return day;
  return `${day} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function toneForCount(value: number | null | undefined): string {
  return value ? "text-danger" : "text-text";
}

function Breakdown({ rows }: { rows: Array<{ name: string; requests: number }> }) {
  const max = Math.max(...rows.map((row) => row.requests), 1);
  return <BarList>{rows.map((row) => <MiniBar key={row.name} label={row.name} value={row.requests} max={max} />)}</BarList>;
}

function RecentRows({ rows }: { rows: CoreUsageAggregate["recent"] }) {
  return (
    <>
      {/* Five columns of operational text need 720px, so below `sm` the same
          rows are a two-line ledger instead of a table scrolled half off the
          screen. Every field is in both. */}
      <ul className="pixie-panel divide-y divide-line sm:hidden">
        {rows.map((row) => (
          <li key={`${row.at}-${row.operation}-${row.model}`} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-[12px] text-text">{row.operation}</span>
              <StatusBadge status={row.status} />
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-text-muted">
              <span>{shortTime(Date.parse(row.at))}</span>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">
                {row.provider} / {row.model}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{row.latencyMs == null ? "—" : `${number(row.latencyMs)} ms`}</span>
              {row.retryCount > 0 && <span>{row.retryCount} retries</span>}
            </p>
          </li>
        ))}
      </ul>
      <div className="pixie-panel hidden overflow-x-auto sm:block">
        <table className="pixie-table min-w-[720px]">
          <thead>
            <tr>
              <th>Time</th>
              <th>Operation</th>
              <th>Provider / model</th>
              <th>Result</th>
              <th className="text-right">Latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.at}-${row.operation}-${row.model}`}>
                <td className="whitespace-nowrap font-mono text-text-muted">{shortTime(Date.parse(row.at))}</td>
                <td className="font-mono text-[12px]">{row.operation}</td>
                <td className="font-mono text-[12px] text-text-muted">
                  {row.provider} / {row.model}
                </td>
                <td>
                  <StatusBadge status={row.status} />
                  {row.retryCount > 0 && (
                    <span className="ml-1.5 font-mono text-[11px] text-text-muted">· {row.retryCount} retries</span>
                  )}
                </td>
                <td className="text-right font-mono tabular-nums text-text-muted">
                  {row.latencyMs == null ? "—" : `${number(row.latencyMs)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function rangeTitle(range: Range): string {
  return range === "all" ? "all available history" : `last ${range}`;
}

function RangeControls({ programId, selected }: { programId: string; selected: Range }) {
  return (
    <nav aria-label="Usage date range" className="pixie-panel flex items-center gap-1 p-1">
      {RANGES.map((range) => {
        const active = selected === range;
        return (
          <Link
            key={range}
            href={`/programs/${programId}/usage?range=${range}`}
            aria-current={active ? "page" : undefined}
            className={`rounded-[2px] border px-2.5 py-1 font-mono text-[12px] transition-colors ${
              active
                ? "border-brand/35 bg-brand/10 text-brand"
                : "border-transparent text-text-muted hover:bg-panel-2 hover:text-text"
            }`}
          >
            {range === "all" ? "All" : range}
          </Link>
        );
      })}
    </nav>
  );
}
