// The dashboard's shared form vocabulary. These four strings are the only
// place the rest of the app is allowed to spell out an input, a field label or
// a button — everything resolves to a class defined once in app/globals.css, so
// the whole product restyles from that file alone.
//
// The setup wizard imports `btnPrimary` for its submit button but layers its
// own `.onboarding-button*` classes on top; those live in an unlayered
// stylesheet, so they keep winning and /wizard looks exactly as it did.

export const inputClass = "pixie-input";

export const labelClass =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted";

// Two button roles, on purpose: `primary` is the one lime action a screen may
// offer, `quiet` is everything else. Keeping the pair this small is what stops
// the dashboard drifting into a wall of equal-weight buttons.
export const btnPrimary = "pixie-button pixie-button-primary";

export const btnQuiet = "pixie-button pixie-button-quiet pixie-button-sm";
