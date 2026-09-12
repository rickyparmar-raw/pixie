import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreUsage, type CoreUsageAggregate } from "@/lib/pixieCore";
import { getQuota, type QuotaResult } from "@/lib/quota";
import { CoreError, EmptyState, MetricCard, MiniBar, PageHeader, Section } from "@/app/_components/DashboardShell";

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
  const { program } = await requireProgramMembership(id);
  const dates = rangeDates(range);

  let usage: CoreUsageAggregate | null = null;
  let quota: QuotaResult | null = null;
  let loadError: string | null = null;
  try {
    [usage, quota] = await Promise.all([
      coreUsage(id, { ...dates, interval: range === "24h" || range === "7d" ? "hour" : "day" }),
      getQuota(id, dates.from, dates.to),
    ]);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Usage data is unavailable.";
  }

  const summary = usage?.summary;
  const totalTokens = summary ? summary.inputTokens + summary.outputTokens : null;

  return (
    <>
      <PageHeader
        title="Quota & usage"
        description="Authoritative usage reported by Pixie Core for this program."
        actions={<RangeControls programId={id} selected={range} />}
      />

      {loadError ? <CoreError message={loadError} /> : null}
      <div className="space-y-12">
        <Section title="Summary" description={`Selected window: ${rangeTitle(range)}.`}>
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Requests" value={number(summary?.requests)} />
            <MetricCard label="Input tokens" value={number(summary?.inputTokens)} />
            <MetricCard label="Output tokens" value={number(summary?.outputTokens)} />
            <MetricCard label="Total tokens" value={number(totalTokens)} />
            <MetricCard label="Cost" value={cost(summary?.costCents ?? null)} detail={usage ? precisionLabel(usage.precision) : "UNAVAILABLE"} />
            <MetricCard label="Grounded answers" value={number(summary?.groundedAnswers)} />
            <MetricCard label="Fallbacks" value={number(summary?.fallbacks)} />
            <MetricCard label="Suppressed" value={number(summary?.suppressed)} />
            <MetricCard label="Average latency" value={summary?.latencyMs == null ? "—" : `${number(Math.round(summary.latencyMs))} ms`} />
            <MetricCard label="Errors" value={number(summary?.errors)} />
            <MetricCard label="429s" value={number(summary?.rateLimited)} />
          </div>
        </Section>

        <Section title="Usage over time" description="The current Core contract provides an aggregate for the selected window, not a time series.">
          {usage && usage.timeseries.length > 0 ? (
            <div className="space-y-2">
              {usage.timeseries.map((point) => (
                <MiniBar key={point.at} label={formatAt(point.at)} value={point.requests} max={Math.max(...usage.timeseries.map((item) => item.requests), 1)} display={`${number(point.requests)} requests`} />
              ))}
            </div>
          ) : (
            <EmptyState title="No usage measurements for this window." hint="No aggregate was returned by Pixie Core." />
          )}
        </Section>

        <Section title="Provider and model breakdown">
          {usage && usage.provider.length > 0 ? <Breakdown rows={usage.provider} /> : <EmptyState title="No provider usage for this window." />}
        </Section>

        <Section title="Pipeline operations">
          {usage && usage.operation.length > 0 ? <Breakdown rows={usage.operation} /> : <EmptyState title="No pipeline operations for this window." />}
        </Section>

        <Section title="Top consumers" description="Metadata only; message content is never shown here.">
          {usage && usage.topConsumers.length > 0 ? <Breakdown rows={usage.topConsumers.map((row) => ({ ...row, name: row.consumerId }))} /> : <EmptyState title="No consumer metadata for this window." />}
        </Section>

        <Section title="Recent usage">
          {usage && usage.recent.length > 0 ? <RecentRows rows={usage.recent} /> : <EmptyState title="No metadata rows for this window." />}
        </Section>

        <Section title="Quota health">
          {usage && quota ? <QuotaHealth usage={usage} quota={quota} /> : <EmptyState title="Quota health unavailable." hint="No quota result was returned for the selected window." />}
        </Section>
      </div>
    </>
  );
}

function QuotaHealth({ usage, quota }: { usage: CoreUsageAggregate; quota: QuotaResult }) {
  return (
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard label="Plan allowance" value={cost(quota.includedCents)} />
      <MetricCard label="Used" value={cost(quota.usedCents)} detail={precisionLabel(quota.precision)} />
      <MetricCard label="Remaining" value={cost(quota.remainingCents)} />
      <MetricCard label="Quota status" value={quota.status.toUpperCase()} detail={quota.plan?.toUpperCase() || "NO PLAN"} />
    </div>
  );
}

function formatAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function Breakdown({ rows }: { rows: Array<{ name: string; requests: number }> }) {
  const max = Math.max(...rows.map((row) => row.requests), 1);
  return <div className="space-y-2">{rows.map((row) => <MiniBar key={row.name} label={row.name} value={row.requests} max={max} />)}</div>;
}

function RecentRows({ rows }: { rows: CoreUsageAggregate["recent"] }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-xs"><thead className="text-text-muted"><tr><th className="pb-2 pr-4 font-normal">Time</th><th className="pb-2 pr-4 font-normal">Operation</th><th className="pb-2 pr-4 font-normal">Provider / model</th><th className="pb-2 pr-4 font-normal">Result</th><th className="pb-2 font-normal">Latency</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.at}-${row.operation}-${row.model}`} className="border-t border-line"><td className="py-2 pr-4 font-mono text-text-muted">{formatAt(row.at)}</td><td className="py-2 pr-4">{row.operation}</td><td className="py-2 pr-4">{row.provider} / {row.model}</td><td className="py-2 pr-4">{row.rateLimited ? "RATE_LIMITED" : row.status.toUpperCase()}{row.retryCount > 0 ? ` · ${row.retryCount} retries` : ""}</td><td className="py-2">{row.latencyMs == null ? "—" : `${number(row.latencyMs)} ms`}</td></tr>)}</tbody></table></div>;
}

function rangeTitle(range: Range): string {
  return range === "all" ? "all available history" : `last ${range}`;
}

function RangeControls({ programId, selected }: { programId: string; selected: Range }) {
  return (
    <nav aria-label="Usage date range" className="flex items-center gap-1 rounded-md border border-line p-1 text-xs">
      {RANGES.map((range) => (
        <Link
          key={range}
          href={`/programs/${programId}/usage?range=${range}`}
          aria-current={selected === range ? "page" : undefined}
          className={`rounded px-2 py-1 ${selected === range ? "bg-panel-2 font-medium text-text" : "text-text-muted hover:text-text"}`}
        >
          {range === "all" ? "All" : range}
        </Link>
      ))}
    </nav>
  );
}
