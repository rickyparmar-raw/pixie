const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const knowledge = require("./knowledge");
const log = require("./log");
import type { IncomingMessage, RequestOptions } from "http";

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;
const MAX_TEXT_BUDGET = 6000;

const FETCH_USER_AGENT = "PixieBot/1.0";
const FETCH_ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function blocked() {
  return {
    blocked: true,
    reason: "pixie can only open public URLs — localhost on your machine isn't reachable from the bot",
  };
}

function extractUrl(text: string) {
  if (!text) return null;
  const unwrapped = text.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g, "$1");
  const match = unwrapped.match(/https?:\/\/[^\s>]+/i);
  if (!match) return null;
  let urlStr = match[0];
  urlStr = urlStr.replace(/[.,;:!?)]+$/, "");
  return urlStr;
}

function isPrivateOrLoopbackIp(ip: string) {
  if (!ip) return false;

  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  if (ip.includes(".")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }

  return false;
}

async function resolveAndValidateHost(urlStr: string) {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { isBlocked: true, reason: "invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { isBlocked: true, reason: "invalid scheme" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { isBlocked: true, reason: "localhost blocked" };
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrLoopbackIp(hostname)) {
      return { isBlocked: true, reason: "private IP blocked" };
    }
    return { isBlocked: false, parsed, validatedIp: hostname };
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return { isBlocked: true, reason: "DNS lookup returned no records" };
    }
    for (const record of records) {
      if (isPrivateOrLoopbackIp(record.address)) {
        return { isBlocked: true, reason: `resolved private IP ${record.address}` };
      }
    }
    return { isBlocked: false, parsed, validatedIp: records[0].address };
  } catch (error: unknown) {
    return { isBlocked: true, reason: `DNS lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function isBlockedHost(urlStr: string) {
  const result = await resolveAndValidateHost(urlStr);
  return result.isBlocked;
}

function requestOptions(parsed: URL, validatedIp: string): RequestOptions {
  const isHttps = parsed.protocol === "https:";
  const options: RequestOptions = {
    hostname: validatedIp,
    port: parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80,
    path: parsed.pathname + parsed.search,
    method: "GET",
    headers: {
      Host: parsed.hostname,
      "User-Agent": FETCH_USER_AGENT,
      Accept: FETCH_ACCEPT,
    },
  };
  if (isHttps) (options as RequestOptions & { servername: string }).servername = parsed.hostname;
  return options;
}

function requestResolved(parsed: URL, validatedIp: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(requestOptions(parsed, validatedIp), (res: IncomingMessage) => {
      resolve(res);
    });

    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error("Request timeout"));
    });
    req.end();
  });
}

async function fetchUrlContent(urlStr: string) {
  let currentUrl = urlStr;
  let redirectCount = 0;

  while (redirectCount <= MAX_REDIRECTS) {
    const hostValidation = await resolveAndValidateHost(currentUrl);
    if (hostValidation.isBlocked) return blocked();

    const { parsed, validatedIp } = hostValidation;
    if (!parsed || !validatedIp) return blocked();

    try {
      const res = await requestResolved(parsed, validatedIp);

      const statusCode = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(statusCode)) {
        const location = res.headers["location"];
        if (!location) {
          return { error: true, message: "Redirect missing Location header" };
        }
        currentUrl = new URL(location, currentUrl).href;
        redirectCount++;
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        return { error: true, message: `HTTP ${statusCode}` };
      }

      const contentType = res.headers["content-type"] || "";
      const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
      const isTextOrJson = contentType.includes("text/") || contentType.includes("application/json");

      if (!isHtml && !isTextOrJson) {
        return { error: true, message: "Unsupported content type" };
      }

      const contentLengthStr = res.headers["content-length"];
      if (contentLengthStr && parseInt(contentLengthStr, 10) > MAX_CONTENT_LENGTH) {
        return { error: true, message: "Content exceeds 2MB limit" };
      }

      const chunks: Buffer[] = [];
      let totalLength = 0;

      for await (const chunk of res) {
        totalLength += chunk.length;
        if (totalLength > MAX_CONTENT_LENGTH) {
          return { error: true, message: "Content exceeds 2MB limit" };
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const rawText = Buffer.concat(chunks).toString("utf-8");
      let text = isHtml ? knowledge.stripHtml(rawText) : rawText;
      text = text.trim();
      if (text.length > MAX_TEXT_BUDGET) {
        text = text.slice(0, MAX_TEXT_BUDGET) + "\n...[truncated]";
      }

      return { url: currentUrl, text };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.debug("link", `fetch failed for ${currentUrl}: ${message}`);
      return { error: true, message };
    }
  }

  return { error: true, message: "Too many redirects" };
}

export = {
  extractUrl,
  isPrivateOrLoopbackIp,
  isBlockedHost,
  fetchUrlContent,
  MAX_TEXT_BUDGET,
};
