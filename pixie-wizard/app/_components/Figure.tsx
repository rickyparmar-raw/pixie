"use client";

import { NumberTicker } from "@/components/ui/number-ticker";

// Counts up; non-numbers render verbatim.
export function Figure({ value, className }: { value: string | number; className?: string }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return <span className={className}>{value}</span>;
  }
  return <NumberTicker value={value} className={className} />;
}
