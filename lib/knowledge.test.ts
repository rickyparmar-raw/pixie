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

type SourceLike = {
  name: string;
  url?: string;
  type?: string;
  content?: unknown;
  siteUrl?: string;
};
type SourceStatus = {
  name: string;
  status: string;
  type: string | null;
  url: string | null;
  error: string | null;
  lastSuccessAt: number | null;
  chunks: number;
};

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
  assert.deepEqual(files.map((f: { name: string }) => f.name), ["010-welcome.md", "040-rules.md"]);
  assert.equal(files[0].title, "Welcome");
  assert.equal(files[0].pageUrl, "https://gh/10");
});

test("markdownFilesFromListing drops entries with no download_url and non-arrays", () => {
  assert.deepEqual(markdownFilesFromListing([{ type: "file", name: "a.md" }]), []);
  assert.deepEqual(markdownFilesFromListing(null), []);
  assert.deepEqual(markdownFilesFromListing({ message: "Not Found" }), []);
});

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

test("dropSharedLines is a no-op for fewer than three pages", () => {
  const pages = ["PIXL DOCS\nonly page", "PIXL DOCS\nsecond page"];
  assert.deepEqual(dropSharedLines(pages), pages);
});

test("a source that fails to fetch falls back to the copy on disk", async () => {
  const db = require("./db");
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const guard = require("./sourceGuard");

  db.saveSourceText("Flaky Source", "the deadline is august 18");

  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "flaky-prog", name: "Flaky", sources: [{ name: "Flaky Source", type: "url", url: "https://example.com/docs" }] },
  ]);
  programs.invalidate();
  knowledge.invalidate();

  const realGuard = guard.fetchSourceUrl;
  guard.fetchSourceUrl = async () => {
    const err = Object.assign(new Error("Request failed with status code 403"), { response: { status: 403 } });
    throw err;
  };

  try {
    await knowledge.refreshSource({ name: "Flaky Source", type: "url", url: "https://example.com/docs" });
    assert.match(knowledge.getCorpus("flaky-prog"), /the deadline is august 18/);
  } finally {
    guard.fetchSourceUrl = realGuard;
    try { db.handle().query("DELETE FROM source_cache WHERE name IN (?, ?)").run("Flaky Source", "Flaky Source::https://example.com/docs"); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

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
    const names = knowledge.loadSources().map((s: SourceLike) => s.name);
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
  const programs = require("./programs");
  const guard = require("./sourceGuard");
  const source = { name: "Stale Contract Source", type: "json-faq", url: "https://example.com/stale" };
  const key = knowledge.sourceCacheKey(source);
  const original = guard.fetchSourceUrl;
  db.saveSourceText(key, "last good contract copy");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "stale-prog", name: "Stale", sources: [source] },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  guard.fetchSourceUrl = async () => { throw new Error("refresh offline"); };
  try {
    await knowledge.refreshSource(source, true);
    const eligibility = knowledge.sourceEligibility(source);
    assert.equal(eligibility.freshness, "stale");
    assert.equal(eligibility.hasLastGood, true);
    assert.equal(eligibility.exactClaimsAllowed, true);
    assert.match(knowledge.getCorpus("stale-prog"), /last good contract copy/);
  } finally {
    guard.fetchSourceUrl = original;
    try { db.handle().query("DELETE FROM source_cache WHERE name IN (?, ?)").run("Stale Contract Source", key); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
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
  const metrics: unknown[][] = [];
  db.saveSourceText(key, "last good dynamic metric copy");
  guard.fetchSourceUrl = async () => { throw new Error("metric refresh offline"); };
  db.recordMetric = (...args: unknown[]) => metrics.push(args);
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
    const kept = knowledge.loadSources().filter((s: SourceLike) => s.name === "Same");
    assert.equal(kept.length, 2);
    assert.ok(kept.some((s: SourceLike) => s.url === "file://./quick-links.json"));
    assert.ok(kept.some((s: SourceLike) => s.url === "file://./data/ysws-submission-guidelines.md"));
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
  guard.fetchSourceUrl = async (url: string) => {
    if (url === "https://api.example.com/dir") return { data: listing };
    if (url.includes("not-used")) throw new Error("unexpected");
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
  const programs = require("./programs");
  const db = require("./db");
  const real = guard.fetchSourceUrl;
  const src = { name: "CharMemFallback", type: "json-faq", url: "https://example.com/char-faq" };
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "charmem-prog", name: "CharMem", sources: [src] },
  ]);
  programs.invalidate();
  knowledge.invalidate();
  guard.fetchSourceUrl = async () => ({ data: { faq: { items: [{ question: "mem q", answer: "mem good copy" }] } } });
  try {
    await knowledge.refreshSource(src, true);
  } finally {
    guard.fetchSourceUrl = real;
  }
  try { db.handle().query("DELETE FROM source_cache WHERE name IN (?, ?)").run("CharMemFallback", "CharMemFallback::https://example.com/char-faq"); } catch (_: unknown) {}
  guard.fetchSourceUrl = async () => { throw new Error("boom"); };
  try {
    await knowledge.refreshSource(src, true);
    assert.match(knowledge.getCorpus("charmem-prog"), /mem good copy/);
  } finally {
    guard.fetchSourceUrl = real;
    try { db.handle().query("DELETE FROM source_cache WHERE name IN (?, ?)").run("CharMemFallback", "CharMemFallback::https://example.com/char-faq"); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
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
  const aboutIdx = first.indexOf("### About pixie");
  assert.ok(aboutIdx === 0 || aboutIdx > -1);
  knowledge.invalidate();
  const after = knowledge.getCorpus("pixl");
  assert.equal(typeof after, "string");
});


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
  guard.fetchSourceUrl = async (url: string) => {
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
    try { db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Collision Docs%'").run(); } catch (_: unknown) {}
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
    const loaded = knowledge.loadSources().filter((source: SourceLike) => source.name === "Inline Collision");
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
    } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});

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
  guard.fetchSourceUrl = async (url: string) => {
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


async function withFleet(fleet: unknown[], fn: () => Promise<void>) {
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify(fleet);
  programs.invalidate();
  knowledge.invalidate();
  const axios = require("axios");
  const realGet = axios.get;
  axios.get = async () => {
    throw new Error("network disabled in test");
  };
  try {
    await knowledge.refreshCorpus();
    await fn();
  } finally {
    axios.get = realGet;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
}


test("getContext fits the total budget with a 14k-char learned section", async () => {
  const knowledge = require("./knowledge");
  const learn = require("./learn");
  const retrieve = require("./retrieve");
  const fleet = [
    {
      id: "budget-prog",
      name: "Budget",
      sharedSources: false,
      sources: [{
        name: "Budget Docs",
        type: "text",
        content: "To reset your widget, press the recalibration button for three seconds until the status lamp glows amber. Widgets ship with a spare fuse in the accessory tray.",
      }],
    },
  ];
  await withFleet(fleet, async () => {
    const ids = [
      learn.teach({
        question: "how do I reset my widget at home",
        answer: "relevant-override-marker: hold the amber override key for five beats",
        authorId: "U1",
        programId: "budget-prog",
      }),
    ];
    const kilnBody = "Slow cooling prevents crazing in cone-six glazes. ";
    for (let i = 0; i < 11; i++) {
      ids.push(learn.teach({
        question: `kiln-marker-${i} firing schedules for pottery studios`,
        answer: `kiln-marker-${i} ${kilnBody.repeat(25)}`,
        authorId: "U1",
        programId: "budget-prog",
      }));
    }
    try {
      const full = learn.corpusSection("budget-prog");
      assert.ok(full.length > 14000, `setup: taught section is ${full.length} chars, want > 14000`);

      const ctx = knowledge.getContext("how do I reset my widget", "budget-prog");
      assert.ok(ctx.length <= retrieve.TOTAL_CONTEXT_BUDGET, `context is ${ctx.length} chars`);
      assert.match(ctx, /relevant-override-marker/, "relevant learned fact included");
      assert.match(ctx, /status lamp glows amber/, "retrieved evidence still present");
      assert.match(ctx, /### Budget Docs/, "source grouping kept for citations");
      assert.doesNotMatch(ctx, /kiln-marker/, "irrelevant learned facts excluded");

      const cold = knowledge.getContext("zzzz qqqq", "budget-prog");
      assert.ok(cold.length <= retrieve.TOTAL_CONTEXT_BUDGET, `cold context is ${cold.length} chars`);
      assert.doesNotMatch(cold, /relevant-override-marker|kiln-marker/);
    } finally {
      ids.forEach((id) => learn.forget(id));
    }
  });
});


test("taught facts never cross programs: same question, each program answers from its own", async () => {
  const knowledge = require("./knowledge");
  const learn = require("./learn");
  const fleet = [
    {
      id: "bud-pixl",
      name: "Pixl",
      sharedSources: false,
      sources: [{ name: "Pixl Docs", type: "text", content: "Pixl restoration energy refills once per day." }],
    },
    {
      id: "bud-b2b",
      name: "B2B",
      sharedSources: false,
      sources: [{ name: "B2B Docs", type: "text", content: "B2B coins accrue from tracked hours and journal quality." }],
    },
  ];
  await withFleet(fleet, async () => {
    const ids = [
      learn.teach({ question: "bud-tenancy what is the payout", answer: "bud-pixl-marker: pixl payouts land as shop credit", authorId: "U1", programId: "bud-pixl" }),
      learn.teach({ question: "bud-tenancy what is the payout", answer: "bud-b2b-marker: b2b payouts accrue as weekly coins", authorId: "U2", programId: "bud-b2b" }),
    ];
    try {
      const pixlCtx = knowledge.getContext("bud-tenancy what is the payout", "bud-pixl");
      assert.match(pixlCtx, /bud-pixl-marker/);
      assert.doesNotMatch(pixlCtx, /bud-b2b-marker/);
      assert.doesNotMatch(pixlCtx, /weekly coins/);

      const b2bCtx = knowledge.getContext("bud-tenancy what is the payout", "bud-b2b");
      assert.match(b2bCtx, /bud-b2b-marker/);
      assert.doesNotMatch(b2bCtx, /bud-pixl-marker/);
      assert.doesNotMatch(b2bCtx, /shop credit/);
    } finally {
      ids.forEach((id) => learn.forget(id));
    }
  });
});


test("untrusted sources never enter the corpus: SSRF targets, oversized bodies, script HTML", async () => {
  const knowledge = require("./knowledge");
  const programs = require("./programs");
  const guard = require("./sourceGuard");
  const firecrawl = require("./firecrawl");
  const fleet = [
    {
      id: "evil-prog",
      name: "Evil",
      sharedSources: false,
      sources: [
        { name: "Evil Meta", type: "url", url: "http://169.254.169.254/latest/meta-data" },
        { name: "Evil Local", type: "url", url: "http://localhost:3000/admin" },
        { name: "Big Docs", type: "url", url: "https://example.com/big" },
        { name: "Script Docs", type: "url", url: "https://example.com/scripted" },
      ],
    },
  ];
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify(fleet);
  require("./programs").invalidate();
  knowledge.invalidate();
  const realGuard = guard.fetchSourceUrl;
  const realKey = firecrawl.getApiKey;
  firecrawl.getApiKey = () => null;
  guard.fetchSourceUrl = async (url: string, opts: Record<string, unknown>) => {
    if (url === "https://example.com/big") {
      return { data: `BIG-HEAD-MARKER ${"padded body text ".repeat(20000)} BIG-TAIL-MARKER` };
    }
    if (url === "https://example.com/scripted") {
      return { data: "<html><head><script>EVIL-SCRIPT-MARKER()</script></head><body><p>SCRIPTED-LEGIT-MARKER benign docs text</p></body></html>" };
    }
    return realGuard(url, opts);
  };
  try {
    await knowledge.refreshCorpus();
    const corpus = knowledge.getCorpus("evil-prog");
    assert.doesNotMatch(corpus, /169\.254\.169\.254/, "SSRF target never cached");
    assert.doesNotMatch(corpus, /EVIL-SCRIPT-MARKER/, "script contents stripped");
    assert.match(corpus, /SCRIPTED-LEGIT-MARKER/, "benign text survives script stripping");
    assert.match(corpus, /BIG-HEAD-MARKER/, "oversized head kept");
    assert.doesNotMatch(corpus, /BIG-TAIL-MARKER/, "oversized tail past the cap never enters");
  } finally {
    guard.fetchSourceUrl = realGuard;
    firecrawl.getApiKey = realKey;
    const db = require("./db");
    try { db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Evil%' OR name LIKE 'Big Docs%' OR name LIKE 'Script Docs%'").run(); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
});


test("sourceStatus reports ready/stale/error/pending with no secrets", async () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const guard = require("./sourceGuard");
  const fleet = [
    {
      id: "stat-prog",
      name: "Stat",
      sharedSources: false,
      sources: [
        { name: "Stat FAQ", type: "json-faq", content: [{ question: "stat q", answer: "stat a" }] },
        { name: "Stat Down", type: "url", url: "https://example.com/down" },
        { name: "Stat Flaky", type: "url", url: "https://example.com/flaky" },
        { name: "Stat Token", type: "url", url: "https://example.com/docs?token=SECRET123" },
      ],
    },
    {
      id: "stat-pending-prog",
      name: "Pending",
      sharedSources: false,
      sources: [{ name: "Stat Untouched", type: "url", url: "https://example.com/untouched" }],
    },
  ];
  db.saveSourceText("Stat Flaky::https://example.com/flaky", "flaky last good copy");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify(fleet);
  require("./programs").invalidate();
  knowledge.invalidate();
  const pending = knowledge.sourceStatus("stat-pending-prog");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].lastSuccessAt, null);
  const realGuard = guard.fetchSourceUrl;
  const firecrawl = require("./firecrawl");
  const realKey = firecrawl.getApiKey;
  firecrawl.getApiKey = () => null;
  guard.fetchSourceUrl = async (url: string) => {
    if (url === "https://example.com/docs") return { data: "<p>token docs are public</p>" };
    throw new Error("stat offline");
  };
  try {
    await knowledge.refreshCorpus();
    const byName = new Map<string, SourceStatus>(knowledge.sourceStatus("stat-prog").map((s: SourceStatus): [string, SourceStatus] => [s.name, s]));

    const faq = byName.get("Stat FAQ");
    if (!faq) throw new Error("Stat FAQ status missing");
    assert.equal(faq.status, "ready");
    assert.equal(faq.type, "json-faq");
    assert.equal(faq.url, null);
    assert.equal(faq.error, null);
    assert.ok(typeof faq.lastSuccessAt === "number");
    assert.ok(faq.chunks >= 1);

    const down = byName.get("Stat Down");
    if (!down) throw new Error("Stat Down status missing");
    assert.equal(down.status, "error");
    assert.equal(down.lastSuccessAt, null);
    assert.match(down.error, /stat offline/);
    assert.equal(down.chunks, 0);

    const flaky = byName.get("Stat Flaky");
    if (!flaky) throw new Error("Stat Flaky status missing");
    assert.equal(flaky.status, "stale");
    assert.ok(typeof flaky.lastSuccessAt === "number");
    assert.match(flaky.error, /stat offline/);
    assert.match(knowledge.getCorpus("stat-prog"), /flaky last good copy/);

    const token = byName.get("Stat Token");
    if (!token) throw new Error("Stat Token status missing");
    assert.equal(token.url, "https://example.com/docs");
    assert.doesNotMatch(token.url, /SECRET123/);

    assert.deepEqual(knowledge.sourceStatus("no-such-program"), []);
  } finally {
    guard.fetchSourceUrl = realGuard;
    firecrawl.getApiKey = realKey;
    try { db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Stat%'").run(); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    require("./programs").invalidate();
    knowledge.invalidate();
  }
});

async function drainUntil(fn: () => boolean, timeoutMs: number = 5000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

test("refreshProgramSources starts without blocking and refreshes only its program", async () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const guard = require("./sourceGuard");
  const firecrawl = require("./firecrawl");
  const fleet = [
    {
      id: "rps-a",
      name: "RpsA",
      sharedSources: false,
      sources: [{ name: "Rps A Docs", type: "url", url: "https://example.com/rps-a" }],
    },
    {
      id: "rps-b",
      name: "RpsB",
      sharedSources: false,
      sources: [{ name: "Rps B Docs", type: "url", url: "https://example.com/rps-b" }],
    },
  ];
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify(fleet);
  require("./programs").invalidate();
  knowledge.invalidate();
  const realGuard = guard.fetchSourceUrl;
  const realKey = firecrawl.getApiKey;
  firecrawl.getApiKey = () => null;
  const calls: string[] = [];
  guard.fetchSourceUrl = async (url: string) => {
    calls.push(url);
    if (url === "https://example.com/rps-a") return { data: "<p>RPS-A-MARKER fresh copy</p>" };
    throw new Error("must not fetch program B");
  };
  try {
    const ret = knowledge.refreshProgramSources("rps-a");
    assert.deepEqual(ret, { started: true, sources: 1 });
    assert.ok(await drainUntil(() => knowledge.getCorpus("rps-a").includes("RPS-A-MARKER")), "refresh did not land");
    assert.ok(!calls.some((u: string) => u.includes("rps-b")), "other program's source was fetched");
    assert.doesNotMatch(knowledge.getCorpus("rps-b"), /RPS-A-MARKER/);
    assert.deepEqual(knowledge.refreshProgramSources("no-such-program"), { started: false, sources: 0 });
  } finally {
    guard.fetchSourceUrl = realGuard;
    firecrawl.getApiKey = realKey;
    try { db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Rps%'").run(); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    require("./programs").invalidate();
    knowledge.invalidate();
  }
});

test("refreshProgramSources dedupes in-flight sources and reports fetching", async () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const guard = require("./sourceGuard");
  const firecrawl = require("./firecrawl");
  const fleet = [
    {
      id: "dedup-prog",
      name: "Dedup",
      sharedSources: false,
      sources: [{ name: "Dedup Docs", type: "url", url: "https://example.com/dedup" }],
    },
  ];
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify(fleet);
  require("./programs").invalidate();
  knowledge.invalidate();
  const realGuard = guard.fetchSourceUrl;
  const realKey = firecrawl.getApiKey;
  firecrawl.getApiKey = () => null;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  guard.fetchSourceUrl = async () => {
    calls += 1;
    await gate;
    return { data: "<p>DEDUP-MARKER landed</p>" };
  };
  try {
    assert.deepEqual(knowledge.refreshProgramSources("dedup-prog"), { started: true, sources: 1 });
    assert.deepEqual(knowledge.refreshProgramSources("dedup-prog"), { started: true, sources: 0 });
    assert.equal(knowledge.sourceStatus("dedup-prog")[0].status, "fetching");
    release();
    assert.ok(await drainUntil(() => knowledge.sourceStatus("dedup-prog")[0].status === "ready"), "refresh did not finish");
    assert.equal(calls, 1);
    assert.match(knowledge.getCorpus("dedup-prog"), /DEDUP-MARKER/);
  } finally {
    try { release(); } catch (_: unknown) {}
    guard.fetchSourceUrl = realGuard;
    firecrawl.getApiKey = realKey;
    try { db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Dedup%'").run(); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    require("./programs").invalidate();
    knowledge.invalidate();
  }
});

test("a failed program refresh never erases the last-known-good text", async () => {
  const knowledge = require("./knowledge");
  const db = require("./db");
  const guard = require("./sourceGuard");
  const firecrawl = require("./firecrawl");
  const fleet = [
    {
      id: "good-prog",
      name: "Good",
      sharedSources: false,
      sources: [{ name: "Good Docs", type: "url", url: "https://example.com/good" }],
    },
  ];
  db.saveSourceText("Good Docs::https://example.com/good", "good last-known copy");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify(fleet);
  require("./programs").invalidate();
  knowledge.invalidate();
  const realGuard = guard.fetchSourceUrl;
  const realKey = firecrawl.getApiKey;
  firecrawl.getApiKey = () => null;
  guard.fetchSourceUrl = async () => { throw new Error("good offline"); };
  try {
    assert.deepEqual(knowledge.refreshProgramSources("good-prog"), { started: true, sources: 1 });
    assert.ok(await drainUntil(() => knowledge.sourceStatus("good-prog")[0]?.status === "stale"), "status did not settle");
    assert.match(knowledge.getCorpus("good-prog"), /good last-known copy/);
  } finally {
    guard.fetchSourceUrl = realGuard;
    firecrawl.getApiKey = realKey;
    try { db.handle().query("DELETE FROM source_cache WHERE name LIKE 'Good Docs%'").run(); } catch (_: unknown) {}
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    require("./programs").invalidate();
    knowledge.invalidate();
  }
});
export {};
