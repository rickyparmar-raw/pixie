"use client";

import { curveMonotoneX } from "@visx/curve";
import { Area } from "@/components/charts/area";
import { AreaChart } from "@/components/charts/area-chart";
import { Grid } from "@/components/charts/grid";
import { XAxis } from "@/components/charts/x-axis";
import { ChartTooltip } from "@/components/charts/tooltip";
import { EmptyState } from "@/app/_components/DashboardShell";
import type { VolumeDay } from "@/lib/dashboardMetrics";

// Nested, not stacked: human is a subset of questions. Lime leads, amber is the
// subset inside it, and the primary series keeps the heavier stroke so the eye
// lands on it first.
//
// The fills are a flat wash, barely there: `gradientToOpacity` is passed the
// same value as `fillOpacity`, so both gradient stops are identical and the
// fill is one even tone rather than a fade — Pixie's charts have no gradients.
// Because the amber area is nested inside the lime one the two washes overlap,
// and at a heavy opacity they stack into a green slab that swallows the amber
// line. Low primary / lower secondary keeps the lime reading as a ground with
// the crisp strokes on top of it.
const SERIES = [
  { key: "questions", label: "Questions", color: "var(--chart-1)", strokeWidth: 2, fillOpacity: 0.1 },
  { key: "human", label: "Needed a person", color: "var(--chart-2)", strokeWidth: 1.5, fillOpacity: 0.06 },
] as const;

// The hovered bucket, in the same words the x-axis uses.
function formatDay(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function VolumeChart({
  data,
  aspectRatio = "3 / 1",
}: {
  data: readonly VolumeDay[];
  aspectRatio?: string;
}) {
  const total = data.reduce((sum, day) => sum + day.questions, 0);

  if (total === 0) {
    return (
      <EmptyState
        title="No questions in this window yet."
        hint="The trend appears once tickets start arriving."
      />
    );
  }

  const points = data.map((day) => ({
    // UTC, matching Core's keys.
    date: new Date(`${day.date}T00:00:00Z`),
    questions: day.questions,
    human: day.human,
  }));

  return (
    <figure className="m-0">
      {/* Legend: 6px square markers in the series colour, 12px muted labels. */}
      <figcaption className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        {SERIES.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-2 text-xs text-text-muted">
            <span aria-hidden className="size-1.5 shrink-0 rounded-[1px]" style={{ background: series.color }} />
            {series.label}
          </span>
        ))}
      </figcaption>
      {/* Floor stops negative heights at phone width. The reveal is short so the
          chart reads as a drawn line, not a performance: the product's motion
          language everywhere else is a 90ms step. */}
      <AreaChart
        data={points}
        aspectRatio={aspectRatio}
        className="min-h-[190px]"
        margin={{ left: 8, right: 8 }}
        animationDuration={520}
      >
        {/* 1px solid rule in the line colour: no dashes, no edge fade. */}
        <Grid horizontal numTicksRows={4} strokeDasharray="0" fadeHorizontal={false} />
        {SERIES.map((series) => (
          <Area
            key={series.key}
            dataKey={series.key}
            fill={series.color}
            fillOpacity={series.fillOpacity}
            gradientToOpacity={series.fillOpacity}
            stroke={series.color}
            curve={curveMonotoneX}
            strokeWidth={series.strokeWidth}
          />
        ))}
        <XAxis />
        <ChartTooltip
          showDatePill={false}
          dotVariant="ring"
          dotRadiusFraction={0}
          dotSize={7}
          dotStrokeWidth={1}
          content={({ point }) => (
            <div className="px-3 py-2.5">
              {/* The date rides inside the chip so a hover carries one piece of
                  chrome, not a panel and a second pill under the axis. */}
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-chart-tooltip-muted">
                {formatDay(point.date)}
              </p>
              {SERIES.map((series) => (
                <div key={series.key} className="flex items-center justify-between gap-6 py-0.5">
                  <span className="inline-flex items-center gap-2 text-xs text-chart-tooltip-muted">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-[1px]" style={{ background: series.color }} />
                    {series.label}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-chart-tooltip-foreground">
                    {Number(point[series.key] ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          )}
        />
      </AreaChart>
    </figure>
  );
}
