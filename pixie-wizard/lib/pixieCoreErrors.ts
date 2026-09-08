// Error shaping for the internal Core client (lib/pixieCore.ts). Kept in its
// own module so it can be unit-tested directly: several test files replace
// "@/lib/pixieCore" wholesale via mock.module (process-wide), which would
// shadow any test that imported the real client.

// The pathname only — no query string. Query strings on these endpoints
// carry ids and filters; the path already identifies which operation
// failed, and that is all an error message or a log line needs.
export function coreEndpointLabel(path: string): string {
  return path.split("?")[0];
}

// Map a fetch-layer rejection to a message safe to surface and log. It names
// the endpoint and distinguishes a timeout ("Core is slow") from an
// unreachable host ("Core is down"). It never includes the query string, the
// Authorization header, or the internal token — the caller passes only the
// request path in.
export function coreFetchErrorMessage(err: unknown, path: string, timeoutMs: number): string {
  const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
  return isTimeout
    ? `Pixie Core timed out after ${timeoutMs}ms (${coreEndpointLabel(path)})`
    : `Pixie Core unreachable (${coreEndpointLabel(path)})`;
}
