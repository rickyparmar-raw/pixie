// Shown in the layout's <main> while a dashboard page's data resolves. The
// layout (sidebar, header, program nav) has already rendered by this point —
// this only fills the content column, so it must not look like a full-page
// loader. Deliberately plain: a couple of low-contrast blocks, no spinner,
// no logo, no progress bar, sized to roughly match a page header so content
// swapping in doesn't shift the layout.
export default function DashboardLoading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="h-2 w-28 rounded-sm bg-line/60" />
      <div className="mt-4 h-6 w-72 max-w-full rounded-sm bg-line/60" />
      <div className="mt-10 space-y-4">
        <div className="h-24 rounded-md border border-line bg-panel/40" />
        <div className="h-40 rounded-md border border-line bg-panel/40" />
      </div>
      <span className="sr-only">Loading this page.</span>
    </div>
  );
}
