export const inputClass =
  "w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none";

export const labelClass = "mb-1.5 block text-xs font-medium text-text-muted";

// Two button roles. Primary is coral with ink text (white on coral fails
// contrast); quiet is a bordered muted button. Keep to these two so actions
// read consistently across the dashboard.
export const btnPrimary =
  "inline-flex items-center justify-center rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-brand-dim disabled:cursor-not-allowed disabled:opacity-60";

export const btnQuiet =
  "inline-flex items-center justify-center rounded-md border border-line px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:border-text-muted/50 hover:text-text disabled:cursor-not-allowed disabled:opacity-60";
