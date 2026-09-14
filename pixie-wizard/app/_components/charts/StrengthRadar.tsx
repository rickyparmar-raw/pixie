"use client";

import { RadarArea } from "@/components/charts/radar-area";
import { RadarAxis } from "@/components/charts/radar-axis";
import { RadarChart } from "@/components/charts/radar-chart";
import { RadarGrid } from "@/components/charts/radar-grid";
import { RadarLabels } from "@/components/charts/radar-labels";

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
    <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
      {/* Chrome recedes; default margin is too large. */}
      <RadarChart
        data={[{ label: "Strengths", color: "var(--chart-1)", values }]}
        metrics={metrics}
        size={300}
        margin={44}
        levels={3}
      >
        <RadarGrid showLabels={false} strokeOpacity={0.3} />
        <RadarAxis strokeOpacity={0.25} />
        <RadarLabels fontSize={11} offset={14} />
        <RadarArea index={0} showPoints={false} />
      </RadarChart>

      <div className="min-w-[12rem] flex-1">
        <p className="text-xs text-text-muted">Strongest in</p>
        <p className="font-heading mt-1 text-2xl font-semibold leading-none text-text">{lead.tag}</p>
        <p className="mt-2 font-mono text-xs tabular-nums text-text-muted">
          {lead.resolved} resolved · {lead.replies} replied
        </p>

        <dl className="mt-6 space-y-2 border-t border-line pt-4">
          {rest.map((s) => (
            <div key={s.tag} className="flex items-baseline justify-between gap-4">
              <dt className="truncate text-xs text-text-muted">{s.tag}</dt>
              <dd className="shrink-0 font-mono text-xs tabular-nums text-text-muted">
                {s.resolved} · {s.replies}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
