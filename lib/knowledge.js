// Fetches and caches pixie's knowledge base from the sources listed in
// programs.json and sources.json.
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const retrieve = require("./retrieve");
const log = require("./log");
const programs = require("./programs");

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
  const allSources = [];
  const seenUrls = new Set();

  const progs = [...programs.all(), programs.shared()];
  for (const prog of progs) {
    if (!Array.isArray(prog.sources)) continue;
    for (const src of prog.sources) {
      if (!src || !src.name || !src.url) continue;
      const key = `${src.name}::${src.url}`;
      if (!seenUrls.has(key)) {
        seenUrls.add(key);
        allSources.push(src);
      }
    }
  }

  if (allSources.length === 0 && fs.existsSync(SOURCES_PATH)) {
    try {
      const raw = fs.readFileSync(SOURCES_PATH, "utf8");
      return JSON.parse(raw);
    } catch (_) {
      return [];
    }
  }

  return allSources;
}

function resolveLocalPath(url) {
  const raw = url.replace(/^file:\/\//, "");
  return path.isAbsolute(raw) ? raw : path.resolve(APP_ROOT, raw);
}

function preserveLinks(html) {
  return html.replace(
    /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (match, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const url = href.trim();
      if (!label) return match;
      if (!url || url.startsWith("#") || /^javascript:/i.test(url)) return ` ${label} `;
      if (label === url) return ` ${label} `;
      return ` ${label} (${url}) `;
    },
  );
}

function stripHtml(html) {
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

function textFromJsonFaq(data) {
  const items = data?.faq?.items;
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => `Q: ${item.question}\nA: ${item.answer}`)
    .join("\n\n");
}

function annotateHeadingAnchors(html, baseUrl, links) {
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

// "010-welcome.md" -> "Welcome". The numeric prefix only exists to order the
// files on disk; leaving it in the corpus heading would put a meaningless
// number in front of every citation pixie prints.
function docTitleFromFilename(name) {
  return String(name || "")
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_]/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// The rendered docs site slugs each page by its filename minus the ordering
// prefix, so 270-pixel-art.md is served at /docs/pixel-art.
function docSlugFromFilename(name) {
  return String(name || "")
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_]/, "")
    .replace(/_/g, "-")
    .toLowerCase();
}

// Rendered doc pages repeat the whole sidebar nav, the prev/next footer and
// the site chrome on every single page. Left in, each page reads as though it
// mentions every other page's topic, so keyword retrieval scores them all alike
// and the page that actually answers the question stops standing out.
//
// Frequency is the giveaway: a line on most of the pages is chrome, a line of
// real documentation is not. Needs at least three pages to tell them apart.
function dropSharedLines(pages, threshold = 0.6) {
  if (!Array.isArray(pages) || pages.length < 3) return pages;

  const counts = new Map();
  for (const page of pages) {
    const distinct = new Set(String(page).split("\n").map((l) => l.trim()).filter(Boolean));
    for (const line of distinct) counts.set(line, (counts.get(line) || 0) + 1);
  }

  const minPages = Math.ceil(pages.length * threshold);
  const chrome = new Set([...counts].filter(([, n]) => n >= minPages).map(([line]) => line));

  return pages.map((page) =>
    String(page)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !chrome.has(l))
      .join("\n"),
  );
}

// Turns a GitHub contents-API directory listing into the markdown files worth
// fetching. Sorted by filename so the corpus order matches the docs' own
// reading order, which is what the numeric prefixes encode.
function markdownFilesFromListing(data, siteBase = "") {
  if (!Array.isArray(data)) return [];
  return data
    .filter((e) => e && e.type === "file" && /\.md$/i.test(e.name || "") && e.download_url)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((e) => ({
      name: e.name,
      title: docTitleFromFilename(e.name),
      downloadUrl: e.download_url,
      pageUrl: siteBase
        ? `${String(siteBase).replace(/\/$/, "")}/${docSlugFromFilename(e.name)}`
        : e.html_url || e.download_url,
      // The repo markdown carries unrendered {{placeholders}} for every rate
      // and tier, so the rendered page is the only place the real numbers
      // exist. Fall back to raw markdown only when no site is configured.
      contentUrl: siteBase
        ? `${String(siteBase).replace(/\/$/, "")}/${docSlugFromFilename(e.name)}`
        : e.download_url,
      isHtml: Boolean(siteBase),
    }));
}

async function fetchSourceText(source, force = false) {
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
    case "github-dir": {
      const files = markdownFilesFromListing(res.data, source.siteUrl);
      if (files.length === 0) throw new Error(`no markdown files listed at ${source.url}`);

      linkCache.set(source.name.toLowerCase(), source.siteUrl || source.url);
      log.info("knowledge", `fetching ${files.length} markdown file(s) for source "${source.name}"`);

      // Same batch size as the url type. Bodies come from raw.githubusercontent,
      // a CDN, so only the one listing call above counts against the GitHub API
      // rate limit -- important because pixie refreshes unauthenticated.
      const BATCH_SIZE = 5;
      const sections = [];
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (file) => {
            try {
              const fileRes = await axios.get(file.contentUrl, { timeout: 15000 });
              const raw = typeof fileRes.data === "string" ? fileRes.data : String(fileRes.data);
              const body = file.isHtml
                ? stripHtml(annotateHeadingAnchors(raw, file.pageUrl, linkCache)).trim()
                : raw.trim();
              if (!body) return null;
              // A rendered page that still shows {{tokens}} means the site did
              // not interpolate; better to skip it than to teach pixie a
              // placeholder it will happily turn into a made-up number.
              if (/\{\{[a-z0-9_]+\}\}/i.test(body)) {
                log.warn("knowledge", `skipping ${file.name} for "${source.name}": unrendered placeholders`);
                return null;
              }
              linkCache.set(file.title.toLowerCase(), file.pageUrl);
              return { title: file.title, pageUrl: file.pageUrl, body };
            } catch (e) {
              log.warn("knowledge", `failed to fetch ${file.name} for "${source.name}": ${e.message}`);
              return null;
            }
          }),
        );
        sections.push(...batchResults);
      }

      const kept = sections.filter((x) => x && x.body);
      const bodies = dropSharedLines(kept.map((x) => x.body));
      const joined = kept
        .map((x, i) => (bodies[i] ? `## ${x.title} (${x.pageUrl})\n\n${bodies[i]}` : ""))
        .filter(Boolean)
        .join("\n\n");
      // Throwing keeps the previous good text in cache rather than replacing a
      // working corpus with an empty one when GitHub is having a bad day.
      if (!joined) throw new Error(`all markdown fetches failed for ${source.url}`);
      return joined;
    }
    case "url": {
      linkCache.set(source.name.toLowerCase(), source.url);
      const rootHtml = String(res.data);

      const docHost = new URL(source.url).origin;
      const hrefMatches = [...rootHtml.matchAll(/href="(\/docs\/[a-z0-9\-_/]+)"/gi)];
      const pageUrls = [...new Set(hrefMatches.map((m) => new URL(m[1], docHost).href))]
        .filter((u) => !u.endsWith(".css") && !u.endsWith(".js") && !u.endsWith(".png"));

      if (!pageUrls.includes(source.url)) pageUrls.unshift(source.url);

      log.info("knowledge", `fetching ${pageUrls.length} doc pages for source "${source.name}"`);

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

function faqQuestions(programId = null) {
  const questions = [];
  const sources = programId
    ? [...(programs.get(programId)?.sources || []), ...programs.shared().sources]
    : loadSources();

  for (const source of sources) {
    if (!source || source.type !== "json-faq") continue;
    for (const line of (cache.get(source.name) || "").split("\n")) {
      const match = line.match(/^Q:\s*(.+)$/);
      if (match) questions.push(match[1].trim());
    }
  }
  return questions;
}

function getSourceUrl(label) {
  if (!label) return null;
  return linkCache.get(label.trim().toLowerCase()) || null;
}

const corpusCacheMap = new Map();
const corpusBuiltOnMap = new Map();
const retrievalIndexMap = new Map();

function today() {
  return new Date().toDateString();
}

function invalidate() {
  corpusCacheMap.clear();
  corpusBuiltOnMap.clear();
  retrievalIndexMap.clear();
}

function generatedSections(programId = null) {
  const prog = programs.get(programId);
  const sections = [];

  try {
    const identityText = require("./identity").corpusSection(prog);
    if (identityText) sections.push(["About pixie", identityText]);
  } catch (e) {
    log.warn("knowledge", `generated section "About pixie" failed: ${e.message}`);
  }

  try {
    const milestones = prog ? prog.milestones : programs.shared().milestones;
    const timelineText = require("./program").corpusSection(new Date(), milestones, prog);
    if (timelineText) sections.push(["Program timeline", timelineText]);
  } catch (e) {
    log.warn("knowledge", `generated section "Program timeline" failed: ${e.message}`);
  }

  try {
    const learnText = require("./learn").corpusSection(programId);
    if (learnText) sections.push(["Learned answers", learnText]);
  } catch (e) {
    log.warn("knowledge", `generated section "Learned answers" failed: ${e.message}`);
  }

  return sections;
}

function sourceSections(programId = null) {
  const prog = programs.get(programId);
  const progSources = prog ? prog.sources || [] : [];
  const sharedSources = programs.shared().sources || [];

  const combined = [...progSources, ...sharedSources];
  const seen = new Set();
  const result = [];

  for (const src of combined) {
    if (!src || !src.name || seen.has(src.name)) continue;
    seen.add(src.name);
    const text = cache.get(src.name);
    if (text) {
      result.push([src.name, text]);
    }
  }

  if (result.length === 0 && (!programId || programId === "pixl")) {
    return [...cache];
  }
  return result;
}

function buildCorpus(programId = null) {
  return [...generatedSections(programId), ...sourceSections(programId)]
    .map(([name, text]) => `### ${name}\n${text}`)
    .join("\n\n");
}

function getCorpus(programId = null) {
  const key = programId || "shared";
  const day = today();
  if (!corpusCacheMap.has(key) || corpusBuiltOnMap.get(key) !== day) {
    const text = buildCorpus(programId);
    corpusCacheMap.set(key, text);
    corpusBuiltOnMap.set(key, day);
  }
  return corpusCacheMap.get(key);
}

function getIndex(programId = null) {
  const key = programId || "shared";
  if (!retrievalIndexMap.has(key)) {
    const idx = retrieve.buildIndex(retrieve.chunkSections(sourceSections(programId)));
    retrievalIndexMap.set(key, idx);
    log.debug("knowledge", `retrieval index built for ${key} — ${idx.docs.length} chunks`);
  }
  return retrievalIndexMap.get(key);
}

function getContext(question, programId = null) {
  getCorpus(programId);

  const context = retrieve.selectContext({
    generated: generatedSections(programId),
    index: getIndex(programId),
    sources: sourceSections(programId),
    question,
  });

  const fullCorpus = getCorpus(programId);
  log.debug("knowledge", `context ${context.length} chars (corpus ${fullCorpus.length}) for program ${programId}`);
  return context;
}

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
  docTitleFromFilename,
  docSlugFromFilename,
  markdownFilesFromListing,
  dropSharedLines,
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
