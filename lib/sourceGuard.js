// SSRF guard for organizer-configured knowledge sources. Hosted programs let
// organizers type arbitrary URLs, so every fetch of source content validates
// the destination BEFORE requesting it: http(s) only, no loopback/link-local/
// private IPs (resolved via DNS, all addresses checked), and manual redirect
// handling that revalidates each hop. DNS rebinding between check and request
// cannot be fully closed without socket pinning; the window is one request
// and the validated hostname is what axios is handed.
const dns = require("dns").promises;
const net = require("net");
const axios = require("axios");

const MAX_REDIRECTS = 5;

function isPublicV4(ip) {
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

function isPublicV6(ip) {
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

function hostnameLooksPrivate(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (net.isIPv4(h)) return !isPublicV4(h);
  if (net.isIP(h)) return !isPublicV6(h);
  if (h.endsWith(".local") || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  return false;
}

async function validateUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
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
  } catch (_) {
    throw new Error(`blocked source URL (unresolvable host): ${parsed.hostname}`);
  }
  for (const { address } of addresses) {
    const publicAddr = net.isIPv4(address) ? isPublicV4(address) : isPublicV6(address);
    if (!publicAddr) throw new Error(`blocked source URL (resolves private): ${parsed.hostname}`);
  }
  return parsed.href;
}

// Drop-in guarded replacement for axios.get(sourceUrl) in ingestion paths.
// Redirects are followed manually so every hop revalidates.
async function fetchSourceUrl(rawUrl, { timeout = 10000 } = {}) {
  let current = await validateUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await axios.get(current, { timeout, maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 400 });
    const location = res.headers && res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) throw new Error(`too many redirects fetching ${current.slice(0, 80)}`);
      current = await validateUrl(new URL(location, current).href);
      continue;
    }
    return res;
  }
  throw new Error("unreachable");
}

module.exports = {
  validateUrl,
  fetchSourceUrl,
  isPublicV4,
  isPublicV6,
  hostnameLooksPrivate,
  MAX_REDIRECTS,
};
