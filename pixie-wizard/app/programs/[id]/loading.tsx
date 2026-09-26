// Fills the content column while a dashboard page resolves. The shell
// (sidebar, header, program nav) has already painted. Deliberately plain: a
// few low-contrast blocks, no spinner, no logo, no progress bar, and no
// shimmer sweep — `.pixie-skeleton` in globals.css is the block and its pulse,
// and it belongs to the design system rather than to this route.
export default function DashboardLoading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading">
      <div className="border-b border-line pb-6">
        <div className="pixie-skeleton h-8 w-64 max-w-full" />
        <div className="pixie-skeleton mt-3.5 h-4 w-96 max-w-full" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pixie-panel p-4">
            <div className="flex items-center gap-2.5">
              <div className="pixie-skeleton size-7" />
              <div className="pixie-skeleton h-3 w-20" />
            </div>
            <div className="pixie-skeleton mt-3.5 h-6 w-14" />
          </div>
        ))}
      </div>

      <div className="pixie-panel space-y-3 p-5">
        <div className="pixie-skeleton h-3 w-32" />
        <div className="pixie-skeleton h-3.5 w-full max-w-2xl" />
        <div className="pixie-skeleton h-3.5 w-full max-w-xl" />
        <div className="pixie-skeleton h-3.5 w-4/5 max-w-lg" />
      </div>

      <span className="sr-only">Loading this page.</span>
    </div>
  );
}
