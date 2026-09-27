// Organizer-configured URLs are validated before every request and every redirect hop.
// DNS results are checked as a set so one private address cannot hide among public ones.
import dnsModule = require("node:dns");
import net = require("node:net");
import axios = require("axios");

const dns = dnsModule.promises;


const MAX_REDIRECTS = 5;


const DEFAULT_FETCH_TIMEOUT_MS = 10000;

function isPublicV4(ip: string) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 0 || a >= 224) return false;
  return true;
}

function isPublicV6(ip: string) {
  const lower = ip.toLowerCase();
  if (lower === "::1") return false;
  if (lower.startsWith("fe80:")) return false;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false;
  if (lower === "::" || lower.startsWith("::ffff:")) {
    const inner = lower.replace(/^::ffff:/, "");
    if (net.isIPv4(inner)) return isPublicV4(inner);
    return false;
  }
  return true;
}

function hostnameLooksPrivate(host: string) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (net.isIPv4(h)) return !isPublicV4(h);
  if (net.isIP(h)) return !isPublicV6(h);
  if (h.endsWith(".local") || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  return false;
}

function isPublicAddress(address: string) {
  return net.isIPv4(address) ? isPublicV4(address) : isPublicV6(address);
}

async function validateUrl(rawUrl: string) {
  // The scheme, hostname, and every resolved address are boundary checks before axios runs.
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_: unknown) {
    throw new Error(`blocked source URL (unparseable): ${String(rawUrl).slice(0, 80)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`blocked source URL (protocol ${parsed.protocol}): ${parsed.hostname}`);
  }
  if (hostnameLooksPrivate(parsed.hostname)) {
    throw new Error(`blocked source URL (private host): ${parsed.hostname}`);
  }
  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch (_: unknown) {
    throw new Error(`blocked source URL (unresolvable host): ${parsed.hostname}`);
  }
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) throw new Error(`blocked source URL (resolves private): ${parsed.hostname}`);
  }
  return parsed.href;
}

async function fetchSourceUrl(rawUrl: string, { timeout = DEFAULT_FETCH_TIMEOUT_MS }: { timeout?: number } = {}) {
  // Redirects are manual so each destination is subject to the same SSRF checks.
  let current = await validateUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await axios.get(current, { timeout, maxRedirects: 0, validateStatus: (s: number) => s >= 200 && s < 400 });
    const location = res.headers && res.headers.location;
    if (res.status < 300 || res.status >= 400 || !location) return res;
    if (hop === MAX_REDIRECTS) throw new Error(`too many redirects fetching ${current.slice(0, 80)}`);
    current = await validateUrl(new URL(location, current).href);
  }
  throw new Error("unreachable");
}

export = {
  validateUrl,
  fetchSourceUrl,
  isPublicV4,
  isPublicV6,
  hostnameLooksPrivate,
  MAX_REDIRECTS,
  DEFAULT_FETCH_TIMEOUT_MS,
};
