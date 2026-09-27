process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const cache = require("./cache");
const knowledge = require("./knowledge");
const lookup = require("./lookup");
const warm = require("./warm");

db.open(":memory:");

interface WarmAnswer { source: string | null; answer: string }
async function withAnswers(impl: (question: string, contextPrompt: string) => Promise<WarmAnswer>, fn: (asked: string[]) => Promise<void>) {
  const original = lookup.answerOrChat;
  const asked: string[] = [];
  lookup.answerOrChat = async (question: string, contextPrompt: string) => {
    asked.push(question);
    const result = await impl(question, contextPrompt);
    if (result?.source) cache.put(question, result);
    return result;
  };
  try {
    await fn(asked);
  } finally {
    lookup.answerOrChat = original;
  }
}

const docsAnswer = async (question: string) => ({ source: "Pixl FAQ", answer: `answer to ${question}` });

test("warmOne caches a doc-grounded answer", async () => {
  cache.clearCache();
  await withAnswers(docsAnswer, async () => {
    assert.equal(await warm.warmOne("who can join?"), true);
    assert.equal(cache.get("who can join?").answer, "answer to who can join?");
  });
});

test("warmOne refuses to cache an answer the docs did not cover", async () => {
  cache.clearCache();
  await withAnswers(async () => ({ source: null, answer: "no clue, ask a helper" }), async () => {
    assert.equal(await warm.warmOne("something undocumented"), false);
    assert.equal(cache.get("something undocumented"), null);
  });
});

test("warmFaq answers the FAQ questions and skips the ones already known", async () => {
  cache.clearCache();
  const original = knowledge.faqQuestions;
  knowledge.faqQuestions = () => ["who can join?", "is this free?", "do i need a team?"];

  try {
    cache.put("is this free?", { source: "Pixl FAQ", answer: "yep, free" });

    await withAnswers(docsAnswer, async (asked) => {
      const warmed = await warm.warmFaq({ spacingMs: 0 });
      assert.equal(warmed, 2);
      assert.deepEqual(asked, ["who can join?", "do i need a team?"], "the known one is not re-asked");
    });
  } finally {
    knowledge.faqQuestions = original;
  }
});

test("warmFaq does nothing when everything is already warm", async () => {
  cache.clearCache();
  const original = knowledge.faqQuestions;
  knowledge.faqQuestions = () => ["who can join?"];

  try {
    cache.put("who can join?", { source: "Pixl FAQ", answer: "anyone" });
    await withAnswers(docsAnswer, async (asked) => {
      assert.equal(await warm.warmFaq({ spacingMs: 0 }), 0);
      assert.deepEqual(asked, []);
    });
  } finally {
    knowledge.faqQuestions = original;
  }
});

test("refreshStale takes the most-asked stale entries, up to the cap", async () => {
  cache.clearCache();
  const old = Date.now() - 24 * 60 * 60 * 1000;

  for (const [question, asks] of [
    ["rarely asked", 1],
    ["asked a lot", 40],
    ["asked sometimes", 9],
  ]) {
    cache.put(question, { source: "Pixl FAQ", answer: "old" });
    db.handle()
      .query("UPDATE answer_cache SET refreshed_at = ?, ask_count = ? WHERE question_hash = ?")
      .run(old, asks, cache.keyFor(question));
  }
  cache.put("just answered", { source: "Pixl FAQ", answer: "current" });

  await withAnswers(docsAnswer, async (asked) => {
    const refreshed = await warm.refreshStale({ limit: 2, spacingMs: 0 });
    assert.equal(refreshed, 2);
    assert.deepEqual(asked, ["asked a lot", "asked sometimes"], "most-asked first, fresh entry left alone");
  });
});

test("refreshStale does not inflate the ask count of what it refreshes", async () => {
  cache.clearCache();
  const old = Date.now() - 24 * 60 * 60 * 1000;
  cache.put("popular question", { source: "Pixl FAQ", answer: "old" });
  db.handle()
    .query("UPDATE answer_cache SET refreshed_at = ?, ask_count = 12 WHERE question_hash = ?")
    .run(old, cache.keyFor("popular question"));

  await withAnswers(docsAnswer, async () => {
    await warm.refreshStale({ limit: 5, spacingMs: 0 });
  });

  const row = cache.topCached(10).find((r: { question: string }) => r.question === "popular question");
  assert.equal(row.ask_count, 12);
  assert.equal(cache.staleCacheEntries(db.CACHE_FRESH_MS, 10).length, 0, "it is no longer stale");
});

test("refreshStale is a no-op when nothing is stale", async () => {
  cache.clearCache();
  cache.put("fresh question", { source: "Pixl FAQ", answer: "current" });

  await withAnswers(docsAnswer, async (asked) => {
    assert.equal(await warm.refreshStale({ limit: 5, spacingMs: 0 }), 0);
    assert.deepEqual(asked, []);
  });
});

test("a failing answer does not abort the rest of the pass", async () => {
  cache.clearCache();
  const original = knowledge.faqQuestions;
  knowledge.faqQuestions = () => ["explodes", "fine"];

  try {
    await withAnswers(async (question: string) => {
      if (question === "explodes") throw new Error("model on fire");
      return { source: "Pixl FAQ", answer: "ok" };
    }, async () => {
      assert.equal(await warm.warmFaq({ spacingMs: 0 }), 1);
      assert.equal(cache.get("fine").answer, "ok");
    });
  } finally {
    knowledge.faqQuestions = original;
  }
});


test("char: warmFaq asks nothing when the corpus has no questions", async () => {
  cache.clearCache();
  const original = knowledge.faqQuestions;
  knowledge.faqQuestions = () => [];
  try {
    await withAnswers(docsAnswer, async (asked) => {
      assert.equal(await warm.warmFaq({ spacingMs: 0 }), 0);
      assert.deepEqual(asked, []);
    });
  } finally {
    knowledge.faqQuestions = original;
  }
});

test("char: warmFaq honors an explicit limit", async () => {
  cache.clearCache();
  const original = knowledge.faqQuestions;
  knowledge.faqQuestions = () => ["q1?", "q2?", "q3?"];
  try {
    await withAnswers(docsAnswer, async (asked) => {
      assert.equal(await warm.warmFaq({ limit: 1, spacingMs: 0 }), 1);
      assert.equal(asked.length, 1);
    });
  } finally {
    knowledge.faqQuestions = original;
  }
});

test("char: faqQuestions trims and drops blanks", () => {
  const original = knowledge.faqQuestions;
  knowledge.faqQuestions = () => ["  who?  ", "", "   "];
  try {
    assert.deepEqual(warm.faqQuestions(), ["who?"]);
  } finally {
    knowledge.faqQuestions = original;
  }
});

test("char: pacing consts keep background work off the hot path", () => {
  assert.ok(warm.CYCLE_MS >= 60 * 1000);
  assert.ok(warm.PER_CYCLE <= 10);
  assert.ok(warm.SPACING_MS >= 1000);
});
export {};
