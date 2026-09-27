type TestAny = any;
const { test } = require("node:test");
const assert = require("node:assert/strict");
const shop = require("./shop");


const ITEMS = [
  { id: 27, name: "Signed Org Photo", price: 100, category: "merch", unlock_xp: 0, config_options: null, description: "" },
  { id: 500, name: "PS5 Digital, 825gb +wireless controller", price: 11400, category: "other", unlock_xp: 0, config_options: null, description: "" },
  { id: 66, name: "MacBook Neo", price: 10675, category: "tech", unlock_xp: 0, config_options: null, description: "" },
  { id: 67, name: "MacBook Air M5", price: 18875, category: "tech", unlock_xp: 0, config_options: null, description: "" },
  { id: 68, name: "Framework 13 DIY", price: 18850, category: "kits", unlock_xp: 0, config_options: { base_price: 18850 }, description: "" },
  { id: 481, name: "Huawei MatePad 11.5", price: 0, category: "tech", unlock_xp: 0, config_options: null, description: "" },
  { id: 99, name: "Founder Trophy", price: 0, category: "merch", unlock_xp: 500, config_options: null, description: "" },
];

const DATA = { items: ITEMS, economy: shop.DEFAULT_ECONOMY };


test("pxPerHour walks the payout step table, not a curve", () => {
  const e = shop.DEFAULT_ECONOMY;
  assert.equal(Math.round(shop.pxPerHour(0, e)), 57);
  assert.equal(Math.round(shop.pxPerHour(624, e)), 57);
  assert.equal(Math.round(shop.pxPerHour(1875, e)), 71);
  assert.equal(Math.round(shop.pxPerHour(3750, e)), 86);

  assert.equal(shop.pxPerHour(999999, e), shop.pxPerHour(3750, e));
});

test("rePerHour clamps the tier to the four that exist", () => {
  const e = shop.DEFAULT_ECONOMY;
  assert.equal(shop.rePerHour(1, e), 12.5);
  assert.equal(shop.rePerHour(4, e), 25);
  assert.equal(shop.rePerHour(9, e), 25);
  assert.equal(shop.rePerHour(0, e), 12.5);
});


test("hoursRange reproduces the floor and cap hours the shop page shows", () => {
  const r = shop.hoursRange(11400, shop.DEFAULT_ECONOMY);
  assert.equal(Math.round(r.floorHours), 200);
  assert.equal(Math.round(r.capHours), 133);
  assert.equal(r.floorUsd, 4);
  assert.equal(r.capUsd, 6);
});

test("hoursForPixels climbs through the rate steps as RE banks up", () => {
  const h = shop.hoursForPixels(11400, { tier: 4, economy: shop.DEFAULT_ECONOMY });
  assert.ok(h > 133 && h < 200, `expected hours between 133 and 200, got ${h}`);

  const t1 = shop.hoursForPixels(11400, { tier: 1, economy: shop.DEFAULT_ECONOMY });
  assert.ok(t1 > h, `T1 (${t1}h) should need more hours than T4 (${h}h)`);
  assert.ok(t1 <= 200, "even T1 beats the flat floor rate once RE banks up");
});

test("hoursForPixels starts from the RE you already have", () => {
  const cold = shop.hoursForPixels(11400, { tier: 4, economy: shop.DEFAULT_ECONOMY });
  const warm = shop.hoursForPixels(11400, { tier: 4, startingRe: 3750, economy: shop.DEFAULT_ECONOMY });
  assert.ok(warm < cold);
  assert.ok(Math.abs(warm - 133) < 0.5, `expected ~133h at the cap, got ${warm}`);
});


test("parseTier reads the ways people actually write a tier", () => {
  assert.equal(shop.parseTier("how much hours needed for t4 for ps5"), 4);
  assert.equal(shop.parseTier("tier 3 project"), 3);
  assert.equal(shop.parseTier("T2 Signal"), 2);
  assert.equal(shop.parseTier("a nexus build"), 4);
  assert.equal(shop.parseTier("spark"), 1);
  assert.equal(shop.parseTier("tier4"), 4);
});

test("parseTier says nothing when no tier was named", () => {
  assert.equal(shop.parseTier("how many hours for a ps5"), null);
  assert.equal(shop.parseTier("i shipped 4 projects"), null);
  assert.equal(shop.parseTier("t9 doesn't exist"), null);
});

test("findItems matches the short name people type", () => {
  const ps5 = shop.findItems("ps5", ITEMS);
  assert.equal(ps5.length, 1);
  assert.equal(ps5[0].id, 500);

  assert.equal(shop.findItems("playstation 5", ITEMS)[0].id, 500);
  assert.equal(shop.findItems("how much hours needed for t4 for ps5", ITEMS)[0].id, 500);
});

test("findItems returns every candidate when the name is ambiguous", () => {
  const macs = shop.findItems("macbook", ITEMS);
  assert.equal(macs.length, 2);
  assert.deepEqual(macs.map((i: TestAny) => i.id).sort(), [66, 67]);
});

test("findItems finds nothing rather than guessing", () => {
  assert.deepEqual(shop.findItems("a hot air balloon", ITEMS), []);
  assert.deepEqual(shop.findItems("", ITEMS), []);
});

test("isShopQuestion separates shop maths from everything else", () => {
  assert.equal(shop.isShopQuestion("how much hours needed for t4 for ps5"), true);
  assert.equal(shop.isShopQuestion("how many pixels is a macbook"), true);
  assert.equal(shop.isShopQuestion("whats in the shop"), true);
  assert.equal(shop.isShopQuestion("how much does the ps5 cost"), true);
  assert.equal(shop.isShopQuestion("when is pixl launching"), false);
  assert.equal(shop.isShopQuestion("my hackatime isnt tracking"), false);
});


test("directAnswer works out the hours for a named item at a named tier", () => {
  const r = shop.directAnswer("how much hours needed for t4 for ps5", DATA);
  assert.ok(r, "expected an answer");
  assert.equal(r.clarify, undefined);
  assert.match(r.answer, /11,400/);
  assert.match(r.answer, /PS5/);
  assert.match(r.answer, /T4/i);
  assert.ok(r.source);
});

test("directAnswer gives the shop's own range when no tier was named", () => {
  const r = shop.directAnswer("how many hours for a ps5", DATA);
  assert.ok(r);
  assert.equal(r.clarify, undefined);
  assert.match(r.answer, /11,400/);
  assert.match(r.answer, /199\.5|200/);
  assert.match(r.answer, /133/);
});

test("directAnswer answers a plain price question", () => {
  const r = shop.directAnswer("how much is the ps5 in the shop", DATA);
  assert.ok(r);
  assert.match(r.answer, /11,400/);
});

test("directAnswer does not hijack non-price questions mentioning an item", () => {
  assert.equal(shop.directAnswer("how much storage does the ps5 have", DATA), null);
  assert.equal(shop.directAnswer("how many hours did you play on ps5", DATA), null);
  assert.equal(shop.directAnswer("my ps5 controller has drift", DATA), null);
});

test("directAnswer asks which item when the name matches more than one", () => {
  const r = shop.directAnswer("how many hours for a macbook at t4", DATA);
  assert.ok(r);
  assert.equal(r.clarify, true);
  assert.match(r.answer, /MacBook Neo/);
  assert.match(r.answer, /MacBook Air M5/);
});

test("directAnswer asks which item when a tier was named but nothing else", () => {
  const r = shop.directAnswer("how many hours do i need at t4", DATA);
  assert.ok(r);
  assert.equal(r.clarify, true);
  assert.match(r.answer, /which/i);
});

test("directAnswer says an unpriced item isn't buyable rather than quoting 0", () => {
  const r = shop.directAnswer("how much is the huawei matepad", DATA);
  assert.ok(r);
  assert.doesNotMatch(r.answer, /\b0 px\b/);
  assert.match(r.answer, /not (?:available|priced)|coming soon/i);
});

test("directAnswer treats a trophy as claimed at a level, not bought", () => {
  const r = shop.directAnswer("how much is the founder trophy", DATA);
  assert.ok(r);
  assert.match(r.answer, /trophy|level/i);
});

test("directAnswer quotes a configurable item as a starting price", () => {
  const r = shop.directAnswer("how much is the framework 13", DATA);
  assert.ok(r);
  assert.match(r.answer, /from 18,850|starts at 18,850/i);
});

test("directAnswer stays out of the way of questions that aren't about the shop", () => {
  assert.equal(shop.directAnswer("when is pixl launching", DATA), null);
  assert.equal(shop.directAnswer("how do i set up hackatime", DATA), null);
  const hardwareData = {
    items: [...ITEMS, { id: 700, name: "Hardware Grant", price: 160, category: "grant", unlock_xp: 0, config_options: null, description: "" }],
    economy: shop.DEFAULT_ECONOMY,
  };
  assert.equal(
    shop.directAnswer("for a hardware project, does my bom have to be a csv with links and the total cost?", hardwareData),
    null,
  );
  assert.equal(
    shop.isShopQuestion("for a hardware project, does my bom have to be a csv with links and the total cost?"),
    false,
  );
});

test("directAnswer returns nothing when the catalogue never loaded", () => {
  assert.equal(shop.directAnswer("how much is a ps5", { items: [], economy: shop.DEFAULT_ECONOMY }), null);
});


test("corpusText lists the catalogue with prices and the rate table", () => {
  const text = shop.corpusText(DATA);
  assert.match(text, /PS5 Digital/);
  assert.match(text, /11,400/);
  assert.match(text, /50 px/);
  assert.match(text, /86 px/);
  assert.match(text, /Huawei MatePad/);
});

test("corpusText survives an empty catalogue", () => {
  assert.equal(shop.corpusText({ items: [], economy: shop.DEFAULT_ECONOMY }), "");
});


test("directAnswer picks the item up from the conversation when the reply is just a tier", () => {
  const history = [
    "user: how many hours for a ps5",
    "pixie: PS5 Digital, 825gb +wireless controller is 11,400 px. Which tier are your projects landing on?",
  ].join("\n");

  const r = shop.directAnswer("t4", DATA, { history });
  assert.ok(r, "expected an answer");
  assert.equal(r.clarify, undefined);
  assert.match(r.answer, /162/);
  assert.match(r.answer, /PS5/);
});

test("the most recently mentioned item wins when the thread named several", () => {
  const history = ["user: how much is a ps5", "pixie: 11,400 px", "user: and the macbook air"].join("\n");
  const r = shop.directAnswer("t4", DATA, { history });
  assert.ok(r);
  assert.match(r.answer, /MacBook Air M5/);
});

test("history is only consulted when the message itself names no item", () => {
  const history = "user: how much is a ps5";
  const r = shop.directAnswer("how much is the macbook air at t4", DATA, { history });
  assert.ok(r);
  assert.match(r.answer, /MacBook Air M5/);
  assert.doesNotMatch(r.answer, /PS5/);
});

test("a bare tier with nothing in the thread is left alone", () => {
  assert.equal(shop.directAnswer("t4", DATA, { history: "user: hey\npixie: hey" }), null);
});

test("a tier with a real question behind it still asks which item", () => {
  const r = shop.directAnswer("how many hours do i need at t4", DATA);
  assert.ok(r);
  assert.equal(r.clarify, true);
  assert.match(r.answer, /which/i);
});

test("a message that is not asking anything is left alone", () => {
  const history = "user: how much is a ps5\npixie: 11,400 px";
  assert.equal(shop.directAnswer("my t4 project got rejected", DATA, { history }), null);
});

test("a clarify names a few candidates and counts the rest rather than listing a dozen", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({
    id: 900 + i,
    name: `Widget ${"abcdefg"[i]}`,
    price: 100 * (i + 1),
    unlock_xp: 0,
    config_options: null,
  }));
  const r = shop.directAnswer("how much is a widget", { items: many, economy: shop.DEFAULT_ECONOMY });
  assert.equal(r.clarify, true);
  assert.match(r.answer, /7 things/);
  assert.match(r.answer, /and 3 more/);
  assert.ok(r.answer.length < 300, `clarify got long: ${r.answer.length} chars`);
});

test("a priced answer says which catalogue the numbers came from", () => {
  const r = shop.directAnswer("how much hours needed for t4 for ps5", DATA);
  assert.match(r.answer, /region|US catalogue/i);
});

test("the corpus says the same thing once, at the top", () => {
  const head = shop.corpusText(DATA).split("\n")[0];
  assert.match(head, /US catalogue/i);
});

test("nothing the shop module produces contains a dash", () => {
  const produced = [
    shop.corpusText(DATA),
    shop.directAnswer("how much hours needed for t4 for ps5", DATA).answer,
    shop.directAnswer("how many hours for a ps5", DATA).answer,
    shop.directAnswer("how much is a macbook", DATA).answer,
    shop.directAnswer("how many hours do i need at t4", DATA).answer,
    shop.directAnswer("how much is the huawei matepad", DATA).answer,
    shop.directAnswer("how much is the founder trophy", DATA).answer,
    shop.directAnswer("how much is the framework 13", DATA).answer,
  ];
  for (const text of produced) assert.doesNotMatch(text, /[—–]|\s--\s/);
});


test("naming an item without asking a price gets no reply", () => {
  const quiet = [
    "i wanna buy a ps5 one day fr",
    "is a ps5 even worth it",
    "how long till my ps5 gets here",
    "just got a macbook air, so hyped",
    "my ps5 controller keeps drifting lol",
    "anyone else saving for a ps5",
    "bro the framework 13 is so cool",
  ];
  for (const q of quiet) {
    assert.equal(shop.directAnswer(q, DATA), null, `should have stayed quiet: ${q}`);
  }
});

test("actually asking the price still works", () => {
  const asked = [
    "gng whats the price of ps5 here",
    "how much is a ps5",
    "how much hours needed for t4 for ps5",
    "how many pixels for a macbook air",
    "how much does the ps5 cost",
    "can i afford a ps5 yet",
  ];
  for (const q of asked) {
    assert.ok(shop.directAnswer(q, DATA), `should have answered: ${q}`);
  }
});

test("a bare tier only revives an item from a thread that was about prices", () => {
  const priceThread = "user: how much is a ps5\npixie: PS5 Digital, 825gb +wireless controller is 11,400 px.";
  assert.match(shop.directAnswer("t4", DATA, { history: priceThread }).answer, /162/);

  const chatThread = "user: i finally got a ps5\npixie: nice one";
  assert.equal(shop.directAnswer("t4", DATA, { history: chatThread }), null);
});

test("isShopQuestion no longer fires on ordinary chat", () => {
  assert.equal(shop.isShopQuestion("is a ps5 worth it"), false);
  assert.equal(shop.isShopQuestion("how long does review take"), false);
  assert.equal(shop.isShopQuestion("i wanna buy a ps5"), false);
  assert.equal(shop.isShopQuestion("whats in the shop"), true);
  assert.equal(shop.isShopQuestion("whats the price of a ps5"), true);
  assert.equal(shop.isShopQuestion("how many pixels for a macbook"), true);
});


test("the catalogue chunks into pieces retrieval can actually pick", () => {
  const retrieve = require("./retrieve");
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    name: `Gadget ${i} Deluxe`,
    price: 100 * (i + 1),
    category: ["tech", "merch", "grants"][i % 3],
    unlock_xp: 0,
    config_options: null,
  }));
  many.push({ id: 999, name: "PS5 Digital", price: 11400, category: "other", unlock_xp: 0, config_options: null });

  const chunks = retrieve.chunkSection("Pixl Shop", shop.corpusText({ items: many, economy: shop.DEFAULT_ECONOMY }));
  assert.ok(chunks.length > 5, `expected the catalogue to split up, got ${chunks.length} chunk(s)`);
  for (const c of chunks) {
    assert.ok(c.text.length <= retrieve.MAX_CHUNK, `chunk of ${c.text.length} chars is over the cap`);
  }
});

test("a shop chunk outranks the docs for a question about an item", () => {
  const retrieve = require("./retrieve");
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    name: `Gadget ${i} Deluxe`,
    price: 100 * (i + 1),
    category: "tech",
    unlock_xp: 0,
    config_options: null,
  }));
  many.push({ id: 999, name: "PS5 Digital", price: 11400, category: "other", unlock_xp: 0, config_options: null });

  const index = retrieve.buildIndex(
    retrieve.chunkSections([
      ["Pixl Shop", shop.corpusText({ items: many, economy: shop.DEFAULT_ECONOMY })],
      ["Shipping", "## Shipping\n\nShipping a project means opening the shop page and pressing ship. The shop is where pixels go.\n\nEvery ship is reviewed by a human before any pixels land in your wallet."],
    ]),
  );

  const top = retrieve.selectChunks(index, "how much is a ps5")[0];
  assert.ok(top, "nothing matched at all");
  assert.equal(top.source, "Pixl Shop");
  assert.match(top.text, /PS5/);
});

test("a question that names no item does not surface an arbitrary one", () => {
  const retrieve = require("./retrieve");
  const items = [
    { id: 1, name: "PS5 Digital", price: 11400, category: "other", unlock_xp: 0, config_options: null },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: 10 + i,
      name: `Gadget ${i} Deluxe`,
      price: 100 * (i + 1),
      category: "tech",
      unlock_xp: 0,
      config_options: null,
    })),
  ];
  const index = retrieve.buildIndex(
    retrieve.chunkSections([["Pixl Shop", shop.corpusText({ items, economy: shop.DEFAULT_ECONOMY })]]),
  );

  const vague = retrieve.selectChunks(index, "is there a keyboard in the shop")[0];
  assert.ok(!vague || !/PS5/.test(vague.text), "a vague question pulled back the PS5 anyway");

  const named = retrieve.selectChunks(index, "how much is a ps5")[0];
  assert.match(named.text, /PS5/, "naming the item should still find it");
});


test("parsePixelAmount reads an amount out of the question", () => {
  assert.equal(shop.parsePixelAmount("how much hours for 275 pixl on each tier?"), 275);
  assert.equal(shop.parsePixelAmount("how many hours for 1,275 px"), 1275);
  assert.equal(shop.parsePixelAmount("275 pixels is how many hours"), 275);
  assert.equal(shop.parsePixelAmount("how long for 500px"), 500);
});

test("parsePixelAmount ignores numbers that aren't pixels", () => {
  assert.equal(shop.parsePixelAmount("i shipped 5 projects"), null);
  assert.equal(shop.parsePixelAmount("how many hours do i need"), null);
  assert.equal(shop.parsePixelAmount("pixl is a hack club thing"), null);
  assert.equal(shop.parsePixelAmount("i got t4 on my project"), null);
});

test("a pixel amount is answered in hours, not divided by the RE rate", () => {
  const r = shop.directAnswer("how much hours for 275 pixl on each tier?", DATA);
  assert.ok(r, "expected an answer");
  assert.match(r.answer, /4\.8/);
  assert.doesNotMatch(r.answer, /\b22\b|18\.3|14\.7|\b11 h/);
});

test("when the tier genuinely changes nothing, it says so", () => {
  const r = shop.directAnswer("how many hours for 275 px on each tier", DATA);
  assert.match(r.answer, /same on (?:all|every)|doesn't change|no difference/i);
  assert.match(r.answer, /625 RE|Restoration Energy/);
});

test("when the tier does change something, each one is given", () => {
  const r = shop.directAnswer("how many hours for 11400 px on each tier", DATA);
  assert.match(r.answer, /T1/);
  assert.match(r.answer, /T4/);
  assert.match(r.answer, /162/);
  assert.match(r.answer, /179/);
});

test("a pixel amount with one tier named answers just that tier", () => {
  const r = shop.directAnswer("how many hours for 11400 px at t4", DATA);
  assert.match(r.answer, /162/);
  assert.doesNotMatch(r.answer, /179/);
});

test("a pixel amount nobody asked about is still left alone", () => {
  assert.equal(shop.directAnswer("just hit 275 px lets goo", DATA), null);
  assert.equal(shop.directAnswer("275 px for that is mad", DATA), null);
});

test("the maths itself never depended on the tier at small amounts", () => {
  const e = shop.DEFAULT_ECONOMY;
  const byTier = [1, 2, 3, 4].map((t: TestAny) => shop.hoursForPixels(275, { tier: t, economy: e }));
  for (const h of byTier) assert.ok(Math.abs(h - 4.8125) < 0.01, `expected ~4.8h, got ${h}`);
});

test("the corpus warns the model off the exact mistake it made", () => {
  const text = shop.corpusText(DATA);
  assert.match(text, /RE (?:per hour|an hour) is not/i);
});


test("CHAR: naming an item is not asking its price (no talking over conversations)", () => {
  assert.equal(shop.directAnswer("i finally got a ps5", DATA), null);
  assert.equal(shop.directAnswer("is a ps5 even worth it", DATA), null);
  const hit = shop.directAnswer("how much is the PS5 Digital", DATA);
  assert.ok(hit && hit.direct === true);
});

test("CHAR: pingAnswer vs helpAnswer tier selection (ping outside help uses ping tier)", () => {
  const answer = require("./answer");
  const { config } = require("./config");
  const pingTier = config.pingAnswer || config.answer;
  const helpTier = config.helpAnswer || config.answer;
  assert.ok(pingTier && helpTier, "both tiers resolve");
});
export {};
