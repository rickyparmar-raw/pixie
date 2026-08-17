// Fetches and caches pixie's knowledge base from the sources listed in
// sources.json. Add a new doc by adding one entry there — no code changes.
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const retrieve = require("./retrieve");
const log = require("./log");

const SOURCES_PATH = path.join(__dirname, "..", "sources.json");

// last good text per source name — a source that fails to fetch keeps
// serving its previous content instead of dropping out of the corpus.
const cache = new Map();
// lowercase label -> human-facing URL, for whichever section/source a reply
// cites. Populated per-heading (deep link) and per-source (fallback link).
const linkCache = new Map();
let lastBuiltAt = null;

const APP_ROOT = path.join(__dirname, "..");

function loadSources() {
  const raw = fs.readFileSync(SOURCES_PATH, "utf8");
  return JSON.parse(raw);
}

function resolveLocalPath(url) {
  const raw = url.replace(/^file:\/\//, "");
  return path.isAbsolute(raw) ? raw : path.resolve(APP_ROOT, raw);
}

// Rewrites <a href="X">Y</a> to "Y (X)" so inline doc links survive tag
// stripping — same trick annotateHeadingAnchors uses for section anchors.
// Without this the model can cite a section but never surface a link the docs
// themselves point at. Skips empty/anchor-only and javascript: hrefs.
function preserveLinks(html) {
  return html.replace(
    /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (match, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = href.trim();
      if (!label) return match;
      if (!url || url.startsWith("#") || /^javascript:/i.test(url)) return ` ${label} `;
      // Already spelled out in the text — don't print it twice.
      if (label === url) return ` ${label} `;
      return ` ${label} (${url}) `;
    },
  );
}

function stripHtml(html) {
  // script/style go first, so an <a> inside a JS string literal can't get
  // rewritten into the corpus as a real link.
  const withoutCode = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  return preserveLinks(withoutCode)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The FAQ dictionary keys questions/answers under dict.faq.items — see
// apps/landing/app/[lang]/dictionaries/en.json.
function textFromJsonFaq(data) {
  const items = data?.faq?.items;
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => `Q: ${item.question}\nA: ${item.answer}`)
    .join("\n\n");
}

// Docs pages often wrap each section in an anchored container — either
// <section id="react-native"><h1>React Native app guide</h1>... or
// <div id="welcome"><div class="eyebrow">Start here</div><h1>Welcome...
// Tag each section's real heading with a plain-text marker carrying its deep
// link, so citing a specific section survives HTML stripping and gives us a
// real URL to look up later — without ever trusting the model to reproduce
// a URL itself. Deliberately doesn't try to match a balanced closing tag
// (fragile once eyebrow/category divs are nested inside the wrapper) — it
// just tags the heading in place and leaves everything else untouched.
function annotateHeadingAnchors(html, baseUrl, links) {
  // Category/eyebrow labels (e.g. "Start here") sit right next to the real
  // heading and read like a heading themselves — strip them first so they
  // can't get cited as the section name instead of the actual title.
  const cleaned = html.replace(/<div[^>]*\bclass="eyebrow"[^>]*>[\s\S]*?<\/div>/gi, "");

  return cleaned.replace(
    /<(?:section|div)[^>]*\bid="([^"]+)"[^>]*>[\s\S]{0,80}?<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi,
    (match, id, headingInner) => {
      const headingText = headingInner.replace(/<[^>]+>/g, "").trim();
      if (!headingText) return match;

      links.set(headingText.toLowerCase(), `${baseUrl}#${id}`);
      return `\n\n## ${headingText} (${baseUrl}#${id})\n\n`;
    },
  );
}

async function fetchSourceText(source, force = false) {
  // Handle local file:// URLs. A relative path (file://./x.json) resolves
  // against the app directory, same as SOURCES_PATH — an absolute one only
  // ever works on the machine it was written on.
  if (source.url.startsWith("file://")) {
    const raw = fs.readFileSync(resolveLocalPath(source.url), "utf8");
    const data = JSON.parse(raw);

    switch (source.type) {
      case "json-faq":
        return textFromJsonFaq(data);
      case "gdoc":
        linkCache.set(source.name.toLowerCase(), source.url);
        return typeof data === "string" ? data.trim() : String(data);
      default:
        throw new Error(`unsupported type for local file: ${source.type}`);
    }
  }

  const res = await axios.get(source.url, { timeout: 10000 });

  switch (source.type) {
    case "json-faq":
      return textFromJsonFaq(res.data);
    case "gdoc":
      linkCache.set(source.name.toLowerCase(), source.url);
      return typeof res.data === "string" ? res.data.trim() : String(res.data);
    case "url": {
      linkCache.set(source.name.toLowerCase(), source.url);
      const rootHtml = String(res.data);
      
      // Find all sub-page URLs linked from the main documentation page
      const docHost = new URL(source.url).origin;
      const hrefMatches = [...rootHtml.matchAll(/href="(\/docs\/[a-z0-9\-_/]+)"/gi)];
      const pageUrls = [...new Set(hrefMatches.map((m) => new URL(m[1], docHost).href))]
        .filter((u) => !u.endsWith(".css") && !u.endsWith(".js") && !u.endsWith(".png"));

      // Always include the root URL if not present
      if (!pageUrls.includes(source.url)) pageUrls.unshift(source.url);

      log.info("knowledge", `fetching ${pageUrls.length} doc pages for source "${source.name}"`);

      // If Firecrawl API key is available, use Firecrawl for pristine markdown extraction
      const firecrawl = require("./firecrawl");
      if (firecrawl.getApiKey()) {
        log.info("knowledge", `using Firecrawl to scrape ${pageUrls.length} doc pages for "${source.name}"`);
        const BATCH_SIZE = 5;
        const pageTexts = [];
        for (let i = 0; i < pageUrls.length; i += BATCH_SIZE) {
          const batch = pageUrls.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(
            batch.map(async (pageUrl) => {
              const fcMd = await firecrawl.scrapeUrl(pageUrl, { skipCache: force });
              if (fcMd) {
                annotateHeadingAnchors(`<h1 id="top">${source.name}</h1>`, pageUrl, linkCache);
                return `## ${source.name} (${pageUrl})\n\n${fcMd}`;
              }
              try {
                const pageRes = pageUrl === source.url ? res : await axios.get(pageUrl, { timeout: 15000 });
                return stripHtml(annotateHeadingAnchors(String(pageRes.data), pageUrl, linkCache));
              } catch {
                return "";
              }
            }),
          );
          pageTexts.push(...batchResults);
        }
        return pageTexts.filter(Boolean).join("\n\n");
      }

      // Fetch sub-pages in small batches to avoid triggering host rate limits or timeouts
      const BATCH_SIZE = 5;
      const pageTexts = [];
      for (let i = 0; i < pageUrls.length; i += BATCH_SIZE) {
        const batch = pageUrls.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (pageUrl) => {
            try {
              const pageRes = pageUrl === source.url ? res : await axios.get(pageUrl, { timeout: 15000 });
              const pageHtml = String(pageRes.data);
              const annotated = annotateHeadingAnchors(pageHtml, pageUrl, linkCache);
              return stripHtml(annotated);
            } catch (err) {
              log.warn("knowledge", `failed to fetch subpage ${pageUrl}: ${err.message}`);
              return "";
            }
          }),
        );
        pageTexts.push(...batchResults);
      }

      return pageTexts.filter(Boolean).join("\n\n");
    }
    default:
      throw new Error(`unknown source type: ${source.type}`);
  }
}

async function refreshSource(source, force = false) {
  try {
    const text = await fetchSourceText(source, force);
    if (text) cache.set(source.name, text);
  } catch (e) {
    log.warn("knowledge", `failed to fetch "${source.name}": ${e.message} — serving last good copy`);
  }
}

// The questions out of the Q/A sources — someone already sat down and wrote out
// what people ask, so this is the best available guess at what pixie should
// know cold. lib/warm.js answers these on boot so a fresh deployment starts out
// fast on them instead of learning each one through a slow first ask.
//
// Read back out of the loaded section text rather than re-fetching: the source
// cache is already populated by refreshCorpus, and textFromJsonFaq's "Q: " lines
// are the only shape that needs parsing.
function faqQuestions() {
  const questions = [];
  for (const source of loadSources()) {
    if (source.type !== "json-faq") continue;
    for (const line of (cache.get(source.name) || "").split("\n")) {
      const match = line.match(/^Q:\s*(.+)$/);
      if (match) questions.push(match[1].trim());
    }
  }
  return questions;
}

// Looks up a human-facing URL for whatever section/source label a reply
// cites — exact case-insensitive match against known headings and source
// names. Returns null if nothing matches (e.g. FAQ answers, which have no
// human-friendly URL to link to).
function getSourceUrl(label) {
  if (!label) return null;
  return linkCache.get(label.trim().toLowerCase()) || null;
}

// `force` bypasses the Firecrawl per-page scrape cache — for the explicit
// "reload the docs now" admin command, where a stale cached copy would defeat
// the whole point of asking for a hard refresh. The 30-minute auto-refresh
// (lib/knowledge.js's startAutoRefresh) always calls this without force, so
// it reuses whatever was scraped recently instead of re-hitting Firecrawl for
// every doc page on every cycle.
async function refreshCorpus(force = false) {
  const sources = loadSources();
  const validNames = new Set(sources.map((s) => s.name));
  for (const key of cache.keys()) {
    if (!validNames.has(key)) cache.delete(key);
  }
  await Promise.all(sources.map((source) => refreshSource(source, force)));
  invalidate();
  try {
    const cacheModule = require("./cache");
    cacheModule.clearCache();
    log.info("knowledge", "answer cache cleared after corpus refresh");
  } catch (e) {
    log.warn("knowledge", `failed to clear answer cache: ${e.message}`);
  }
  lastBuiltAt = new Date();
  log.info("knowledge", `corpus refreshed — ${cache.size}/${sources.length} sources loaded`);
}

// Sections that aren't fetched from a URL: pixie's own identity, the computed
// program timeline, and everything it has been taught. Each returns "" when it
// has nothing to contribute, so an empty section never reaches the model.
// Registered lazily to keep knowledge.js from importing half the app at load.
const GENERATED_SECTIONS = [
  ["About pixie", () => require("./identity").corpusSection()],
  ["Program timeline", () => require("./program").corpusSection()],
  ["Learned answers", () => require("./learn").corpusSection()],
];

// Built on every question otherwise — a readFileSync, a DB query and a 30KB
// join per request. Cheap individually, pure waste repeated. Invalidated by
// refreshCorpus() and by invalidate(), which the teach/approve/forget path
// calls alongside db.clearCache().
// The day it was built is part of the key: the Program timeline section renders
// "in 21 days", which is wrong the moment the date rolls over, and waiting up
// to a full refresh interval to notice would hand out a stale countdown.
let corpusCache = null;
let corpusBuiltOn = null;
let retrievalIndex = null;

function today() {
  return new Date().toDateString();
}

function invalidate() {
  corpusCache = null;
  corpusBuiltOn = null;
  retrievalIndex = null;
}

// The generated sections, resolved. Split out from buildCorpus so getContext can
// keep them intact while the fetched sources get chunked and ranked.
function generatedSections() {
  const sections = [];
  for (const [name, build] of GENERATED_SECTIONS) {
    let text = "";
    try {
      text = build();
    } catch (e) {
      log.warn("knowledge", `generated section "${name}" failed: ${e.message}`);
    }
    if (text) sections.push([name, text]);
  }
  return sections;
}

function sourceSections() {
  return [...cache];
}

function buildCorpus() {
  // Generated sections go FIRST. They're the authoritative, computed answers —
  // identity, live dates, everything a helper explicitly taught — and when they
  // sat after ~28k characters of scraped docs the model matched them only
  // intermittently, declining questions whose exact wording was present.
  return [...generatedSections(), ...sourceSections()].map(([name, text]) => `### ${name}\n${text}`).join("\n\n");
}

function getCorpus() {
  const day = today();
  if (corpusCache === null || corpusBuiltOn !== day) {
    corpusCache = buildCorpus();
    corpusBuiltOn = day;
  }
  return corpusCache;
}

// Only the fetched sources are indexed. Rebuilt lazily and thrown away by
// invalidate(), so a newly approved fact or a refreshed doc can't be answered
// from a stale index.
function getIndex() {
  if (retrievalIndex === null) {
    retrievalIndex = retrieve.buildIndex(retrieve.chunkSections(sourceSections()));
    log.debug("knowledge", `retrieval index built — ${retrievalIndex.docs.length} chunks`);
  }
  return retrievalIndex;
}

// What the answer path sends instead of the whole corpus: every generated
// section, plus the source passages that match this question.
function getContext(question) {
  // Keeps the daily rebuild (and the timeline countdown it exists for) honest
  // even when nothing calls getCorpus directly.
  getCorpus();

  const context = retrieve.selectContext({
    generated: generatedSections(),
    index: getIndex(),
    sources: sourceSections(),
    question,
  });

  log.debug("knowledge", `context ${context.length} chars (corpus ${corpusCache.length})`);
  return context;
}

function startAutoRefresh(intervalMin) {
  const ms = intervalMin * 60 * 1000;
  return setInterval(() => {
    refreshCorpus().catch((e) => log.error("knowledge", "refresh failed:", e.message));
  }, ms);
}

module.exports = {
  loadSources,
  textFromJsonFaq,
  stripHtml,
  preserveLinks,
  resolveLocalPath,
  annotateHeadingAnchors,
  refreshCorpus,
  getCorpus,
  getContext,
  faqQuestions,
  getIndex,
  invalidate,
  getSourceUrl,
  startAutoRefresh,
  generatedSections,
  get lastBuiltAt() { return lastBuiltAt; },
};
