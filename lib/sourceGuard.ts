// SSRF guard for organizer-configured knowledge sources. Hosted programs let
// organizers type arbitrary URLs, so every fetch of source content validates
// the destination BEFORE requesting it: http(s) only, no loopback/link-local/
// private IPs (resolved via DNS, all addresses checked), and manual redirect
// handling that revalidates each hop. DNS rebinding between check and request
// cannot be fully closed without socket pinning; the window is one request
// and the validated hostname is what axios is handed.
import dnsModule = require("node:dns");
import net = require("node:net");
import axios = require("axios");

const dns = dnsModule.promises;

// Five hops covers legitimate doc-site redirect chains (http->https, trailing
// slash, www) without letting an attacker bounce through open redirectors.
const MAX_REDIRECTS = 5;

// Ten seconds: docs CDNs answer in milliseconds; hanging longer means a
// tarpit, and the refresh loop must move on to the next source.
const DEFAULT_FETCH_TIMEOUT_MS = 10000;

function isPublicV4(ip: any) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n: any) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 0 || a >= 224) return false;
  return true;
}

function isPublicV6(ip: any) {
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

function hostnameLooksPrivate(host: any) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (net.isIPv4(h)) return !isPublicV4(h);
  if (net.isIP(h)) return !isPublicV6(h);
  if (h.endsWith(".local") || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  return false;
}

function isPublicAddress(address: any) {
  return net.isIPv4(address) ? isPublicV4(address) : isPublicV6(address);
}

async function validateUrl(rawUrl: any) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_: any) {
    throw new Error(`blocked source URL (unparseable): ${String(rawUrl).slice(0, 80)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`blocked source URL (protocol ${parsed.protocol}): ${parsed.hostname}`);
  }
  if (hostnameLooksPrivate(parsed.hostname)) {
    throw new Error(`blocked source URL (private host): ${parsed.hostname}`);
  }
  // Resolve every address: one private A record among public ones still fails.
  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch (_: any) {
    throw new Error(`blocked source URL (unresolvable host): ${parsed.hostname}`);
  }
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) throw new Error(`blocked source URL (resolves private): ${parsed.hostname}`);
  }
  return parsed.href;
}

// Drop-in guarded replacement for axios.get(sourceUrl) in ingestion paths.
// Redirects are followed manually so every hop revalidates.
async function fetchSourceUrl(rawUrl: any, { timeout = DEFAULT_FETCH_TIMEOUT_MS }: Record<string, any> = {}) {
  let current = await validateUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await axios.get(current, { timeout, maxRedirects: 0, validateStatus: (s: any) => s >= 200 && s < 400 });
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
