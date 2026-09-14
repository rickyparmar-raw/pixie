"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  chartCenterContainerClassName,
  chartCenterLabelClassName,
  chartCenterValueClassName,
} from "./chart-center-typography";
import {
  ChartStatFlow,
  type ChartStatFlowFormat,
  defaultChartStatFlowFormat,
} from "./chart-stat-flow";
import { useRingHover, useRingStable } from "./ring-context";

export interface RingCenterProps {
  /** Label shown below the value. Default: "Total" when not hovering */
  defaultLabel?: string;
  /** Format options for NumberFlow. Default: standard notation */
  formatOptions?: ChartStatFlowFormat;
  /** Custom render function for complete control over center content */
  children?: (props: {
    value: number;
    label: string;
    isHovered: boolean;
    data: { label: string; value: number; maxValue: number; color?: string };
  }) => ReactNode;
  /** Additional class name for the container */
  className?: string;
  /** Class name for the value text. Scales with center size via container queries. */
  valueClassName?: string;
  /** Class name for the label text. Scales with center size via container queries. */
  labelClassName?: string;
  /** Prefix to show before the number (e.g., "$") */
  prefix?: string;
  /** Suffix to show after the number (e.g., "%") */
  suffix?: string;
}

/**
 * RingCenter displays content in the center of the ring chart.
 *
 * This component renders as pure HTML (not inside SVG foreignObject) to avoid
 * Safari's WebKit bug #23113 where HTML content with CSS transforms/opacity
 * inside foreignObject renders at incorrect positions.
 *
 * The parent RingChart uses CSS Grid stacking to overlay this HTML content
 * on top of the SVG rings.
 */
export function RingCenter({
  defaultLabel = "Total",
  formatOptions = defaultChartStatFlowFormat,
  children,
  className = "",
  valueClassName = chartCenterValueClassName,
  labelClassName = chartCenterLabelClassName,
  prefix,
  suffix,
}: RingCenterProps) {
  const { data, totalValue, baseInnerRadius } = useRingStable();
  const { hoveredIndex } = useRingHover();

  const hoveredData = hoveredIndex === null ? null : data[hoveredIndex];
  const displayValue = hoveredData ? hoveredData.value : totalValue;
  const displayLabel = hoveredData ? hoveredData.label : defaultLabel;

  // Calculate center area size based on scaled baseInnerRadius
  // Leave some padding so text doesn't touch the inner ring
  const centerSize = baseInnerRadius * 2 - 16;

  // The render prop owns both states — it is handed `isHovered` precisely so
  // it can draw a resting value too. Deferring to the default centre at rest
  // (upstream gated this on `hoveredData`) both ignores the caller and
  // re-introduces the NumberFlow SSR hydration mismatch on first paint.
  if (children) {
    return (
      <div
        className={cn(
          chartCenterContainerClassName,
          "flex items-center justify-center",
          className
        )}
        style={{ width: centerSize, height: centerSize }}
      >
        {children({
          value: displayValue,
          label: displayLabel,
          isHovered: hoveredIndex !== null,
          data: hoveredData ?? data[0],
        })}
      </div>
    );
  }

  // Default center content with NumberFlow animations
  // Now renders as pure HTML, avoiding Safari's foreignObject bugs
  return (
    <div
      className={cn(
        chartCenterContainerClassName,
        "flex flex-col items-center justify-center text-center",
        className
      )}
      style={{ width: centerSize, height: centerSize }}
    >
      <ChartStatFlow
        formatOptions={formatOptions}
        label={displayLabel}
        labelClassName={labelClassName}
        prefix={prefix}
        suffix={suffix}
        value={displayValue}
        valueClassName={valueClassName}
      />
    </div>
  );
}

RingCenter.displayName = "RingCenter";

export default RingCenter;
