"use client";

import { PageHeader, Notice } from "@/app/_components/DashboardShell";
import { IconArrowRight } from "@/app/_components/icons";
import { btnQuiet } from "@/app/wizard/_components/formStyles";

// Pairs with loading.tsx: catches a thrown error from a dashboard page so it
// renders inside the shell instead of replacing the whole app. Pages already
// fail soft around Core calls — this is the backstop for the rarer case (a
// control-plane read failing). No stack traces; just a retry.
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-xl">
      <PageHeader title="This page didn't load" />
      <Notice tone="error" title="Something failed while loading.">
        The program&apos;s configuration is untouched.
      </Notice>
      <div className="mt-5">
        <button type="button" onClick={reset} className={btnQuiet}>
          <IconArrowRight size={16} />
          Try again
        </button>
      </div>
    </div>
  );
}
