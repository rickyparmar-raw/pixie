// Control-plane URL screening for knowledge sources. String-level only (no
// DNS here) — Core's sourceGuard revalidates with resolution before fetching.
// Rejecting localhost/private literals at the form keeps obvious mistakes and
// casual abuse out before they reach the fetcher.

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.localhost|.*\.internal|.*\.lan|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\]|fe80:|fc00:|fd00:)/i;

export function sourceUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That URL doesn't look valid.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Source URLs must be http(s).";
  }
  if (PRIVATE_HOST.test(parsed.hostname)) {
    return "That host is private infrastructure — hosted Pixie can't fetch it.";
  }
  return null;
}
