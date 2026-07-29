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

async function fetchSourceText(source) {
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
      const annotated = annotateHeadingAnchors(String(res.data), source.url, linkCache);
      return stripHtml(annotated);
    }
    default:
      throw new Error(`unknown source type: ${source.type}`);
  }
}

async function refreshSource(source) {
  try {
    const text = await fetchSourceText(source);
    if (text) cache.set(source.name, text);
  } catch (e) {
    log.warn("knowledge", `failed to fetch "${source.name}": ${e.message} — serving last good copy`);
  }
}

// Looks up a human-facing URL for whatever section/source label a reply
// cites — exact case-insensitive match against known headings and source
// names. Returns null if nothing matches (e.g. FAQ answers, which have no
// human-friendly URL to link to).
function getSourceUrl(label) {
  if (!label) return null;
  return linkCache.get(label.trim().toLowerCase()) || null;
}

async function refreshCorpus() {
  const sources = loadSources();
  await Promise.all(sources.map(refreshSource));
  invalidate();
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
  getIndex,
  invalidate,
  getSourceUrl,
  startAutoRefresh,
  get lastBuiltAt() { return lastBuiltAt; },
};
