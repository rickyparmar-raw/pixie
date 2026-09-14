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
    <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
      <RadarChart
        data={[{ label: "Helper", color: "var(--chart-1)", values }]}
        metrics={metrics}
        size={300}
        margin={52}
        levels={4}
      >
        <RadarGrid showLabels={false} strokeOpacity={0.3} />
        <RadarAxis strokeOpacity={0.25} />
        <RadarLabels fontSize={11} offset={14} />
        <RadarArea index={0} showPoints={false} showGlow={false} />
      </RadarChart>

      <dl className="min-w-[13rem] flex-1 space-y-2.5">
        {dimensions.map((d) => (
          <div key={d.key} className="flex items-baseline justify-between gap-4 border-b border-line pb-2 last:border-0">
            <dt className="text-xs text-text-muted">{d.label}</dt>
            <dd className="shrink-0 text-right">
              <span className="font-mono text-sm tabular-nums text-text">
                {d.score === null ? "—" : d.score}
              </span>
              <span className="ml-2 text-[11px] text-text-muted">{d.detail}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
