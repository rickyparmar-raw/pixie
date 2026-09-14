"use client";

import { NumberTicker } from "@/components/ui/number-ticker";

// KPI figures count up the first time they scroll into view. Anything that is
// not a finite number — an em dash where Core could not answer, a preformatted
// "68%" — renders verbatim, so an unavailable metric never animates up from
// zero and reads as a real value of zero.
export function Figure({ value, className }: { value: string | number; className?: string }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return <span className={className}>{value}</span>;
  }
  return <NumberTicker value={value} className={className} />;
}
