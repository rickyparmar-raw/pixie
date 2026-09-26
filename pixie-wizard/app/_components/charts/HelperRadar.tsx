"use client";

import { RadarArea } from "@/components/charts/radar-area";
import { RadarAxis } from "@/components/charts/radar-axis";
import { RadarChart } from "@/components/charts/radar-chart";
import { RadarGrid } from "@/components/charts/radar-grid";
import { RadarLabels } from "@/components/charts/radar-labels";

export type Dimension = {
  key: string;
  label: string;
  score: number | null;
  detail: string;
};

export function HelperRadar({ dimensions }: { dimensions: readonly Dimension[] }) {
  const metrics = dimensions.map((d) => ({ key: d.key, label: d.label }));
  // An unmeasurable dimension plots at zero but is never labelled with one.
  const values: Record<string, number> = {};
  for (const d of dimensions) values[d.key] = d.score ?? 0;

  return (
    <div className="grid items-center gap-x-10 gap-y-8 sm:grid-cols-2">
      {/* Measured by its container, not a fixed 300px box: a fixed box paints
          its axis labels outside itself and overflows a phone. */}
      <RadarChart
        data={[{ label: "Helper", color: "var(--chart-1)", values }]}
        metrics={metrics}
        className="mx-auto w-full max-w-[340px]"
        margin={64}
        levels={4}
      >
        <RadarGrid showLabels={false} stroke="var(--color-line)" strokeOpacity={0.55} />
        <RadarAxis stroke="var(--color-line)" strokeOpacity={0.4} />
        <RadarLabels fontSize={11} offset={18} />
        <RadarArea index={0} showPoints={false} showGlow={false} />
      </RadarChart>

      <dl className="min-w-0 space-y-2.5">
        {dimensions.map((d) => (
          <div key={d.key} className="border-b border-line pb-2 last:border-0 last:pb-0">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-text-muted">{d.label}</dt>
              <dd className="shrink-0 text-right">
                <span className="font-mono text-sm tabular-nums text-text">
                  {d.score === null ? "—" : d.score}
                </span>
                <span className="ml-2 text-[11px] text-text-muted">{d.detail}</span>
              </dd>
            </div>
            {/* An unmeasurable dimension keeps an empty track: the em dash in
                the score says why, the bar never invents a value. */}
            <div className="mt-1.5 h-1.5 bg-line/60">
              <div className="h-full rounded-[1px] bg-brand" style={{ width: `${d.score ? Math.max(d.score, 2) : 0}%` }} />
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}
