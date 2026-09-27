// Caches public pages and pauses exhausted credentials so refresh jobs stay within provider limits.
const axios = require("axios");
const { config } = require("./config");
const log = require("./log");

const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v1";
const DEFAULT_TIMEOUT_MS = 15000;

const CREDITS_PAUSE_MS = 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 5000;

interface ScrapeCacheEntry { markdown: string; fetchedAt: number }
interface FirecrawlError { response?: { status?: number; data?: { error?: string } }; message?: string }
interface FirecrawlSearchItem { url?: string; title?: string; markdown?: string; description?: string }
interface FirecrawlSearchResult { url?: string; title?: string; markdown: string }

function authHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function noteFailure({ exhaustedNote, failedNote, err }: { exhaustedNote: string; failedNote: string; err: unknown }) {
  const error = err as FirecrawlError;
  const errMsg = error.response?.data?.error || error.message || String(err);
  if (error.response?.status === 402 || (typeof errMsg === "string" && errMsg.toLowerCase().includes("insufficient credits"))) {
    markCreditsExhausted();
    log.warn("firecrawl", exhaustedNote);
  } else {
    log.warn("firecrawl", `${failedNote}: ${errMsg}`);
  }
}

function getApiKey() {
  return config.firecrawlApiKey || process.env.FIRECRAWL_API_KEY || null;
}

const SCRAPE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const scrapeCache = new Map<string, ScrapeCacheEntry>();
let creditsExhaustedUntil = 0;

function isCreditsExhausted() {
  return Date.now() < creditsExhaustedUntil;
}

function markCreditsExhausted() {
  // A credit-exhaustion response pauses the key for an hour; retrying only burns the allowance.
  creditsExhaustedUntil = Date.now() + CREDITS_PAUSE_MS;
}

async function scrapeUrl(url: string, { skipCache = false }: { skipCache?: boolean } = {}) {
  // Reuse recent pages to keep scheduled corpus refreshes below Firecrawl's rate limit.
  const cached = scrapeCache.get(url);
  if (!skipCache && cached && Date.now() - cached.fetchedAt < SCRAPE_CACHE_TTL_MS) {
    return cached.markdown;
  }

  if (isCreditsExhausted()) {
    // A stale cached page keeps the corpus useful when a refresh is paused or fails.
    return cached ? cached.markdown : null;
  }

  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const res = await axios.post(
      `${FIRECRAWL_BASE_URL}/scrape`,
      { url, formats: ["markdown"] },
      { headers: authHeaders(apiKey), timeout: DEFAULT_TIMEOUT_MS },
    );

    if (res.data?.success && res.data?.data?.markdown) {
      const markdown = res.data.data.markdown;
      scrapeCache.set(url, { markdown, fetchedAt: Date.now() });
      log.info("firecrawl", `scraped ${url} (${markdown.length} chars)`);
      return markdown;
    }
  } catch (error: unknown) {
    noteFailure({ exhaustedNote: "credits exhausted — pausing live web requests for 1 hour", failedNote: `scrape failed for ${url}`, err: error });
    if (cached) {
      log.debug("firecrawl", `serving stale cached copy for ${url} after a scrape failure`);
      return cached.markdown;
    }
  }
  return null;
}

function clearScrapeCache() {
  scrapeCache.clear();
}

async function searchWeb(query: string, limit = 3): Promise<FirecrawlSearchResult[] | null> {
  // Search is best-effort and never turns provider failure into a user-facing exception.
  if (isCreditsExhausted()) return null;
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const res = await axios.post(
      `${FIRECRAWL_BASE_URL}/search`,
      { query, limit, scrapeOptions: { formats: ["markdown"] } },
      { headers: authHeaders(apiKey), timeout: SEARCH_TIMEOUT_MS },
    );

    if (res.data?.success && Array.isArray(res.data?.data)) {
      log.info("firecrawl", `search "${query}" returned ${res.data.data.length} results`);
      return res.data.data.map((item: FirecrawlSearchItem) => ({
        url: item.url,
        title: item.title,
        markdown: item.markdown || item.description || "",
      }));
    }
  } catch (error: unknown) {
    noteFailure({ exhaustedNote: "credits exhausted — pausing web search for 1 hour", failedNote: `search failed for "${query}"`, err: error });
  }
  return null;
}

export = {
  getApiKey,
  scrapeUrl,
  searchWeb,
  clearScrapeCache,
  SCRAPE_CACHE_TTL_MS,
};
