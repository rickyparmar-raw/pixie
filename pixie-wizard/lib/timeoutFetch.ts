// Requests via the platform `fetch` have no timeout by default — if a
// remote host is unreachable in a way that doesn't fail fast (DNS black
// hole, a firewall silently dropping packets, a paused/degraded upstream)
// the underlying request never settles. Anywhere that's `await`ed directly
// in a server component, layout, or route handler, that turns into the
// entire page/request hanging forever with no error surfaced. Bound every
// such request so a network failure turns into a thrown error instead of
// an infinite hang.
//
// This lives in its own module (not lib/db.ts) because several test files
// replace "@/lib/db" wholesale via bun's `mock.module`, which
// patches the module registry for the whole test run — any other import of
// that same resolved path (including this file's own tests) would get the
// fake module instead of the real exports.
export const REQUEST_TIMEOUT_MS = 10_000;

// `timeoutMs` defaults to REQUEST_TIMEOUT_MS for every real caller; it's only
// overridden in tests so a timeout case doesn't have to wait out the real 10s.
//
// Combines the timeout signal with any caller-supplied signal via
// AbortSignal.any so BOTH can abort the request — passing only init?.signal
// would silently drop the timeout whenever a caller signal is present, and
// passing only the timeout signal would silently drop caller aborts.
// AbortSignal.any and AbortSignal.timeout both handle their own listener
// wiring/cleanup internally, so there's nothing here to leak.
export function timeoutFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}
