const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { config } = require("./config");
const firecrawl = require("./firecrawl");

let realPost: typeof axios.post;
before(() => {
  realPost = axios.post;
});
after(() => {
  axios.post = realPost;
});

let savedApiKey: string | null;
before(() => {
  savedApiKey = config.firecrawlApiKey;
  config.firecrawlApiKey = "test-key";
});
after(() => {
  config.firecrawlApiKey = savedApiKey;
});

beforeEach(() => {
  firecrawl.clearScrapeCache();
});

test("scrapeUrl returns null without an API key, and never calls the network", async () => {
  const saved = config.firecrawlApiKey;
  config.firecrawlApiKey = null;
  axios.post = async () => {
    throw new Error("should not have been called");
  };

  try {
    assert.equal(await firecrawl.scrapeUrl("https://example.com/docs"), null);
  } finally {
    config.firecrawlApiKey = saved;
  }
});

test("scrapeUrl returns the markdown on a successful scrape", async () => {
  axios.post = async () => ({ data: { success: true, data: { markdown: "# Hello\n\nworld" } } });

  assert.equal(await firecrawl.scrapeUrl("https://example.com/docs"), "# Hello\n\nworld");
});

test("scrapeUrl serves a cached copy instead of re-scraping the same URL", async () => {
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    return { data: { success: true, data: { markdown: "cached content" } } };
  };

  const first = await firecrawl.scrapeUrl("https://example.com/docs");
  const second = await firecrawl.scrapeUrl("https://example.com/docs");

  assert.equal(first, "cached content");
  assert.equal(second, "cached content");
  assert.equal(calls, 1, "the second call should have been served from cache, not the network");
});

test("scrapeUrl caches independently per URL", async () => {
  let calls = 0;
  axios.post = async (_endpoint: string, body: { url: string }) => {
    calls += 1;
    return { data: { success: true, data: { markdown: `content for ${body.url}` } } };
  };

  const a = await firecrawl.scrapeUrl("https://example.com/a");
  const b = await firecrawl.scrapeUrl("https://example.com/b");

  assert.equal(a, "content for https://example.com/a");
  assert.equal(b, "content for https://example.com/b");
  assert.equal(calls, 2);
});

test("scrapeUrl's skipCache option bypasses the cache and re-scrapes", async () => {
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    return { data: { success: true, data: { markdown: `version ${calls}` } } };
  };

  const first = await firecrawl.scrapeUrl("https://example.com/docs");
  const second = await firecrawl.scrapeUrl("https://example.com/docs", { skipCache: true });

  assert.equal(first, "version 1");
  assert.equal(second, "version 2");
  assert.equal(calls, 2);
});

test("scrapeUrl falls back to a stale cached copy when a re-scrape fails", async () => {
  axios.post = async () => ({ data: { success: true, data: { markdown: "good copy" } } });
  await firecrawl.scrapeUrl("https://example.com/docs");

  axios.post = async () => {
    throw new Error("Rate limit exceeded");
  };
  const result = await firecrawl.scrapeUrl("https://example.com/docs", { skipCache: true });

  assert.equal(result, "good copy");
});

test("scrapeUrl returns null on failure with no cached copy to fall back on", async () => {
  axios.post = async () => {
    throw new Error("Rate limit exceeded");
  };

  assert.equal(await firecrawl.scrapeUrl("https://example.com/never-cached"), null);
});

test("clearScrapeCache forces the next call to hit the network again", async () => {
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    return { data: { success: true, data: { markdown: `version ${calls}` } } };
  };

  await firecrawl.scrapeUrl("https://example.com/docs");
  firecrawl.clearScrapeCache();
  await firecrawl.scrapeUrl("https://example.com/docs");

  assert.equal(calls, 2);
});

test("searchWeb returns null without an API key, never calling the network", async () => {
  const saved = config.firecrawlApiKey;
  config.firecrawlApiKey = null;
  axios.post = async () => {
    throw new Error("should not have been called");
  };
  try {
    assert.equal(await firecrawl.searchWeb("anything"), null);
  } finally {
    config.firecrawlApiKey = saved;
  }
});

test("searchWeb maps results to url/title/markdown", async () => {
  axios.post = async () => ({
    data: { success: true, data: [{ url: "https://a.example", title: "A", markdown: "md", description: "d" }] },
  });
  const res = await firecrawl.searchWeb("q", 1);
  assert.equal(res.length, 1);
  assert.equal(res[0].url, "https://a.example");
  assert.equal(res[0].markdown, "md");
});

test("unsuccessful scrape payloads yield null, not a throw", async () => {
  axios.post = async () => ({ data: { success: false } });
  assert.equal(await firecrawl.scrapeUrl("https://example.com/char-miss"), null);
});

test("getApiKey prefers config, falls back to env, else null", () => {
  const savedCfg = config.firecrawlApiKey;
  const savedEnv = process.env.FIRECRAWL_API_KEY;
  try {
    config.firecrawlApiKey = "cfg-key";
    process.env.FIRECRAWL_API_KEY = "env-key";
    assert.equal(firecrawl.getApiKey(), "cfg-key");
    config.firecrawlApiKey = null;
    assert.equal(firecrawl.getApiKey(), "env-key");
    delete process.env.FIRECRAWL_API_KEY;
    assert.equal(firecrawl.getApiKey(), null);
  } finally {
    config.firecrawlApiKey = savedCfg;
    if (savedEnv === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = savedEnv;
  }
});
export {};
