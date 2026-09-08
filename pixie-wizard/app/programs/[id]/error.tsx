"use client";

// Pairs with loading.tsx: catches a thrown error from a dashboard page so it
// renders inside the shell instead of replacing the whole app with the root
// error page. Pages already fail soft around Core calls — this is the
// backstop for the rarer case (a control-plane read failing, an unexpected
// throw). No stack traces, no error text dump; just a retry.
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
        className="mt-5 rounded-md border border-line px-3 py-2 text-sm text-text hover:bg-panel"
      >
        Try again
      </button>
    </div>
  );
}
