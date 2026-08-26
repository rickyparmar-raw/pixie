const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  textFromJsonFaq,
  stripHtml,
  preserveLinks,
  annotateHeadingAnchors,
  docTitleFromFilename,
  markdownFilesFromListing,
  dropSharedLines,
} = require("./knowledge");

test("textFromJsonFaq extracts question/answer pairs", () => {
  const data = {
    faq: {
      items: [
        { question: "Who can join?", answer: "Teen hackers and curious friends." },
        { question: "Is this free?", answer: "Yes, 100% free." },
      ],
    },
  };

  const text = textFromJsonFaq(data);
  assert.match(text, /Q: Who can join\?\nA: Teen hackers and curious friends\./);
  assert.match(text, /Q: Is this free\?\nA: Yes, 100% free\./);
});

test("textFromJsonFaq returns empty string when faq.items is missing", () => {
  assert.equal(textFromJsonFaq({}), "");
  assert.equal(textFromJsonFaq({ faq: {} }), "");
});

test("stripHtml removes tags and decodes entities", () => {
  const html = "<div>Hello &amp; <strong>welcome</strong></div><script>evil()</script>";
  const text = stripHtml(html);
  assert.equal(text, "Hello & welcome");
});

// Tag stripping used to discard hrefs entirely, so a doc that linked out to
// setup instructions became a dead sentence in the corpus.
test("preserveLinks keeps the href alongside the link text", () => {
  const html = '<p>See <a href="https://example.com/setup">the setup guide</a> first.</p>';
  assert.match(preserveLinks(html), /the setup guide \(https:\/\/example\.com\/setup\)/);
});

test("preserveLinks drops in-page and javascript hrefs but keeps the text", () => {
  assert.match(preserveLinks('<a href="#top">Back to top</a>'), /Back to top/);
  assert.doesNotMatch(preserveLinks('<a href="#top">Back to top</a>'), /\(#top\)/);
  assert.doesNotMatch(preserveLinks('<a href="javascript:void(0)">Click</a>'), /javascript/i);
});

test("preserveLinks does not print the URL twice when it is already the label", () => {
  const html = '<a href="https://play.pixl.rsvp/">https://play.pixl.rsvp/</a>';
  assert.equal(preserveLinks(html).trim(), "https://play.pixl.rsvp/");
});

test("stripHtml surfaces link targets in the final corpus text", () => {
  const html = '<div>Play at <a href="https://play.pixl.rsvp/">the game</a>.</div>';
  assert.equal(stripHtml(html), "Play at the game (https://play.pixl.rsvp/) .");
});

// A URL inside a <script> string must not be promoted into a real link.
test("stripHtml removes script contents before link rewriting", () => {
  const html = '<script>var a = \'<a href="https://evil.example">x</a>\';</script><p>hi</p>';
  assert.equal(stripHtml(html), "hi");
});

test("annotateHeadingAnchors tags anchored sections with a deep link and records it", () => {
  const html = '<section id="react-native"><h1>React Native app guide</h1><p>Use Expo.</p></section>';
  const links = new Map();
  const annotated = annotateHeadingAnchors(html, "https://example.com/docs", links);

  assert.match(annotated, /## React Native app guide \(https:\/\/example\.com\/docs#react-native\)/);
  assert.match(annotated, /Use Expo\./);
  assert.equal(links.get("react native app guide"), "https://example.com/docs#react-native");
});

test("annotateHeadingAnchors leaves a section untouched if it has no heading", () => {
  const html = '<section id="empty"><p>No heading here.</p></section>';
  const links = new Map();
  const annotated = annotateHeadingAnchors(html, "https://example.com/docs", links);

  assert.equal(links.size, 0);
  assert.match(annotated, /No heading here\./);
});

test("annotateHeadingAnchors handles a div wrapper with a nested eyebrow label without picking the label as the heading", () => {
  const html = '<div class="hero doc-page" id="welcome"><div class="eyebrow">Start here</div><h1>Welcome to Pixl</h1><p class="lead">So here\'s the deal.</p></div>';
  const links = new Map();
  const annotated = annotateHeadingAnchors(html, "https://example.com/docs", links);

  assert.match(annotated, /## Welcome to Pixl \(https:\/\/example\.com\/docs#welcome\)/);
  assert.doesNotMatch(annotated, /Start here/);
  assert.equal(links.get("welcome to pixl"), "https://example.com/docs#welcome");
  assert.equal(links.has("start here"), false);
});

// The Pixl docs live as 30 numbered markdown files in a GitHub directory
// (010-welcome.md, 040-rules.md, …). None of the existing source types could
// read that shape: json-faq wants a JSON envelope, gdoc wants one document,
// and url crawls <a href="/docs/…"> out of rendered HTML. Hence github-dir.
test("docTitleFromFilename turns a numbered doc filename into a heading", () => {
  assert.equal(docTitleFromFilename("010-welcome.md"), "Welcome");
  assert.equal(docTitleFromFilename("100-first-project.md"), "First Project");
  assert.equal(docTitleFromFilename("270-pixel-art.md"), "Pixel Art");
});

test("docTitleFromFilename copes with no numeric prefix and odd separators", () => {
  assert.equal(docTitleFromFilename("shop.md"), "Shop");
  assert.equal(docTitleFromFilename("020_get_started.md"), "Get Started");
});

test("markdownFilesFromListing keeps only markdown files, in filename order", () => {
  const listing = [
    { type: "file", name: "040-rules.md", download_url: "https://raw/40", html_url: "https://gh/40" },
    { type: "dir", name: "superpowers", download_url: null },
    { type: "file", name: "010-welcome.md", download_url: "https://raw/10", html_url: "https://gh/10" },
    { type: "file", name: "logo.png", download_url: "https://raw/png" },
  ];

  const files = markdownFilesFromListing(listing);

  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.name), ["010-welcome.md", "040-rules.md"]);
  assert.equal(files[0].title, "Welcome");
  assert.equal(files[0].pageUrl, "https://gh/10");
});

// A file with no download_url cannot be fetched; including it would produce an
// empty section that reads to the model as "this topic is documented as blank".
test("markdownFilesFromListing drops entries with no download_url and non-arrays", () => {
  assert.deepEqual(markdownFilesFromListing([{ type: "file", name: "a.md" }]), []);
  assert.deepEqual(markdownFilesFromListing(null), []);
  assert.deepEqual(markdownFilesFromListing({ message: "Not Found" }), []);
});

// Citations are more useful pointing at the rendered docs site than at raw
// GitHub, and the site slug is just the filename minus its ordering prefix:
// 270-pixel-art.md -> pixl.hackclub.com/docs/pixel-art.
test("markdownFilesFromListing builds site URLs from a siteUrl base", () => {
  const listing = [
    { type: "file", name: "270-pixel-art.md", download_url: "https://raw/270", html_url: "https://gh/270" },
    { type: "file", name: "020_get_started.md", download_url: "https://raw/20", html_url: "https://gh/20" },
  ];

  const files = markdownFilesFromListing(listing, "https://pixl.hackclub.com/docs/");

  assert.equal(files[0].pageUrl, "https://pixl.hackclub.com/docs/get-started");
  assert.equal(files[1].pageUrl, "https://pixl.hackclub.com/docs/pixel-art");
});

test("markdownFilesFromListing falls back to the GitHub URL with no siteUrl", () => {
  const listing = [{ type: "file", name: "010-welcome.md", download_url: "https://raw/10", html_url: "https://gh/10" }];
  assert.equal(markdownFilesFromListing(listing)[0].pageUrl, "https://gh/10");
});

// The repo markdown is a template: rates render as {{basePx}}, tiers as {{t1}}.
// Feeding that to the model produced invented numbers ("10 pixels an hour"),
// so when a siteUrl is configured the body must come from the rendered page.
// GitHub stays the index only -- /docs on the site is a redirect stub with a
// single href, so it cannot enumerate the pages itself.
test("markdownFilesFromListing reads bodies from the site when siteUrl is set", () => {
  const listing = [{ type: "file", name: "150-energy.md", download_url: "https://raw/150", html_url: "https://gh/150" }];

  const [file] = markdownFilesFromListing(listing, "https://pixl.hackclub.com/docs");

  assert.equal(file.contentUrl, "https://pixl.hackclub.com/docs/energy");
  assert.equal(file.isHtml, true);
});

test("markdownFilesFromListing reads raw markdown when no siteUrl is set", () => {
  const listing = [{ type: "file", name: "150-energy.md", download_url: "https://raw/150", html_url: "https://gh/150" }];

  const [file] = markdownFilesFromListing(listing);

  assert.equal(file.contentUrl, "https://raw/150");
  assert.equal(file.isHtml, false);
});

// Every rendered docs page carries the full sidebar nav — ~700 chars of other
// pages' titles. Across 30 pages that is ~20KB of noise that makes every page
// look keyword-relevant to every question, which is what pushed the rates
// question off its own section.
test("dropSharedLines removes chrome repeated across pages, keeps unique content", () => {
  const pages = [
    "PIXL DOCS\nWelcome to Pixl (/docs/welcome/)\nIt starts at 50 px an hour",
    "PIXL DOCS\nWelcome to Pixl (/docs/welcome/)\nShips need a journal",
    "PIXL DOCS\nWelcome to Pixl (/docs/welcome/)\nBans are permanent",
  ];

  const out = dropSharedLines(pages);

  assert.equal(out[0], "It starts at 50 px an hour");
  assert.equal(out[1], "Ships need a journal");
  assert.equal(out[2], "Bans are permanent");
});

test("dropSharedLines keeps a line that only most pages share below threshold", () => {
  const pages = ["a\nkeep me", "b\nkeep me", "c\nunique", "d\nunique2", "e\nunique3"];
  const out = dropSharedLines(pages);
  assert.match(out[0], /keep me/);
});

// Too few pages to tell chrome from a genuinely repeated sentence.
test("dropSharedLines is a no-op for fewer than three pages", () => {
  const pages = ["PIXL DOCS\nonly page", "PIXL DOCS\nsecond page"];
  assert.deepEqual(dropSharedLines(pages), pages);
});

/* ------------------------------------------------ fetch failure fallback -- */
// The 403 that started this: api.github.com rate-limits by IP, Railway's egress
// IP is shared, and a deploy restarts the container. Fetch fails, the in-memory
// "last good copy" is empty because the process is seconds old, and pixie comes
// up answering every docs question with nothing. The copy on disk is what makes
// the fallback in the log message actually true.
test("a source that fails to fetch falls back to the copy on disk", async () => {
  const db = require("./db");
  const knowledge = require("./knowledge");
  const axios = require("axios");

  db.saveSourceText("Flaky Source", "the deadline is august 18");

  const realGet = axios.get;
  axios.get = async () => {
    const err = new Error("Request failed with status code 403");
    err.response = { status: 403 };
    throw err;
  };

  try {
    await knowledge.refreshSource({ name: "Flaky Source", type: "url", url: "https://example.com/docs" });
    assert.match(knowledge.getCorpus(), /the deadline is august 18/);
  } finally {
    axios.get = realGet;
  }
});

// The shop is not a document: knowledge.js hands the whole fetch to lib/shop.js
// and takes back rendered text, so the catalogue lands in the corpus the same
// way a docs page does and the parsed copy stays available for the price maths.
test("a pixl-shop source is rendered by lib/shop.js", async () => {
  const knowledge = require("./knowledge");
  const shop = require("./shop");
  const original = shop.refreshText;
  shop.refreshText = async () => "Catalogue:\n- Test Widget — 700 px";
  try {
    const text = await knowledge.fetchSourceText({
      name: "Pixl Shop",
      type: "pixl-shop",
      url: "https://server.pixl.hackclub.com/api/shop/items",
      siteUrl: "https://pixl.hackclub.com/shop",
    });
    assert.match(text, /Test Widget/);
    assert.equal(knowledge.getSourceUrl("Pixl Shop"), "https://pixl.hackclub.com/shop");
  } finally {
    shop.refreshText = original;
  }
});
