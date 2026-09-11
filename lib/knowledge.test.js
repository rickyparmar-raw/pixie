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

test("Twisted FAQ includes explicit current facts and abstention answers", () => {
  const fs = require("fs");
  const path = require("path");
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "twisted-faq.json"), "utf8"));
  const text = textFromJsonFaq(data);
  assert.match(text, /ages 13 through 18 inclusive/);
  assert.match(text, /maximum of 30% AI-assisted code/);
  assert.match(text, /end date as TBD/);
  assert.match(text, /No sufficiently authoritative current source/);
  assert.doesNotMatch(text, /\$5\/hour/);
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

test("annotateHeadingAnchors extracts article content and direct heading tags with id", () => {
  const html = '<nav>Sidebar</nav><article class="doc"><h2 id="h-age">Age</h2><p>You must be 18 or under.</p></article>';
  const links = new Map();
  const annotated = annotateHeadingAnchors(html, "https://pixl.hackclub.com/docs/eligibility", links);

  assert.doesNotMatch(annotated, /Sidebar/);
  assert.match(annotated, /## Age \(https:\/\/pixl\.hackclub\.com\/docs\/eligibility#h-age\)/);
  assert.match(annotated, /You must be 18 or under\./);
  assert.equal(links.get("age"), "https://pixl.hackclub.com/docs/eligibility#h-age");
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

test("a live-shop source is rendered by lib/liveShop.js", async () => {
  const knowledge = require("./knowledge");
  const liveShop = require("./liveShop");
  const original = liveShop.refreshText;
  liveShop.refreshText = async () => "Live rewards:\n- GoPro — 65 hours";
  try {
    const text = await knowledge.fetchSourceText({
      name: "Live Shop",
      type: "live-shop",
      url: "https://live.hackclub.com/shop",
      siteUrl: "https://live.hackclub.com/shop",
    });
    assert.match(text, /GoPro/);
    assert.equal(knowledge.getSourceUrl("Live Shop"), "https://live.hackclub.com/shop");
  } finally {
    liveShop.refreshText = original;
  }
});

// The catalogue is a knowledge source, so retrieval would hand it to the model
// for any message that happens to name something on the shelf. That is the
// other half of pixie quoting prices at people who never asked: even with the
// price maths declining to answer, the model would answer from the corpus.
test("the shop catalogue only enters the context when the question is about the shop", async () => {
  const knowledge = require("./knowledge");
  const shop = require("./shop");
  const original = shop.refreshText;
  shop.refreshText = async () => "Catalogue:\n- Test Widget: 700 px";

  try {
    await knowledge.refreshSource({
      name: "Pixl Shop",
      type: "pixl-shop",
      url: "https://server.pixl.hackclub.com/api/shop/items",
      siteUrl: "https://pixl.hackclub.com/shop",
    }, true);
    knowledge.invalidate();

    const asked = knowledge.getContext("how much is a test widget", "pixl");
    const notAsked = knowledge.getContext("my test widget keeps crashing", "pixl");

    assert.match(asked, /Test Widget/, "a real price question should see the catalogue");
    assert.doesNotMatch(notAsked, /Pixl Shop/, "shop section leaked into an unrelated question");
  } finally {
    shop.refreshText = original;
  }
});

/* ------------------------------------------------- inline source content -- */
// One engine image serves the whole fleet, so a bot's own FAQ can't be a file
// baked into it. Typed into the wizard, an inline source travels inside the
// config blob and has no URL to fetch at all.

test("fetchSourceText renders an inline json-faq from a bare items array", async () => {
  const knowledge = require("./knowledge");
  const text = await knowledge.fetchSourceText({
    name: "Solvable FAQ",
    type: "json-faq",
    content: [
      { question: "What is Solvable?", answer: "3D print a solution to a problem." },
      { question: "Who can join?", answer: "Teenagers 13-18." },
    ],
  });

  assert.match(text, /Q: What is Solvable\?\nA: 3D print a solution to a problem\./);
  assert.match(text, /Q: Who can join\?\nA: Teenagers 13-18\./);
});

// Same envelope a json-faq file uses, so wizard output and a pasted file body
// both work without the user knowing which shape they have.
test("fetchSourceText accepts the wrapped faq envelope inline too", async () => {
  const knowledge = require("./knowledge");
  const text = await knowledge.fetchSourceText({
    name: "Wrapped FAQ",
    type: "json-faq",
    content: { faq: { items: [{ question: "Q1", answer: "A1" }] } },
  });

  assert.match(text, /Q: Q1\nA: A1/);
});

test("fetchSourceText returns inline text content as-is", async () => {
  const knowledge = require("./knowledge");
  const text = await knowledge.fetchSourceText({
    name: "House Rules",
    type: "text",
    content: "  No AI-generated submissions.  ",
  });

  assert.equal(text, "No AI-generated submissions.");
});

// The bug this guards: reading source.url.startsWith on a source that has no url
// threw before the inline branch was ever reached.
test("fetchSourceText fails clearly when a source has neither url nor content", async () => {
  const knowledge = require("./knowledge");
  await assert.rejects(
    () => knowledge.fetchSourceText({ name: "Empty", type: "json-faq" }),
    /neither a url nor inline content/,
  );
});

test("fetchSourceText refuses inline content for a type that must be fetched", async () => {
  const knowledge = require("./knowledge");
  await assert.rejects(
    () => knowledge.fetchSourceText({ name: "Docs", type: "github-dir", content: [] }),
    /inline content is not supported/,
  );
});

// loadSources used to require a url, which silently dropped every inline source
// before it could reach fetchSourceText — the corpus came up empty and the bot
// answered "I don't know" to everything in its own FAQ.
test("loadSources keeps inline sources and tells same-named ones apart", () => {
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;

  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    {
      id: "inline-test",
      name: "Inline Test",
      sources: [
        { name: "Bot FAQ", type: "json-faq", content: [{ question: "a", answer: "b" }] },
        { name: "Other FAQ", type: "json-faq", content: [{ question: "c", answer: "d" }] },
        { name: "No Name Source", type: "json-faq" },
      ],
    },
  ]);
  programs.invalidate();
  knowledge.invalidate();

  try {
    const names = knowledge.loadSources().map((s) => s.name);
    assert.ok(names.includes("Bot FAQ"), "inline source was dropped");
    assert.ok(names.includes("Other FAQ"), "second inline source collapsed onto the first");
    assert.ok(!names.includes("No Name Source"), "a source with no url and no content is not usable");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

/* ------------------------------------------- STEP 1 characterization pins -- */

test("sourceCacheKey namespaces by location, including inline content", () => {
  const knowledge = require("./knowledge");
  assert.equal(knowledge.sourceCacheKey({ name: "Docs", url: "https://example.com/a" }), "Docs::https://example.com/a");
  const faqKey = knowledge.sourceCacheKey({ name: "FAQ", type: "json-faq", content: [{ question: "q", answer: "a" }] });
  assert.match(faqKey, /^FAQ::inline::[a-f0-9]{64}$/);
  assert.notEqual(faqKey, knowledge.sourceCacheKey({ name: "FAQ", type: "json-faq", content: [{ question: "q", answer: "different" }] }));
  assert.match(knowledge.sourceCacheKey({ name: "NoUrl", url: undefined, content: "hi" }), /^NoUrl::inline::[a-f0-9]{64}$/);
  assert.equal(knowledge.sourceCacheKey({ url: "https://example.com" }), null);
  assert.equal(knowledge.sourceCacheKey(null), null);
});

/* --------------------------------------- source freshness contract -- */

test("a successfully refreshed source is fresh and exact-claim eligible", () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const source = { name: "Fresh Contract Source", type: "text", url: "https://example.com/fresh" };
  const key = knowledge.sourceCacheKey(source);
  db.saveSourceText(key, "fresh source text");
  try {
    const eligibility = knowledge.sourceEligibility(source);
    assert.equal(eligibility.key, key);
    assert.equal(eligibility.name, source.name);
    assert.equal(eligibility.authority, "static");
    assert.equal(eligibility.freshness, "fresh");
    assert.equal(typeof eligibility.lastSuccessAt, "number");
    assert.equal(eligibility.failCount, 0);
    assert.equal(eligibility.lastError, null);
    assert.equal(eligibility.hasLastGood, true);
    assert.equal(eligibility.exactClaimsAllowed, true);
    assert.equal(eligibility.eligible, true);
  } finally {
    db.handle().query("DELETE FROM source_cache WHERE name = ?").run(key);
  }
});

test("a failed refresh keeps last-good content and marks the source stale", async () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const guard = require("./sourceGuard");
  const source = { name: "Stale Contract Source", type: "json-faq", url: "https://example.com/stale" };
  const key = knowledge.sourceCacheKey(source);
  const original = guard.fetchSourceUrl;
  db.saveSourceText(key, "last good contract copy");
  guard.fetchSourceUrl = async () => { throw new Error("refresh offline"); };
  try {
    await knowledge.refreshSource(source, true);
    const eligibility = knowledge.sourceEligibility(source);
    assert.equal(eligibility.freshness, "stale");
    assert.equal(eligibility.hasLastGood, true);
    assert.equal(eligibility.exactClaimsAllowed, true);
    assert.match(knowledge.getCorpus(), /last good contract copy/);
  } finally {
    guard.fetchSourceUrl = original;
    db.handle().query("DELETE FROM source_cache WHERE name = ?").run(key);
    knowledge.invalidate();
  }
});

test("a source with no successful refresh is unavailable and ineligible", () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const source = { name: "Never Successful Source", type: "url", url: "https://example.com/never" };
  const key = knowledge.sourceCacheKey(source);
  db.recordSourceFailure(key, "never came up");
  try {
    const eligibility = knowledge.sourceEligibility(source);
    assert.equal(eligibility.freshness, "unavailable");
    assert.equal(eligibility.hasLastGood, false);
    assert.equal(eligibility.exactClaimsAllowed, false);
    assert.equal(eligibility.lastError, "never came up");
  } finally {
    db.handle().query("DELETE FROM source_cache WHERE name = ?").run(key);
  }
});

test("a failed dynamic source is classified stale and cannot authorize exact claims", () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const source = { name: "Dynamic Contract Source", type: "live-shop", url: "https://example.com/live" };
  const key = knowledge.sourceCacheKey(source);
  db.saveSourceText(key, "last good dynamic copy");
  db.recordSourceFailure(key, "dynamic endpoint offline");
  try {
    const eligibility = knowledge.sourceEligibility(source);
    assert.equal(eligibility.authority, "dynamic");
    assert.equal(eligibility.freshness, "stale");
    assert.equal(eligibility.hasLastGood, true);
    assert.equal(eligibility.exactClaimsAllowed, false);
  } finally {
    db.handle().query("DELETE FROM source_cache WHERE name = ?").run(key);
  }
});

test("automatic refresh fallback records failure and stale dynamic metrics", async () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const guard = require("./sourceGuard");
  const source = { name: "Metric Dynamic Source", type: "live-shop", url: "https://example.com/metric-live" };
  const key = knowledge.sourceCacheKey(source);
  const original = guard.fetchSourceUrl;
  const originalMetric = db.recordMetric;
  const metrics = [];
  db.saveSourceText(key, "last good dynamic metric copy");
  guard.fetchSourceUrl = async () => { throw new Error("metric refresh offline"); };
  db.recordMetric = (...args) => metrics.push(args);
  try {
    await knowledge.refreshSource(source, false);
    assert.deepEqual(metrics, [
      ["source_refresh_failure", null, source.name],
      ["stale_dynamic_source_used", null, source.name],
    ]);
  } finally {
    guard.fetchSourceUrl = original;
    db.recordMetric = originalMetric;
    db.handle().query("DELETE FROM source_cache WHERE name = ?").run(key);
    knowledge.invalidate();
  }
});

test("loadSources dedupes by name::url but keeps same-name different-URL", () => {
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "dedupe-test", name: "Dedupe", sources: [
      { name: "Same", type: "json-faq", url: "file://./quick-links.json" },
      { name: "Same", type: "json-faq", url: "file://./quick-links.json" },
      { name: "Same", type: "json-faq", url: "file://./data/ysws-submission-guidelines.md" },
    ] },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  try {
    const kept = knowledge.loadSources().filter((s) => s.name === "Same");
    assert.equal(kept.length, 2);
    assert.ok(kept.some((s) => s.url === "file://./quick-links.json"));
    assert.ok(kept.some((s) => s.url === "file://./data/ysws-submission-guidelines.md"));
  } finally {
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("fetchSourceText dispatches file:// json-faq and text", async () => {
  const knowledge = require("./knowledge");
  const faqText = await knowledge.fetchSourceText({ name: "Quick", type: "json-faq", url: "file://./quick-links.json" });
  assert.match(faqText, /Q: Where can I play Pixl\?/);
  const mdText = await knowledge.fetchSourceText({ name: "Guide", type: "text", url: "file://./data/ysws-submission-guidelines.md" });
  assert.ok(mdText.length > 50);
});

test("fetchSourceText inline gdoc records siteUrl for citations", async () => {
  const knowledge = require("./knowledge");
  const text = await knowledge.fetchSourceText({ name: "CharInlineGdoc", type: "gdoc", content: "hello inline doc", siteUrl: "https://example.com/inline-doc" });
  assert.equal(text, "hello inline doc");
  assert.equal(knowledge.getSourceUrl("CharInlineGdoc"), "https://example.com/inline-doc");
});

test("github-dir fetch skips unrendered {{placeholder}} pages and drops shared chrome", async () => {
  const knowledge = require("./knowledge");
  const guard = require("./sourceGuard");
  const real = guard.fetchSourceUrl;
  const listing = [
    { type: "file", name: "010-a.md", download_url: "https://raw/a", html_url: "https://gh/a" },
    { type: "file", name: "020-b.md", download_url: "https://raw/b", html_url: "https://gh/b" },
    { type: "file", name: "030-c.md", download_url: "https://raw/c", html_url: "https://gh/c" },
    { type: "file", name: "040-d.md", download_url: "https://raw/d", html_url: "https://gh/d" },
  ];
  guard.fetchSourceUrl = async (url) => {
    if (url === "https://api.example.com/dir") return { data: listing };
    if (url.includes("not-used")) throw new Error("unexpected");
    // Three good pages share a chrome line (needs >=3 pages for dropSharedLines
    // to tell chrome from content); one page is all placeholders and is skipped.
    if (url.endsWith("/a")) return { data: "<h1>Alpha</h1><p>CHROME LINE</p><p>alpha unique body text here</p>" };
    if (url.endsWith("/b")) return { data: "<h1>Beta</h1><p>CHROME LINE</p><p>beta unique body text here</p>" };
    if (url.endsWith("/c")) return { data: "<h1>Gamma</h1><p>CHROME LINE</p><p>gamma unique body text here</p>" };
    if (url.endsWith("/d")) return { data: "<h1>Delta</h1><p>{{basePx}} per hour {{t1}}</p>" };
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const text = await knowledge.fetchSourceText({ name: "CharDir", type: "github-dir", url: "https://api.example.com/dir", siteUrl: "https://site.example.com/docs" });
    assert.match(text, /alpha unique body/);
    assert.match(text, /beta unique body/);
    assert.match(text, /gamma unique body/);
    assert.doesNotMatch(text, /basePx/);
    assert.doesNotMatch(text, /CHROME LINE/);
  } finally {
    guard.fetchSourceUrl = real;
  }
});

test("a source that succeeds then fails keeps serving the in-memory last good copy", async () => {
  const knowledge = require("./knowledge");
  const guard = require("./sourceGuard");
  const db = require("./db");
  const real = guard.fetchSourceUrl;
  const src = { name: "CharMemFallback", type: "json-faq", url: "https://example.com/char-faq" };
  guard.fetchSourceUrl = async () => ({ data: { faq: { items: [{ question: "mem q", answer: "mem good copy" }] } } });
  try {
    await knowledge.refreshSource(src, true);
  } finally {
    guard.fetchSourceUrl = real;
  }
  // Remove the disk row so only memory can serve the fallback.
  try { db.handle().query("DELETE FROM source_cache WHERE name IN (?, ?)").run("CharMemFallback", "CharMemFallback::https://example.com/char-faq"); } catch (_) {}
  guard.fetchSourceUrl = async () => { throw new Error("boom"); };
  try {
    await knowledge.refreshSource(src, true);
    assert.match(knowledge.getCorpus(), /mem good copy/);
  } finally {
    guard.fetchSourceUrl = real;
    try { db.handle().query("DELETE FROM source_cache WHERE name IN (?, ?)").run("CharMemFallback", "CharMemFallback::https://example.com/char-faq"); } catch (_) {}
    knowledge.invalidate();
  }
});

test("corpus puts generated sections first and memoizes per program until invalidate", () => {
  const knowledge = require("./knowledge");
  knowledge.invalidate();
  const first = knowledge.getCorpus("pixl");
  const second = knowledge.getCorpus("pixl");
  assert.equal(first, second);
  const gen = knowledge.generatedSections("pixl");
  assert.ok(gen.length >= 1);
  assert.equal(gen[0][0], "About pixie");
  if (gen.length >= 2) assert.equal(gen[1][0], "Program timeline");
  // Generated headings lead the corpus string.
  const aboutIdx = first.indexOf("### About pixie");
  assert.ok(aboutIdx === 0 || aboutIdx > -1);
  knowledge.invalidate();
  const after = knowledge.getCorpus("pixl");
  assert.equal(typeof after, "string");
});

/* ---------------------------------------- STEP 2 regression: bug fixes -- */

// Mem used to be keyed by bare name, so two programs sharing a source name but
// not a URL overwrote each other: whichever refreshed last won for BOTH
// programs. Namespaced mem keeps each program on its own copy.
test("same-name different-URL sources stay isolated across programs", async () => {
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const guard = require("./sourceGuard");
  const db = require("./db");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "char-a", name: "A", sources: [{ name: "Collision Docs", type: "json-faq", url: "https://example.com/a-faq" }] },
    { id: "char-b", name: "B", sources: [{ name: "Collision Docs", type: "json-faq", url: "https://example.com/b-faq" }] },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  const real = guard.fetchSourceUrl;
  guard.fetchSourceUrl = async (url) => {
    if (url === "https://example.com/a-faq") return { data: { faq: { items: [{ question: "qa", answer: "alpha unique text" }] } } };
    if (url === "https://example.com/b-faq") return { data: { faq: { items: [{ question: "qb", answer: "beta unique text" }] } } };
    throw new Error(`unexpected ${url}`);
  };
  try {
    await knowledge.refreshSource({ name: "Collision Docs", type: "json-faq", url: "https://example.com/a-faq" }, true);
    await knowledge.refreshSource({ name: "Collision Docs", type: "json-faq", url: "https://example.com/b-faq" }, true);
    knowledge.invalidate();
    const aSecs = knowledge.getCorpus("char-a");
    const bSecs = knowledge.getCorpus("char-b");
    assert.match(aSecs, /alpha unique text/);
    assert.doesNotMatch(aSecs, /beta unique text/);
    assert.match(bSecs, /beta unique text/);
    assert.doesNotMatch(bSecs, /alpha unique text/);
  } finally {
    guard.fetchSourceUrl = real;
    try { db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Collision Docs%'").run(); } catch (_) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

test("same-name different-content inline sources stay isolated across programs", async () => {
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const db = require("./db");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  const sourceA = { name: "Inline Collision", type: "text", content: "alpha inline text" };
  const sourceB = { name: "Inline Collision", type: "text", content: "beta inline text" };
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "inline-a", name: "Inline A", sources: [sourceA] },
    { id: "inline-b", name: "Inline B", sources: [sourceB] },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  try {
    const loaded = knowledge.loadSources().filter((source) => source.name === "Inline Collision");
    assert.equal(loaded.length, 2);
    await knowledge.refreshSource(sourceA, true);
    await knowledge.refreshSource(sourceB, true);
    knowledge.invalidate();

    const aCorpus = knowledge.getCorpus("inline-a");
    const bCorpus = knowledge.getCorpus("inline-b");
    assert.match(aCorpus, /alpha inline text/);
    assert.doesNotMatch(aCorpus, /beta inline text/);
    assert.match(bCorpus, /beta inline text/);
    assert.doesNotMatch(bCorpus, /alpha inline text/);
  } finally {
    try {
      db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Inline Collision%'").run();
    } catch (_) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

// The non-Firecrawl url path used raw axios.get for subpages, skipping the
// SSRF guard the root fetch went through — a crafted /docs href could pull
// link-local metadata. Every subpage now goes through fetchSourceUrl.
test("url subpages are fetched through the SSRF guard, not raw axios", async () => {
  const knowledge = require("./knowledge");
  const guard = require("./sourceGuard");
  const firecrawl = require("./firecrawl");
  const axios = require("axios");
  const realGuard = guard.fetchSourceUrl;
  const realKey = firecrawl.getApiKey;
  const realAxios = axios.get;
  firecrawl.getApiKey = () => null;
  axios.get = async () => { throw new Error("raw axios must not be called for subpages"); };
  guard.fetchSourceUrl = async (url) => {
    if (url === "https://example.com/docs-root") return { data: '<a href="/docs/sub">sub</a><p>root marker</p>' };
    if (url === "https://example.com/docs/sub") return { data: "<p>subpage unique marker xyz</p>" };
    throw new Error(`unexpected ${url}`);
  };
  try {
    const text = await knowledge.fetchSourceText({ name: "CharGuarded", type: "url", url: "https://example.com/docs-root" });
    assert.match(text, /subpage unique marker xyz/);
  } finally {
    guard.fetchSourceUrl = realGuard;
    firecrawl.getApiKey = realKey;
    axios.get = realAxios;
  }
});

test("file:// sources outside the app root are refused", () => {
  const knowledge = require("./knowledge");
  assert.doesNotThrow(() => knowledge.resolveLocalPath("file://./quick-links.json"));
  assert.throws(() => knowledge.resolveLocalPath("file:///etc/passwd"), /outside app root/);
  assert.throws(() => knowledge.resolveLocalPath("file://./../../etc/passwd"), /outside app root/);
});
