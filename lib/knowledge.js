// Fetches and caches pixie's knowledge base from the sources listed in
// programs.json and sources.json.
const fs = require("fs");
const path = require("path");
const axios = require("axios");
axios.defaults.headers.common["User-Agent"] = "PixieBot";
const retrieve = require("./retrieve");
const log = require("./log");
const programs = require("./programs");
const db = require("./db");
const answerCache = require("./cache");
const shop = require("./shop");
const liveShop = require("./liveShop");
const sourceGuard = require("./sourceGuard");
const firecrawl = require("./firecrawl");
const identity = require("./identity");
const programModule = require("./program");
// learn stays top-required for corpusSection: its knowledge dependency is lazy
// inside invalidateCorpus, so hoisting here forms no load-time cycle.
const learn = require("./learn");

const SOURCES_PATH = path.join(__dirname, "..", "sources.json");
const APP_ROOT = path.join(__dirname, "..");

// Five at a time: GitHub lists once against an unauthenticated rate limit and
// bodies come from a CDN, but doc subsites throttle aggressively — five keeps a
// 30-page refresh under a minute without tripping either.
const FETCH_BATCH_SIZE = 5;
// Ten seconds for the first fetch: docs CDNs answer fast or not at all.
const INITIAL_FETCH_TIMEOUT_MS = 10000;
// Fifteen seconds for subpages: rendered doc pages are heavier than the API
// listing that discovered them.
const SUBPAGE_FETCH_TIMEOUT_MS = 15000;
// A line on 60%+ of pages is chrome (sidebar nav, footer), not documentation.
// Needs at least three pages to tell the two apart.
const SHARED_CHROME_THRESHOLD = 0.6;
// Repo markdown carries unrendered {{rate}} templates; the rendered page is the
// only place real numbers exist. A page that still shows one was not
// interpolated — teaching it would invent numbers.
const UNRENDERED_PLACEHOLDER_RE = /\{\{[a-z0-9_]+\}\}/i;

// last good text per namespaced source key — a source that fails to fetch keeps
// serving its previous content instead of dropping out of the corpus.
const cache = new Map();
// lowercase label -> human-facing URL, for whichever section/source a reply
// cites. Populated per-heading (deep link) and per-source (fallback link).
const linkCache = new Map();
let lastBuiltAt = null;

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

/* ---------------------------------------------------------- pure helpers -- */

function loadSources() {
  const allSources = [];
  const seenUrls = new Set();

  const progs = [...programs.all(), programs.shared()];
  for (const prog of progs) {
    if (!Array.isArray(prog.sources)) continue;
    for (const src of prog.sources) {
      // A source needs a name and somewhere to get its text from. "Somewhere" is
      // a url for anything fetched, or inline content for a FAQ typed into the
      // wizard — which has no url at all, so requiring one here silently dropped
      // every inline source before it reached fetchSourceText.
      if (!src || !src.name) continue;
      const hasContent = src.content !== undefined && src.content !== null;
      if (!src.url && !hasContent) continue;
      // Inline sources key on the name alone: two of them are distinguishable
      // only by name, and `undefined` in the key would collapse them into one.
      const key = src.url ? `${src.name}::${src.url}` : `${src.name}::inline`;
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      allSources.push(src);
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
  const raw = String(url || "").replace(/^file:\/\//, "");
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(APP_ROOT, raw);
  // file:// sources come from operator-owned repo files, but the value still
  // flows from JSON config — a `..` or absolute path must not escape the app
  // root into /etc/passwd. Relative repo paths (./quick-links.json) resolve
  // inside and pass untouched.
  if (resolved !== APP_ROOT && !resolved.startsWith(APP_ROOT + path.sep)) {
    throw new Error(`refusing file source outside app root: ${String(url).slice(0, 80)}`);
  }
  return resolved;
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
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
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
  let content = html;
  const articleMatch = content.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || content.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch) {
    content = articleMatch[1];
  } else {
    content = content
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "");
  }

  content = content.replace(/<div[^>]*\bclass="(?:eyebrow|doc-foot|doc-sign)"[^>]*>[\s\S]*?<\/div>/gi, "");

  // 1. Direct headings with id: <h2 id="h-age">Age</h2>
  content = content.replace(
    /<h([1-6])[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gi,
    (match, level, id, headingInner) => {
      const headingText = headingInner.replace(/<[^>]+>/g, "").trim();
      if (!headingText) return match;
      if (links) links.set(headingText.toLowerCase(), `${baseUrl}#${id}`);
      return `\n\n## ${headingText} (${baseUrl}#${id})\n\n`;
    },
  );

  // 2. Headings wrapped in section or div with id
  content = content.replace(
    /<(?:section|div)[^>]*\bid="([^"]+)"[^>]*>[\s\S]{0,80}?<h([1-6])[^>]*>([\s\S]*?)<\/h\2>/gi,
    (match, id, level, headingInner) => {
      const headingText = headingInner.replace(/<[^>]+>/g, "").trim();
      if (!headingText) return match;
      if (links) links.set(headingText.toLowerCase(), `${baseUrl}#${id}`);
      return `\n\n## ${headingText} (${baseUrl}#${id})\n\n`;
    },
  );

  // 3. Plain headings without id
  content = content.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (match, level, headingInner) => {
      const headingText = headingInner.replace(/<[^>]+>/g, "").trim();
      if (!headingText) return match;
      return `\n\n## ${headingText}\n\n`;
    },
  );

  return content;
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
function dropSharedLines(pages, threshold = SHARED_CHROME_THRESHOLD) {
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
      .filter((l) => !l || !chrome.has(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n"),
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

// Storage key for one source's last-good text. Namespaced by location, not
// just name: two hosted programs can each have a "Docs" source pointing at
// different URLs, and a bare-name key would let one program's fetch overwrite
// the other's fallback. Identical name+URL shares the row, which is safe
// because the content is byte-identical by construction.
function sourceCacheKey(source) {
  if (!source || !source.name) return null;
  return source.url ? `${source.name}::${source.url}` : `${source.name}::inline`;
}

// In-memory twin of sourceCacheKey. The map used to be keyed by bare name, so
// two programs sharing a source name but not a URL overwrote each other and
// each program's corpus served the other's docs. Names are human labels and
// never contain "::", so the display name is the prefix before it.
function memKey(source) {
  return sourceCacheKey(source) || source.name;
}

function displayNameForMemKey(key) {
  const idx = String(key).indexOf("::");
  return idx === -1 ? String(key) : String(key).slice(0, idx);
}

function recordLink(label, url) {
  if (!label || !url) return;
  linkCache.set(String(label).toLowerCase(), url);
}

function getSourceUrl(label) {
  if (!label) return null;
  return linkCache.get(label.trim().toLowerCase()) || null;
}

/* ------------------------------------------------------------- fetch I/O -- */

function inlineText(source) {
  switch (source.type) {
    case "json-faq":
      // Accepts the same { faq: { items } } envelope a json-faq file uses, or a
      // bare items array, which is what a form posts.
      return textFromJsonFaq(Array.isArray(source.content) ? { faq: { items: source.content } } : source.content);
    case "gdoc":
    case "text":
      if (source.siteUrl) recordLink(source.name, source.siteUrl);
      return typeof source.content === "string" ? source.content.trim() : String(source.content);
    default:
      throw new Error(`inline content is not supported for type: ${source.type}`);
  }
}

function localFileText(source) {
  const raw = fs.readFileSync(resolveLocalPath(source.url), "utf8");
  if (source.type === "text" || source.type === "markdown") {
    if (source.siteUrl) recordLink(source.name, source.siteUrl);
    return raw.trim();
  }
  const data = JSON.parse(raw);
  switch (source.type) {
    case "json-faq":
      return textFromJsonFaq(data);
    case "gdoc":
      recordLink(source.name, source.url);
      return typeof data === "string" ? data.trim() : String(data);
    default:
      throw new Error(`unsupported type for local file: ${source.type}`);
  }
}

async function fetchGithubDir(source) {
  const res = await sourceGuard.fetchSourceUrl(source.url, { timeout: INITIAL_FETCH_TIMEOUT_MS });
  const files = markdownFilesFromListing(res.data, source.siteUrl);
  if (files.length === 0) throw new Error(`no markdown files listed at ${source.url}`);

  recordLink(source.name, source.siteUrl || source.url);
  log.info("knowledge", `fetching ${files.length} markdown file(s) for source "${source.name}"`);

  const sections = [];
  for (let i = 0; i < files.length; i += FETCH_BATCH_SIZE) {
    const batch = files.slice(i, i + FETCH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((file) => fetchGithubFile(file, source.name)));
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

async function fetchGithubFile(file, sourceName) {
  try {
    const fileRes = await sourceGuard.fetchSourceUrl(file.contentUrl, { timeout: SUBPAGE_FETCH_TIMEOUT_MS });
    const raw = typeof fileRes.data === "string" ? fileRes.data : String(fileRes.data);
    const body = file.isHtml
      ? stripHtml(annotateHeadingAnchors(raw, file.pageUrl, linkCache)).trim()
      : raw.trim();
    if (!body) return null;
    if (UNRENDERED_PLACEHOLDER_RE.test(body)) {
      log.warn("knowledge", `skipping ${file.name} for "${sourceName}": unrendered placeholders`);
      return null;
    }
    recordLink(file.title, file.pageUrl);
    return { title: file.title, pageUrl: file.pageUrl, body };
  } catch (e) {
    log.warn("knowledge", `failed to fetch ${file.name} for "${sourceName}": ${e.message}`);
    return null;
  }
}

// A url-source is crawled, not fetched once: a rendered docs site links its
// pages from a sidebar that repeats on every page, and following those links
// recursively is the only way to get the whole tree. Bounded so a
// misconfigured root can't walk a whole site.
const CRAWL_MAX_PAGES = 80;
const CRAWL_MAX_DEPTH = 4;
// A rendered docs site serves HTML routes; a link to a raw .md or an asset is
// a stray reference (often a stale export artifact), not another doc page.
const ASSET_RE = /\.(?:css|js|mjs|json|md|txt|xml|rss|png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|webm)$/i;

function normalizePath(p) {
  return String(p || "/").replace(/\/+$/, "") || "/";
}

// One canonical form per page: no fragment, no query, no trailing slash, so
// /docs/ai, /docs/ai/ and /docs/ai#top are one crawl target, not three.
function canonicalUrl(href, base) {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  u.hash = "";
  u.search = "";
  u.pathname = normalizePath(u.pathname);
  return u.href;
}

// Which same-origin paths this source's crawl may follow. Default is the /docs
// tree (a rendered docs site keeps its pages there) plus the root URL's own
// path. Naming `paths` replaces the /docs default, so a landing-page source
// (`url: "https://x/"`, `paths: ["/rubric"]`) stays on the root and /rubric
// instead of dragging in an unrelated /docs tree.
function crawlPrefixes(source) {
  const rootPath = normalizePath(new URL(source.url).pathname);
  const configured = Array.isArray(source.paths) && source.paths.length
    ? source.paths.map(normalizePath)
    : null;
  const set = new Set([...(configured || ["/docs"]), rootPath].filter((p) => p && p !== "/"));
  return [...set];
}

function inScope(href, base, origin, prefixes) {
  const canon = canonicalUrl(href, base);
  if (!canon) return null;
  const u = new URL(canon);
  if (u.origin !== origin || ASSET_RE.test(u.pathname)) return null;
  const hit = prefixes.some((prefix) => u.pathname === prefix || u.pathname.startsWith(`${prefix}/`));
  return hit ? canon : null;
}

// Same-origin links out of a page, from HTML hrefs and markdown link targets
// alike — Firecrawl hands back markdown, the SSRF guard hands back HTML. The
// capture stops at a fragment or query so /docs/x#frag and /docs/x?y=1 both
// resolve to /docs/x.
function linksFrom(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/href="([^"#?\s]+)/gi)) found.add(m[1]);
  for (const m of String(text).matchAll(/\]\(([^)#?\s]+)/g)) found.add(m[1]);
  return [...found].filter(Boolean);
}

function titleFromUrl(pageUrl) {
  const seg = normalizePath(new URL(pageUrl).pathname).split("/").filter(Boolean).pop();
  if (!seg) return "Overview";
  return seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// One page: JS-rendered markdown via Firecrawl when configured, SSRF-guarded
// raw HTML otherwise. `raw` is whatever came back, kept so the crawler can mine
// it for the next hop's links. Every request goes through the guard or
// Firecrawl — never a bare axios.get.
async function fetchCrawlPage(pageUrl, force) {
  const title = titleFromUrl(pageUrl);
  if (firecrawl.getApiKey()) {
    try {
      const md = await firecrawl.scrapeUrl(pageUrl, { skipCache: force });
      if (md) {
        recordLink(title, pageUrl);
        return { content: `## ${title} (${pageUrl})\n\n${md}`, raw: md };
      }
    } catch (e) {
      log.warn("knowledge", `firecrawl scrape failed for ${pageUrl}, falling back to guard: ${e.message}`);
    }
  }
  const res = await sourceGuard.fetchSourceUrl(pageUrl, { timeout: SUBPAGE_FETCH_TIMEOUT_MS });
  const html = String(res.data);
  return { content: stripHtml(annotateHeadingAnchors(html, pageUrl, linkCache)), raw: html };
}

function nextHops(hrefs, base, origin, prefixes, seen) {
  const hops = [];
  for (const href of hrefs) {
    const canon = inScope(href, base, origin, prefixes);
    if (canon && !seen.has(canon)) {
      seen.add(canon);
      hops.push(canon);
    }
  }
  return hops;
}

async function fetchUrlSource(source, force) {
  recordLink(source.name, source.siteUrl || source.url);
  const rootUrl = canonicalUrl(source.url, source.url);
  const origin = new URL(rootUrl).origin;
  const prefixes = crawlPrefixes(source);

  // Root first, and unguarded by try/catch on purpose: a hard failure here
  // (rate limit, DNS) must propagate so refreshSource keeps the last good copy
  // instead of replacing the corpus with nothing.
  const seen = new Set([rootUrl]);
  const first = await fetchCrawlPage(rootUrl, force);
  const pages = [first.content];
  let frontier = nextHops(linksFrom(first.raw), rootUrl, origin, prefixes, seen);

  for (let depth = 1; depth <= CRAWL_MAX_DEPTH && frontier.length && pages.length < CRAWL_MAX_PAGES; depth++) {
    const discovered = [];
    for (let i = 0; i < frontier.length && pages.length < CRAWL_MAX_PAGES; i += FETCH_BATCH_SIZE) {
      const batch = frontier.slice(i, i + FETCH_BATCH_SIZE);
      const results = await Promise.all(batch.map(async (url) => {
        try {
          return { url, ...(await fetchCrawlPage(url, force)) };
        } catch (e) {
          log.warn("knowledge", `failed to crawl ${url} for "${source.name}": ${e.message}`);
          return null;
        }
      }));
      for (const r of results) {
        if (!r) continue;
        if (r.content) pages.push(r.content);
        discovered.push(...nextHops(linksFrom(r.raw), r.url, origin, prefixes, seen));
      }
    }
    frontier = discovered;
  }

  const kept = pages.filter((p) => p && p.trim());
  // Throwing keeps the previous good text in cache rather than replacing a
  // working corpus with an empty one.
  if (kept.length === 0) throw new Error(`no pages crawled for ${source.url}`);
  log.info("knowledge", `crawled ${kept.length} page(s) for source "${source.name}"`);

  // Every rendered page repeats the sidebar nav and footer; frequency separates
  // that chrome from real content, same as the github-dir path does.
  return dropSharedLines(kept).filter(Boolean).join("\n\n");
}

async function fetchSourceText(source, force = false) {
  // Content carried in the config itself rather than fetched. A fleet bot's FAQ
  // is typed into the wizard and arrives inside PIXIE_PROGRAMS_JSON — there is no
  // file in the shared image to point a file:// URL at, and no URL to GET.
  //
  // Checked before `source.url` is touched at all, because an inline source
  // legitimately has no url — reading .startsWith on it first would throw.
  if (source.content !== undefined && source.content !== null) return inlineText(source);
  if (!source.url) throw new Error(`source "${source.name}" has neither a url nor inline content`);
  if (source.url.startsWith("file://")) return localFileText(source);

  // Not a document: the catalogue and the payout config come from two
  // endpoints and get rendered by lib/shop.js, which also keeps the parsed
  // copy the price maths answers from.
  if (source.type === "pixl-shop") {
    recordLink(source.name, source.siteUrl || "https://pixl.hackclub.com/shop");
    return shop.refreshText();
  }
  if (source.type === "live-shop") {
    recordLink(source.name, source.siteUrl || source.url);
    return liveShop.refreshText(source.url);
  }

  if (source.type === "json-faq") {
    const res = await sourceGuard.fetchSourceUrl(source.url, { timeout: INITIAL_FETCH_TIMEOUT_MS });
    return textFromJsonFaq(res.data);
  }
  if (source.type === "gdoc") {
    const res = await sourceGuard.fetchSourceUrl(source.url, { timeout: INITIAL_FETCH_TIMEOUT_MS });
    recordLink(source.name, source.url);
    return typeof res.data === "string" ? res.data.trim() : String(res.data);
  }
  if (source.type === "github-dir") return fetchGithubDir(source);
  if (source.type === "url") return fetchUrlSource(source, force);
  throw new Error(`unknown source type: ${source.type}`);
}

/* ------------------------------------------------------------ persist I/O -- */

// "Serving last good copy" used to mean the Map above, which is empty for the
// first few seconds of every process. api.github.com rate-limits by IP and
// Railway's egress IP is shared, so a deploy landing inside a rate-limited
// window brought pixie up with no docs at all until the next half-hourly
// refresh. The copy on the volume is what makes that sentence true.
//
// Reads the namespaced key first, then the legacy bare-name row written before
// namespacing existed — pre-migration deployments keep their fallback.
function restoreFromDisk(source) {
  const key = sourceCacheKey(source);
  const names = key && key !== source.name ? [key, source.name] : [source.name];
  for (const name of names) {
    try {
      const stored = db.loadSourceText(name);
      if (!stored?.text) continue;
      cache.set(memKey(source), stored.text);
      const ageMin = Math.round((Date.now() - stored.fetchedAt) / 60000);
      log.info("knowledge", `restored "${source.name}" from disk (fetched ${ageMin} min ago)`);
      return true;
    } catch (e) {
      log.debug("knowledge", `no stored copy for "${name}": ${e.message}`);
    }
  }
  return false;
}

function persistSourceText(source, text) {
  try {
    const key = sourceCacheKey(source) || source.name;
    db.saveSourceText(key, text);
    // A legacy bare-name row for a now-namespaced source is stale the moment
    // the namespaced write lands — remove it so fallback reads can't serve
    // another program's copy under the same name.
    if (key !== source.name) {
      try { db.handle().query("DELETE FROM source_cache WHERE name = ?").run(source.name); } catch (_) {}
    }
  } catch (e) {
    // A corpus that can't be persisted is still a corpus. Worth knowing
    // about, not worth failing the refresh over.
    log.warn("knowledge", `could not persist "${source.name}": ${e.message}`);
  }
}

async function refreshSource(source, force = false) {
  try {
    const text = await fetchSourceText(source, force);
    if (!text) return;
    cache.set(memKey(source), text);
    persistSourceText(source, text);
  } catch (e) {
    const restored = cache.has(memKey(source)) || restoreFromDisk(source);
    const tail = restored ? "serving last good copy" : "and there is no stored copy to fall back on";
    log.warn("knowledge", `failed to fetch "${source.name}": ${e.message} — ${tail}`);
    try {
      db.recordSourceFailure(sourceCacheKey(source) || source.name, e.message);
    } catch (_) {}
  }
}

function faqQuestions(programId = null) {
  const questions = [];
  const prog = programId ? programs.get(programId) : null;
  const shared = prog && prog.sharedSources === false ? [] : programs.shared().sources;
  const sources = prog ? [...(prog.sources || []), ...shared] : loadSources();

  for (const source of sources) {
    if (!source || source.type !== "json-faq") continue;
    let text = cache.get(memKey(source));
    if (!text && restoreFromDisk(source)) {
      text = cache.get(memKey(source));
    }
    for (const line of (text || "").split("\n")) {
      const match = line.match(/^Q:\s*(.+)$/);
      if (match) questions.push(match[1].trim());
    }
  }
  return questions;
}

/* --------------------------------------------------------------- corpus -- */

function generatedSections(programId = null) {
  const prog = programs.get(programId);
  const sections = [];

  try {
    const identityText = identity.corpusSection(prog);
    if (identityText) sections.push(["About pixie", identityText]);
  } catch (e) {
    log.warn("knowledge", `generated section "About pixie" failed: ${e.message}`);
  }

  try {
    const milestones = prog ? prog.milestones : programs.shared().milestones;
    const timelineText = programModule.corpusSection(new Date(), milestones, prog);
    if (timelineText) sections.push(["Program timeline", timelineText]);
  } catch (e) {
    log.warn("knowledge", `generated section "Program timeline" failed: ${e.message}`);
  }

  try {
    const learnText = learn.corpusSection(programId);
    if (learnText) sections.push(["Learned answers", learnText]);
  } catch (e) {
    log.warn("knowledge", `generated section "Learned answers" failed: ${e.message}`);
  }

  return sections;
}

function memText(source) {
  let text = cache.get(memKey(source));
  if (!text && restoreFromDisk(source)) {
    text = cache.get(memKey(source));
  }
  return text || null;
}

function sourceSections(programId = null) {
  const prog = programs.get(programId);
  const progSources = prog ? prog.sources || [] : [];
  const sharedSources = prog && prog.sharedSources === false ? [] : programs.shared().sources || [];

  // Dedupe by display name so a program source shadows the shared source it
  // replaces — both are still fetched (loadSources keeps both by name::url),
  // but the model sees one "Docs" section, looked up by its own namespaced key.
  const combined = [...progSources, ...sharedSources];
  const seen = new Set();
  const result = [];

  for (const src of combined) {
    if (!src || !src.name || seen.has(src.name)) continue;
    seen.add(src.name);
    const text = memText(src);
    if (text) result.push([src.name, text]);
  }

  if (result.length === 0 && (!programId || programId === "pixl")) {
    return [...cache.entries()].map(([k, v]) => [displayNameForMemKey(k), v]);
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

// Sources this question has no business seeing. The shop catalogue is live
// price data, not documentation: it matches on the item name alone, so without
// this it reaches the model for every message that mentions something on the
// shelf and pixie volunteers a price nobody asked for. lib/shop.js answers the
// questions that genuinely are about prices before the model is ever called.
function excludedSources(programId, question) {
  const prog = programs.get(programId);
  const all = [...(prog?.sources || []), ...(programs.shared().sources || [])];
  const shopSources = all.filter((s) => s && (s.type === "pixl-shop" || s.type === "live-shop"));
  if (shopSources.length === 0) return null;
  if (shop.isShopQuestion(question)) return null;
  return new Set(shopSources.map((s) => s.name));
}

function getContext(question, programId = null) {
  getCorpus(programId);

  const context = retrieve.selectContext({
    generated: generatedSections(programId),
    index: getIndex(programId),
    sources: sourceSections(programId),
    question,
    exclude: excludedSources(programId, question),
  });

  const fullCorpus = getCorpus(programId);
  log.debug("knowledge", `context ${context.length} chars (corpus ${fullCorpus.length}) for program ${programId}`);
  return context;
}

async function refreshCorpus(force = false) {
  const sources = loadSources();
  const validKeys = new Set(sources.map((s) => memKey(s)));
  for (const key of cache.keys()) {
    if (!validKeys.has(key)) cache.delete(key);
  }
  await Promise.all(sources.map((source) => refreshSource(source, force)));
  invalidate();
  try {
    answerCache.clearCache();
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
  fetchSourceText,
  dropSharedLines,
  refreshCorpus,
  refreshSource,
  restoreFromDisk,
  sourceCacheKey,
  getCorpus,
  getContext,
  faqQuestions,
  getIndex,
  invalidate,
  getSourceUrl,
  startAutoRefresh,
  generatedSections,
  excludedSources,
  get lastBuiltAt() { return lastBuiltAt; },
};
