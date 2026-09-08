// Fills the content column while a dashboard page resolves. The shell
// (sidebar, header, program nav) has already painted. Deliberately plain:
// a few low-contrast lines, no spinner, no logo, no progress bar.
export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-3" aria-busy="true" aria-label="Loading">
      <div className="h-5 w-56 max-w-full rounded-sm bg-line/50" />
      <div className="h-3 w-72 max-w-full rounded-sm bg-line/40" />
      <div className="mt-8 h-3 w-40 rounded-sm bg-line/40" />
      <div className="h-3 w-full max-w-md rounded-sm bg-line/30" />
      <div className="h-3 w-full max-w-sm rounded-sm bg-line/30" />
      <span className="sr-only">Loading this page.</span>
    </div>
  );
}
