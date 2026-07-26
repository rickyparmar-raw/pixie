// Fetches and caches pixie's knowledge base from the sources listed in
// sources.json. Add a new doc by adding one entry there — no code changes.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const SOURCES_PATH = path.join(__dirname, "..", "sources.json");

// last good text per source name — a source that fails to fetch keeps
// serving its previous content instead of dropping out of the corpus.
const cache = new Map();
// lowercase label -> human-facing URL, for whichever section/source a reply
// cites. Populated per-heading (deep link) and per-source (fallback link).
const linkCache = new Map();
let lastBuiltAt = null;

function loadSources() {
  const raw = fs.readFileSync(SOURCES_PATH, "utf8");
  return JSON.parse(raw);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
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
  // Handle local file:// URLs
  if (source.url.startsWith("file://")) {
    const filePath = source.url.replace("file://", "");
    const raw = fs.readFileSync(filePath, "utf8");
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
    console.error(`[pixie/knowledge] failed to fetch "${source.name}": ${e.message}`);
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
  lastBuiltAt = new Date();
  console.log(`[pixie/knowledge] corpus refreshed — ${cache.size}/${sources.length} sources loaded`);
}

function getCorpus() {
  const sections = [];
  for (const [name, text] of cache) {
    sections.push(`### ${name}\n${text}`);
  }
  return sections.join("\n\n");
}

function startAutoRefresh(intervalMin) {
  const ms = intervalMin * 60 * 1000;
  return setInterval(() => {
    refreshCorpus().catch((e) => console.error("[pixie/knowledge] refresh failed:", e.message));
  }, ms);
}

module.exports = {
  loadSources,
  textFromJsonFaq,
  stripHtml,
  annotateHeadingAnchors,
  refreshCorpus,
  getCorpus,
  getSourceUrl,
  startAutoRefresh,
  get lastBuiltAt() { return lastBuiltAt; },
};
