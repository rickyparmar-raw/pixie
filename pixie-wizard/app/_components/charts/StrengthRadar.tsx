"use client";

import { RadarArea } from "@/components/charts/radar-area";
import { RadarAxis } from "@/components/charts/radar-axis";
import { RadarChart } from "@/components/charts/radar-chart";
import { RadarGrid } from "@/components/charts/radar-grid";
import { RadarLabels } from "@/components/charts/radar-labels";
import { BarList, MiniBar } from "@/app/_components/DashboardShell";

export type Strength = { tag: string; resolved: number; replies: number };

// Three axes minimum, six maximum.
const MIN_AXES = 3;
const MAX_AXES = 6;

// Same weighting routing uses.
const REPLY_WEIGHT = 0.2;

export function StrengthRadar({ strengths }: { strengths: readonly Strength[] }) {
  const scored = strengths
    .map((s) => ({ ...s, weight: s.resolved + s.replies * REPLY_WEIGHT }))
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_AXES);

  if (scored.length < MIN_AXES) return null;

  const metrics = scored.map((s) => ({ key: s.tag, label: s.tag }));
  const peak = scored[0].weight;
  // Scaled to their own best category.
  const values: Record<string, number> = {};
  for (const s of scored) values[s.tag] = Math.round((s.weight / peak) * 100);

  const [lead, ...rest] = scored;

  return (
    <div className="grid items-center gap-x-10 gap-y-8 sm:grid-cols-2">
      {/* Measured by its container, not a fixed 300px box: a fixed box paints
          its axis labels outside itself and overflows a phone. */}
      <RadarChart
        data={[{ label: "Strengths", color: "var(--chart-1)", values }]}
        metrics={metrics}
        className="mx-auto w-full max-w-[340px]"
        margin={64}
        levels={3}
      >
        <RadarGrid showLabels={false} stroke="var(--color-line)" strokeOpacity={0.55} />
        <RadarAxis stroke="var(--color-line)" strokeOpacity={0.4} />
        <RadarLabels fontSize={11} offset={18} />
        <RadarArea index={0} showPoints={false} showGlow={false} />
      </RadarChart>

      <div className="min-w-0">
        <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
          <span className="pixie-mark" aria-hidden="true" />
          Strongest in
        </p>
        <p className="mt-2.5 truncate text-[15px] font-semibold leading-tight text-text">{lead.tag}</p>
        <p className="mt-1.5 font-mono text-xs tabular-nums text-text-muted">
          {lead.resolved} resolved · {lead.replies} replied
        </p>

        <div className="mt-4 border-t border-line pt-4">
          <BarList>
            {rest.map((s) => (
              <MiniBar
                key={s.tag}
                label={s.tag}
                value={s.weight}
                max={peak}
                tone="bg-brand"
                display={`${s.resolved} · ${s.replies}`}
              />
            ))}
          </BarList>
        </div>
      </div>
    </div>
  );
}
