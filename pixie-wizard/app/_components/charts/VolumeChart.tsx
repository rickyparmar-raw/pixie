"use client";

import { curveMonotoneX } from "@visx/curve";
import { Area } from "@/components/charts/area";
import { AreaChart } from "@/components/charts/area-chart";
import { Grid } from "@/components/charts/grid";
import { XAxis } from "@/components/charts/x-axis";
import { ChartTooltip } from "@/components/charts/tooltip";
import type { VolumeDay } from "@/lib/dashboardMetrics";

// `human` is a subset of `questions`, so the two areas nest rather than
// compete: the green band is everything that came in, the orange band inside
// it is the part a person had to pick up. Never stack these — stacking would
// double-count the same tickets.
const SERIES = [
  { key: "questions", label: "Questions", color: "var(--chart-1)" },
  { key: "human", label: "Needed a person", color: "var(--chart-2)" },
] as const;

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
      <p className="py-10 text-center text-sm text-text-muted">
        No questions in this window yet — the trend appears once tickets start arriving.
      </p>
    );
  }

  const points = data.map((day) => ({
    // Parsed as UTC to match the keys Core buckets by; a bare `new Date(day)`
    // would land on the previous evening in western timezones.
    date: new Date(`${day.date}T00:00:00Z`),
    questions: day.questions,
    human: day.human,
  }));

  return (
    <figure className="m-0">
      <figcaption className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-text-muted">
        {SERIES.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-2">
            <span aria-hidden className="size-2 rounded-full" style={{ background: series.color }} />
            {series.label}
          </span>
        ))}
      </figcaption>
      {/* The floor matters: at phone width a wide aspect ratio leaves less
          height than the axis and margins need, and visx then emits negative
          rect heights. min-height overrides the ratio only where it would
          collapse. */}
      <AreaChart data={points} aspectRatio={aspectRatio} className="min-h-[190px]" margin={{ left: 8, right: 8 }}>
        <Grid horizontal />
        {SERIES.map((series) => (
          <Area
            key={series.key}
            dataKey={series.key}
            fill={series.color}
            stroke={series.color}
            curve={curveMonotoneX}
            strokeWidth={2}
            fillOpacity={0.22}
          />
        ))}
        <XAxis />
        <ChartTooltip
          rows={(point) =>
            SERIES.map((series) => ({
              color: series.color,
              label: series.label,
              value: Number(point[series.key] ?? 0),
            }))
          }
        />
      </AreaChart>
    </figure>
  );
}
