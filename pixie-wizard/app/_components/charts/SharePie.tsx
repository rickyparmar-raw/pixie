"use client";

import { PieCenter } from "@/components/charts/pie-center";
import { PieChart } from "@/components/charts/pie-chart";
import { PieSlice } from "@/components/charts/pie-slice";

export type Share = { label: string; value: number; color?: string };

// The ramp has five slots and the legend has to stay readable, so anything
// past the biggest four folds into one "Other" wedge rather than minting new
// hues — a pie with nine near-identical greys tells you nothing.
const MAX_SLICES = 5;
const RAMP = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

// Caller order is preserved, never re-sorted by size: colour is assigned by
// position, so re-ranking slices every render would repaint an entity as its
// volume moved and quietly change what a colour means between two loads.
function fold(shares: readonly Share[]): Share[] {
  const present = shares.filter((share) => share.value > 0);
  if (present.length <= MAX_SLICES) return present;

  const cutoff = [...present].sort((a, b) => b.value - a.value)[MAX_SLICES - 2].value;
  const kept: Share[] = [];
  let rest = 0;
  for (const share of present) {
    if (kept.length < MAX_SLICES - 1 && share.value >= cutoff) kept.push(share);
    else rest += share.value;
  }
  return rest > 0 ? [...kept, { label: "Other", value: rest }] : kept;
}

export function SharePie({
  shares,
  centerLabel,
  unit,
  size = 184,
}: {
  shares: readonly Share[];
  centerLabel: string;
  unit: string;
  size?: number;
}) {
  const slices = fold(shares);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  if (total === 0) {
    return <p className="py-10 text-center text-sm text-text-muted">Nothing to split up yet.</p>;
  }

  const data = slices.map((slice, index) => ({ ...slice, color: slice.color ?? RAMP[index] }));

  return (
    <div className="flex flex-wrap items-center gap-x-9 gap-y-6">
      <PieChart data={data} size={size} innerRadius={size * 0.31} padAngle={0.02} cornerRadius={3}>
        {data.map((slice, index) => (
          <PieSlice index={index} key={slice.label} />
        ))}
        <PieCenter>
          {({ value, label, isHovered }) => (
            <div className="text-center">
              <p className="font-heading text-xl font-semibold tabular-nums text-text">{value}</p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-text-muted">
                {isHovered ? label : centerLabel}
              </p>
            </div>
          )}
        </PieCenter>
      </PieChart>

      <dl className="min-w-[12rem] flex-1 space-y-2.5">
        {data.map((slice) => (
          <div key={slice.label} className="flex items-baseline justify-between gap-4">
            <dt className="inline-flex min-w-0 items-center gap-2 text-xs text-text-muted">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: slice.color }} />
              <span className="truncate">{slice.label}</span>
            </dt>
            <dd className="shrink-0 text-right">
              <span className="font-mono text-sm tabular-nums text-text">{slice.value}</span>
              <span className="ml-2 text-[11px] tabular-nums text-text-muted">
                {Math.round((slice.value / total) * 100)}%
              </span>
            </dd>
          </div>
        ))}
        <p className="border-t border-line pt-2.5 text-[11px] text-text-muted">
          {total} {unit} in total.
        </p>
      </dl>
    </div>
  );
}
