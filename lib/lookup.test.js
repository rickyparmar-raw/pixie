const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const lookup = require("./lookup");
const programs = require("./programs");

db.open(":memory:");

/* ---------------------------------------------------------- dateFallback -- */
// The timeline's own answer to "is it out yet", used when the docs come up
// empty. It was calling directAnswer(question, programId) — and that second
// parameter is the current date. Every timing question threw
// `now.getTime is not a function`, respond() caught it, and the person got the
// generic error reply instead of the date. Nothing failed loudly enough to
// notice, which is why these tests exist.

const PROG = {
  id: "t-timeline",
  name: "Timeline Test",
  milestones: [{ name: "Timeline Test launch", date: "2020-01-15" }],
};

test("dateFallback answers a timing question from the program's milestones", () => {
  const result = lookup.dateFallback("is timeline test out yet", "", PROG);
  assert.equal(result?.source, "Program timeline");
  assert.match(result.answer, /Timeline Test launch/);
  assert.match(result.answer, /January 15, 2020/);
});

test("dateFallback accepts a bare program id as well as a record", () => {
  programs.saveProgram(PROG);
  programs.invalidate();
  const result = lookup.dateFallback("has timeline test launched", "", "t-timeline");
  assert.equal(result?.source, "Program timeline");
  assert.match(result.answer, /Timeline Test launch/);
});

test("dateFallback returns null for a question that isn't about timing", () => {
  assert.equal(lookup.dateFallback("how do i center a div", "", PROG), null);
});

test("dateFallback falls back to the shared timeline with no program", () => {
  // Whatever the shared milestones say, the call must not throw — that throw
  // is the bug this covers.
  assert.doesNotThrow(() => lookup.dateFallback("when does it drop", "", null));
});

/* ------------------------------------------------------------------ idOf -- */
// Callers hand over a record, an id, or nothing. The cache and corpus key off
// the id; the prompt needs the record.

test("idOf accepts a record, an id, or nothing", () => {
  assert.equal(lookup.idOf({ id: "pixl", name: "Pixl" }), "pixl");
  assert.equal(lookup.idOf("pixl"), "pixl");
  assert.equal(lookup.idOf(null), null);
  assert.equal(lookup.idOf({ name: "no id" }), null);
});

/* --------------------------------------------------------- retrievalQuery -- */

test("retrievalQuery augments follow-up questions with program name and thread context", () => {
  const context = "User: what is pixl and how does it work\nAssistant: pixl is a hack club ysws program!";
  const augmented = lookup.retrievalQuery("how does it work", context, { id: "pixl", name: "Pixl" });
  assert.match(augmented, /Pixl/);
  assert.match(augmented, /what is pixl and how does it work/);
});

test("retrievalQuery leaves standalone non-follow-up questions intact", () => {
  const standalone = "how many pixels for a ps5 controller in the shop";
  const result = lookup.retrievalQuery(standalone, "", { id: "pixl", name: "Pixl" });
  assert.equal(result, standalone);
});

/* ------------------------------ ANSWER PIPELINE characterization (audit) -- */

test("CHAR: deterministic dispatch order is shop, liveShop, calculator, validator, retrieval, dateFallback", async () => {
  const order = [];
  const shop = require("./shop");
  const liveShop = require("./liveShop");
  const calculator = require("./calculator");
  const validator = require("./validator");
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  // Both shop gates key off the program's sources, so the probe program
  // claims both catalogues; stubbed currents keep the answers empty so every
  // stage is reached. The question names a repo + asks for a check so the
  // validator stage fires too, but is stubbed to miss.
  const prog = { id: "char-shop", name: "CharShop", sources: [{ type: "pixl-shop" }, { type: "live-shop" }] };
  const orig = {
    shop: shop.directAnswer, live: liveShop.directAnswer, calc: calculator.directAnswer,
    shopCur: shop.current, liveCur: liveShop.current,
    val: validator.validateRepository, ctx: knowledge.getContext, ans: answer.getAnswerOrChat,
  };
  shop.current = () => ({ items: [{ name: "Unrelated Widget", price: 100 }], economy: shop.DEFAULT_ECONOMY });
  liveShop.current = () => [{ name: "Unrelated Reward", hours: 99 }];
  shop.directAnswer = (...a) => { order.push("shop"); return orig.shop(...a); };
  liveShop.directAnswer = (...a) => { order.push("liveShop"); return orig.live(...a); };
  calculator.directAnswer = (...a) => { order.push("calculator"); return orig.calc(...a); };
  validator.validateRepository = async (...a) => { order.push("validator"); return null; };
  knowledge.getContext = () => { order.push("retrieval"); return ""; };
  answer.getAnswerOrChat = async () => { order.push("answer"); return null; };
  try {
    await lookup.answerOrChat("can you check https://github.com/u/r for submission readiness", "", { program: prog });
    assert.deepEqual(order, ["shop", "liveShop", "calculator", "validator", "retrieval", "answer"]);
  } finally {
    shop.directAnswer = orig.shop; liveShop.directAnswer = orig.live; calculator.directAnswer = orig.calc;
    shop.current = orig.shopCur; liveShop.current = orig.liveCur;
    validator.validateRepository = orig.val; knowledge.getContext = orig.ctx; answer.getAnswerOrChat = orig.ans;
  }
});

test("CHAR: shop path is gated on a pixl-shop source; without one it never fires", () => {
  const shop = require("./shop");
  const data = { items: [{ name: "Test Widget", price: 100 }], economy: shop.DEFAULT_ECONOMY };
  const noShopProg = { id: "noshop", name: "NoShop", sources: [{ type: "docs", name: "Docs" }] };
  assert.equal(lookup.shopAnswer("how much is Test Widget", noShopProg), null);
  const shopProg = { id: "shop", name: "Shop", sources: [{ type: "pixl-shop", name: "Shop" }] };
  const origCurrent = shop.current;
  shop.current = () => data;
  try {
    const hit = lookup.shopAnswer("how much is Test Widget", shopProg);
    assert.ok(hit && hit.direct === true, "shop hit is code-worked (direct) for the gate bypass");
  } finally {
    shop.current = origCurrent;
  }
});

test("CHAR: Firecrawl web fires only inside answerOrChat with allowWebSearch", async () => {
  const firecrawl = require("./firecrawl");
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  let webCalls = 0;
  const origSearch = firecrawl.searchWeb;
  const origCtx = knowledge.getContext;
  const origChat = answer.getAnswerOrChat;
  const origGrounded = answer.getGroundedAnswer;
  firecrawl.searchWeb = async () => { webCalls += 1; return []; };
  knowledge.getContext = () => "";
  answer.getAnswerOrChat = async () => ({ source: null, answer: "" });
  answer.getGroundedAnswer = async () => null;
  try {
    await lookup.answerOrChat("obscure question xyzzy", "", { allowWebSearch: false });
    assert.equal(webCalls, 0, "no web without explicit allowWebSearch");
    await lookup.answerOrChat("obscure question xyzzy", "", { allowWebSearch: true });
    assert.equal(webCalls, 1, "answerOrChat-only web fallback");
    await lookup.lookupAnswer("obscure question xyzzy", "");
    assert.equal(webCalls, 1, "lookupAnswer (docs-only path) never touches the web");
  } finally {
    firecrawl.searchWeb = origSearch; knowledge.getContext = origCtx;
    answer.getAnswerOrChat = origChat; answer.getGroundedAnswer = origGrounded;
  }
});

test("CHAR: cache key includes the program (no cross-program leakage)", () => {
  const cache = require("./cache");
  cache.put("same question everywhere", { source: "Docs", answer: "prog-a answer" }, "prog-a");
  try {
    assert.equal(cache.get("same question everywhere", "prog-b"), null);
    assert.ok(cache.get("same question everywhere", "prog-a"));
  } finally {
    cache.clear?.();
  }
});

