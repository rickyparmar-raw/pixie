"use client";

// Pairs with loading.tsx: catches a thrown error from a dashboard page so it
// renders inside the shell instead of replacing the whole app. Pages already
// fail soft around Core calls — this is the backstop for the rarer case (a
// control-plane read failing). No stack traces; just a retry.
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-prose">
      <h1 className="text-lg font-medium text-text">This page didn&apos;t load</h1>
      <p className="mt-2 text-sm text-text-muted">
        Something failed while loading. The program&apos;s configuration is untouched.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 inline-flex items-center justify-center rounded-md border border-line px-3.5 py-2 text-sm font-medium text-text-muted transition-colors hover:border-text-muted/50 hover:text-text"
      >
        Try again
      </button>
    </div>
  );
}
