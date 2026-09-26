"use client";

import { Ring } from "@/components/charts/ring";
import { RingChart } from "@/components/charts/ring-chart";
import { RingCenter } from "@/components/charts/ring-center";

export type OutcomeRate = {
  label: string;
  pct: number;
  color: string;
  detail: string;
};

// Independent rates, each on its own 0-100 track.
export function OutcomeRings({ rates }: { rates: readonly OutcomeRate[] }) {
  const data = rates.map((rate) => ({
    label: rate.label,
    value: rate.pct,
    maxValue: 100,
    color: rate.color,
  }));
  const lead = rates[0];

  return (
    <div className="flex flex-wrap items-center gap-x-10 gap-y-6">
      {/* The arcs draw fast and almost together: Pixie's motion language is a
          90ms step, and a ring that takes a second to appear reads as an empty
          chart. Square caps and no hover glow — drawn, not lit. */}
      <RingChart
        data={data}
        size={176}
        strokeWidth={8}
        ringGap={5}
        enterTransition={{ duration: 0.3, ease: "easeOut" }}
        enterStaggerScale={0.2}
      >
        {data.map((ring, index) => (
          <Ring index={index} key={ring.label} lineCap="butt" showGlow={false} />
        ))}
        <RingCenter>
          {({ value, label, isHovered }) => (
            <div className="text-center">
              <p className="font-mono text-[26px] leading-none tabular-nums text-text">
                {isHovered ? Math.round(value) : lead.pct}%
              </p>
              <p className="mt-1.5 text-[11px] text-text-muted">{isHovered ? label : lead.label}</p>
            </div>
          )}
        </RingCenter>
      </RingChart>

      <dl className="min-w-[13rem] flex-1 space-y-3">
        {rates.map((rate) => (
          <div key={rate.label} className="flex items-baseline justify-between gap-4 border-b border-line pb-2.5 last:border-0">
            <dt className="inline-flex items-center gap-2 text-xs text-text-muted">
              <span aria-hidden className="size-1.5 shrink-0 rounded-[1px]" style={{ background: rate.color }} />
              {rate.label}
            </dt>
            <dd className="text-right">
              <span className="font-mono text-sm tabular-nums text-text">{rate.pct}%</span>
              <span className="ml-2 text-[11px] text-text-muted">{rate.detail}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
