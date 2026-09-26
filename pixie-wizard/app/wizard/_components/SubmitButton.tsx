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
  disabled = false,
  className = "",
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  block?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} className={`${btnPrimary}${block ? " w-full" : ""}${className ? ` ${className}` : ""}`}>
      {pending ? pendingLabel : children}
    </button>
  );
}
