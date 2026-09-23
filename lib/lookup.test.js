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

test("arithmeticAnswer evaluates a supported percentage before the model", () => {
  assert.deepEqual(lookup.arithmeticAnswer("what is 18% of $50?"), {
    source: "Arithmetic",
    direct: true,
    answer: "18% of $50 = 9.00",
  });
});

test("arithmeticAnswer leaves unsupported related expressions for the model", () => {
  assert.equal(lookup.arithmeticAnswer("what percentage of the policy is allowed?"), null);
});

test("stale dynamic sources cannot authorize an exact answer", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: false });
  try {
    assert.equal(
      lookup.applyGroundingBoundary(
        { source: "Current policy", answer: "18%" },
        { id: "pixl", sources: [{ name: "Current policy", type: "live-shop" }] },
      ),
      null,
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("Jame Gam accepts its canonical document title as an owned citation", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true });
  try {
    assert.equal(
      lookup.exactClaimAllowed(
        { source: "Jame Gam — Support & Program Docs", answer: "Jame Gam is a game-jam program." },
        { id: "jame-gam", sources: [{ name: "Jame Gam Complete Docs", type: "text" }] },
      ),
      true,
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("Live accepts a markdown section citation from its owned KB", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true });
  try {
    assert.equal(
      lookup.exactClaimAllowed(
        { source: "11. Software time tracking", answer: "Use Hackatime for software time." },
        {
          id: "live-ysws",
          sources: [{ name: "Live YSWS Pixie Knowledge Base", type: "text", url: "file://./LIVE_YSWS_PIXIE_KNOWLEDGE_BASE.md" }],
        },
      ),
      true,
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("Live static policy citations are not rejected without structured evidence", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  try {
    assert.ok(lookup.applyGroundingBoundary(
      { source: "5. Eligibility", answer: "Live YSWS is open to ages 13 through 18." },
      {
        id: "live-ysws",
        sources: [{ name: "Live YSWS Pixie Knowledge Base", type: "text", url: "file://./LIVE_YSWS_PIXIE_KNOWLEDGE_BASE.md" }],
      },
      "Who is eligible to submit to Live YSWS?",
    ));
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("grounding rejects related policy evidence and malformed fenced verdicts", () => {
  assert.equal(
    lookup.exactClaimAllowed(
      {
        source: "Policy",
        groundingVerdict: {
          verdict: "supported",
          claims: [{ claim: "18% is allowed", supported: true, evidenceIds: ["policy"] }],
        },
        evidence: [{ id: "policy", programId: "pixl", supportsClaims: ["18% is allowed for another case"] }],
      },
      { id: "pixl", sources: [] },
    ),
    false,
  );
  assert.equal(
    lookup.exactClaimAllowed(
      { source: "Policy", groundingVerdict: "```json\n{ malformed\n```" },
      { id: "pixl", sources: [] },
    ),
    false,
  );
});

/* ---------------------------------------- authoritative-only classifier -- */
// Fixtures B, C, D, E from the live-failure audit: review mechanics/timing,
// eligibility/hours edge cases, and AI/enforcement must never be answered
// from model prior knowledge — only a matched, current source, with every
// number it states actually present in what was retrieved.

test("isAuthoritativeOnlyTopic flags review, hours, AI, and money/fulfillment questions", () => {
  const yes = [
    "will learning Java count in the hours of making an MC mod?", // fixture B
    "can I journal hand-drawn art?", // fixture C
    "how long will second review take?", // fixture D
    "what exactly is first pass?", // fixture E (part)
    "is my project in the fraud review queue?",
    "why is my project still waiting on review?",
    "how much AI can I use?",
    "when is the exact payout amount going to land?",
    "what's my order status",
  ];
  for (const q of yes) assert.equal(lookup.isAuthoritativeOnlyTopic(q), true, q);

  const no = [
    "what is Pixl?",
    "how do I connect hackatime?",
    "where's the shop?",
    "is Pixl open to people aged 13-18?",
  ];
  for (const q of no) assert.equal(lookup.isAuthoritativeOnlyTopic(q), false, q);
});

test("fixture B/D: an authoritative-only question with no matched source is rejected, never answered from prior knowledge", () => {
  const prog = { id: "pixl", sources: [{ name: "Pixl Docs", type: "text" }] };
  assert.equal(
    lookup.exactClaimAllowed(
      { source: null, answer: "yeah learning Java definitely counts toward your project hours" },
      prog,
      "will learning Java count in the hours of making an MC mod?",
    ),
    false,
  );
  assert.equal(
    lookup.exactClaimAllowed(
      { source: null, answer: "second review usually takes about 3 to 5 days" },
      prog,
      "how long will second review take?",
    ),
    false,
  );
});

test("fixture E: a matched source authorizes only the exact number it contains, never an invented one alongside it", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  const prog = { id: "pixl", sources: [{ name: "Pixl Docs", type: "text" }] };
  const corpus = "Pixl Docs\nReview: no fixed SLA is published; review can take anywhere from a few days to about two weeks.";
  try {
    assert.equal(
      lookup.exactClaimAllowed(
        { source: "Pixl Docs", answer: "second review usually takes exactly 5 days" },
        prog,
        "how long will second review take?",
        corpus,
      ),
      false,
      "an invented digit-count SLA must be rejected even with a matched source",
    );
    assert.equal(
      lookup.exactClaimAllowed(
        { source: "Pixl Docs", answer: "there's no fixed SLA — it can take anywhere from a few days to about two weeks" },
        prog,
        "how long will second review take?",
        corpus,
      ),
      true,
      "restating exactly what the source says (with no invented digit claim) must be allowed",
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("numericClaimsGrounded rejects invented digit-bearing claims and allows ones the corpus actually states", () => {
  assert.equal(lookup.numericClaimsGrounded("your project has an 80% chance of passing", "nothing here about odds"), false);
  assert.equal(lookup.numericClaimsGrounded("software is capped at 30% AI", "the AI policy caps software code at 30% AI usage"), true);
  assert.equal(lookup.numericClaimsGrounded("that sounds right to me", "irrelevant corpus text"), true, "no numeric claim at all is always fine");
  assert.equal(lookup.numericClaimsGrounded("80% chance", ""), true, "no corpus supplied is a no-op, not a reject");
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

test("walled programs do not inherit shared shop sources or milestones", () => {
  const shop = require("./shop");
  const originalCurrent = shop.current;
  const shared = programs.shared;
  shop.current = () => ({ items: [{ name: "Shared Widget", price: 10 }], economy: shop.DEFAULT_ECONOMY });
  programs.shared = () => ({ sources: [{ name: "Shared shop", type: "pixl-shop" }], milestones: [{ name: "shared launch", date: "2020-01-01" }] });
  try {
    const walled = { id: "walled", sharedSources: false, sources: [], milestones: [] };
    assert.equal(lookup.shopAnswer("how much is Shared Widget", walled), null);
    assert.equal(lookup.dateFallback("when does it launch", "", walled), null);
  } finally {
    shop.current = originalCurrent;
    programs.shared = shared;
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
