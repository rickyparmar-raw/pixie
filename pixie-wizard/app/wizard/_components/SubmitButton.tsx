"use client";

import { useFormStatus } from "react-dom";
import { btnPrimary } from "./formStyles";

// Primary submit button wired to the enclosing form's pending state. Inline
// width by default; pass `block` for the full-width treatment the wizard
// setup flow uses.
export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  block = false,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  block?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${btnPrimary}${block ? " w-full" : ""}`}>
      {pending ? pendingLabel : children}
    </button>
  );
}
