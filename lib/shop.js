// The Pixl shop: what things cost, and how many hours of shipped work that is.
//
// Two different questions live here and they have different answers. "How much
// is a PS5" is a lookup. "How many hours do I need at T4 for a PS5" is
// arithmetic over the payout table, and the model gets it wrong often enough
// that it is worked out in code and handed over as a finished answer — the same
// shape lib/program.js uses for date questions.
//
// The maths is ported from the site's own pixl.js, which is generated from
// packages/config/pixl.json. Both are refreshed at runtime; DEFAULT_ECONOMY
// below is the mirror that keeps this working when the fetch fails.
const axios = require("axios");
const log = require("./log");

const CATALOGUE_URL = "https://server.pixl.hackclub.com/api/shop/items";
const ECONOMY_URL = "https://raw.githubusercontent.com/hackclub/pixl/main/packages/config/pixl.json";

// Mirrored from packages/config/pixl.json. Only ever a fallback: refresh()
// overwrites it from the URL above, because these numbers have moved before
// and a stale rate quoted confidently is worse than no answer.
const DEFAULT_ECONOMY = {
  pixelValueUsd: 0.07,
  basePayoutUsd: 3.5,
  maxPayoutUsd: 6.0,
  payoutSteps: [
    { re: 0, usd: 3.5 },
    { re: 1250, usd: 3.75 },
    { re: 2500, usd: 4.0 },
    { re: 3750, usd: 4.5 },
    { re: 5000, usd: 5.0 },
    { re: 6250, usd: 5.5 },
    { re: 7500, usd: 6.0 },
  ],
  tierRePerHour: [12.5, 15, 18.75, 25],
};

const TIER_NAMES = ["Spark", "Signal", "Grid", "Nexus"];

/* ------------------------------------------------------------- the maths -- */

// RE banked per shipped hour, by the tier a reviewer gave the project. Clamped
// the same way the site clamps it, so a nonsense tier lands on T1 rather than
// throwing.
function rePerHour(tier, economy = DEFAULT_ECONOMY) {
  const table = economy.tierRePerHour || DEFAULT_ECONOMY.tierRePerHour;
  const t = Math.min(Math.max(Math.trunc(tier) || 1, 1), table.length);
  return table[t - 1];
}

// A flat step table, not a curve: the rate is whichever step's threshold is the
// highest one your lifetime RE has already passed.
function payoutUsdPerHour(re, economy = DEFAULT_ECONOMY) {
  const steps = economy.payoutSteps || DEFAULT_ECONOMY.payoutSteps;
  const r = Math.max(Number(re) || 0, 0);
  let usd = steps[0].usd;
  for (const step of steps) {
    if (r < step.re) break;
    usd = step.usd;
  }
  return usd;
}

function pxPerHour(re, economy = DEFAULT_ECONOMY) {
  return payoutUsdPerHour(re, economy) / (economy.pixelValueUsd || DEFAULT_ECONOMY.pixelValueUsd);
}

// The two numbers the shop page prints under every price. Prices are set at the
// payout floor, so the floor figure is the honest "if you never bank any RE"
// cost and the cap figure is the best it can ever get.
function hoursRange(px, economy = DEFAULT_ECONOMY) {
  const floorUsd = economy.basePayoutUsd ?? DEFAULT_ECONOMY.basePayoutUsd;
  const capUsd = economy.maxPayoutUsd ?? DEFAULT_ECONOMY.maxPayoutUsd;
  const value = economy.pixelValueUsd || DEFAULT_ECONOMY.pixelValueUsd;
  return {
    floorUsd,
    capUsd,
    floorHours: px / (floorUsd / value),
    capHours: px / (capUsd / value),
  };
}

// Hours of shipped work to reach `px`, shipping at one tier the whole way.
//
// Walks the rate table segment by segment rather than dividing once, because
// the rate is not constant: every hour banks RE, and crossing a threshold lifts
// what the remaining hours pay. Assumes the hours arrive across several ships,
// which is the conservative reading — one enormous single ship does slightly
// better, since a ship pays its whole self at the rate it finishes on.
function hoursForPixels(px, { tier = 4, startingRe = 0, economy = DEFAULT_ECONOMY } = {}) {
  const target = Math.max(Number(px) || 0, 0);
  if (target === 0) return 0;

  const steps = economy.payoutSteps || DEFAULT_ECONOMY.payoutSteps;
  const perHour = rePerHour(tier, economy);
  let remaining = target;
  let hours = 0;
  let re = Math.max(Number(startingRe) || 0, 0);

  // One pass per step at most, plus the final partial segment.
  for (let guard = 0; guard <= steps.length; guard += 1) {
    const rate = pxPerHour(re, economy);
    const next = steps.find((s) => s.re > re);
    if (!next) return hours + remaining / rate;

    const hoursToNext = (next.re - re) / perHour;
    const pxInSegment = hoursToNext * rate;
    if (remaining <= pxInSegment) return hours + remaining / rate;

    hours += hoursToNext;
    remaining -= pxInSegment;
    re = next.re;
  }
  return hours + remaining / pxPerHour(re, economy);
}

/* ------------------------------------------------------- reading the ask -- */

function parseTier(text) {
  const t = String(text || "").toLowerCase();
  const numbered = t.match(/\b(?:t|tier)\s*-?\s*([1-4])\b/);
  if (numbered) return Number(numbered[1]);
  for (let i = 0; i < TIER_NAMES.length; i += 1) {
    if (new RegExp(`\\b${TIER_NAMES[i].toLowerCase()}\\b`).test(t)) return i + 1;
  }
  return null;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words that are model suffixes or catalogue filler rather than the name of a
// thing. On their own they match half the shelf ("air" is in MacBook Air and in
// a hot air balloon), so they only ever count inside a longer phrase.
const WEAK_TOKENS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "with", "plus", "new",
  "pro", "max", "mini", "air", "neo", "ultimate", "standard", "edition", "limited",
  "license", "licence", "grant", "grants", "kit", "kits", "starter", "set", "pack",
  "digital", "wireless", "controller", "stackable", "gen", "small", "large",
  "tb", "gb", "diy", "only", "your", "choice", "series",
  // The program's own name is on half the merch, so it identifies nothing on
  // its own — without this, "is it worth doing pixl" comes back as a price
  // list for the hoodie, the poster, the stickers and the cookie cutter.
  "pixl", "pixel", "pixels",
]);

// What people type versus what the catalogue calls it.
const ALIASES = [
  [/\bplay\s*station\s*(\d)\b/g, "ps$1"],
  [/\braspberry\s*pi\b/g, "raspberry pi"],
  [/\brpi\b/g, "raspberry pi"],
  [/\bmac\s*book\b/g, "macbook"],
  [/\bair\s*pods\b/g, "airpods"],
];

function applyAliases(normalized) {
  return ALIASES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), normalized);
}

function priceOf(item) {
  const base = item?.config_options?.base_price;
  return Number(base != null ? base : item?.price) || 0;
}

function isTrophy(item) {
  return Number(item?.unlock_xp || 0) > 0;
}

function isUnpriced(item) {
  return priceOf(item) <= 0;
}

// Contiguous phrases from an item's name that are specific enough to identify
// it. Single words qualify only when they are the head of the name or long and
// unique across the catalogue — otherwise "set" matches the screwdriver set,
// the sticker pack and nothing anybody meant.
function itemPhrases(item, frequencies) {
  const tokens = normalize(item.name).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];

  const phrases = [];
  for (let size = tokens.length; size >= 2; size -= 1) {
    for (let i = 0; i + size <= tokens.length; i += 1) {
      phrases.push(tokens.slice(i, i + size).join(" "));
    }
  }
  for (const [i, token] of tokens.entries()) {
    if (WEAK_TOKENS.has(token)) continue;
    const isHead = i === 0;
    const isDistinctive = token.length >= 4 && (frequencies.get(token) || 0) === 1;
    if (isHead || isDistinctive) phrases.push(token);
  }
  return phrases;
}

function tokenFrequencies(items) {
  const counts = new Map();
  for (const item of items) {
    for (const token of new Set(normalize(item.name).split(" ").filter(Boolean))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

// Every item the text could be naming, best matches first. Returns all of the
// joint-best rather than one winner: two equally good matches is the case worth
// asking about, not the case worth guessing at.
function findItems(text, items) {
  const haystack = ` ${applyAliases(normalize(text))} `;
  if (haystack.trim() === "" || !Array.isArray(items) || items.length === 0) return [];

  const frequencies = tokenFrequencies(items);
  const scored = [];
  for (const item of items) {
    let best = 0;
    for (const phrase of itemPhrases(item, frequencies)) {
      if (!haystack.includes(` ${phrase} `)) continue;
      best = Math.max(best, phrase.split(" ").length);
    }
    if (best > 0) scored.push({ item, score: best });
  }
  if (scored.length === 0) return [];

  const top = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === top).map((s) => s.item);
}

// Filler around a tier in a reply that is only naming a tier. Stripping these
// and finding nothing left is what separates "t4" — an answer to pixie's own
// question — from "my t4 project got rejected", which is about something else.
const TIER_REPLY_FILLER =
  /\b(?:at|on|in|im|i|m|its|it|is|are|the|a|an|for|to|do|doing|ship|shipping|shipped|my|our|project|projects|would|be|say|maybe|probably|guess|think|reckon|prob|all|mostly|usually|mine|yeah|yea|ok|okay)\b/g;

function isBareTierReply(text) {
  const stripped = normalize(text)
    .replace(/\b(?:t|tier)\s*-?\s*[1-4]\b/g, " ")
    .replace(new RegExp(`\\b(?:${TIER_NAMES.join("|").toLowerCase()})\\b`, "g"), " ")
    .replace(TIER_REPLY_FILLER, " ");
  return stripped.split(/\s+/).filter(Boolean).length === 0;
}

// The last thing in the thread that named something off the shelf. Walked from
// the end because a thread that moved from one item to another is asking about
// the second one, not the first.
function lastMentionedItems(history, items) {
  const lines = String(history || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const found = findItems(lines[i], items);
    if (found.length > 0) return found;
  }
  return [];
}

const SHOP_WORD = /\b(?:shop|catalog(?:ue)?|store|shelves)\b/i;
const PRICE_WORD = /\b(?:price|prices|pricing|cost|costs|worth|afford|buy|purchase)\b/i;
const QUANTITY_ASK = /\b(?:how much|how many|how long)\b/i;
const CURRENCY_WORD = /\b(?:px|pixel|pixels|hour|hours|hr|hrs)\b/i;

function isShopQuestion(text) {
  const t = String(text || "");
  if (SHOP_WORD.test(t)) return true;
  if (PRICE_WORD.test(t)) return true;
  return QUANTITY_ASK.test(t) && CURRENCY_WORD.test(t);
}

/* -------------------------------------------------------------- wording -- */

function fmtPx(n) {
  return Math.round(n).toLocaleString("en-US");
}

function fmtHours(h) {
  const r = Math.round(h * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function fmtUsd(usd) {
  return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
}

// The shop API serves the US catalogue to anyone without a session, and pixie
// has no session. Someone in another region sees different stock and different
// prices on the same page, so every quoted number says where it came from.
const REGION_NOTE = "These are the US catalogue prices; the shop page shows your own region's if you're somewhere else.";

function priceLine(item) {
  if (isTrophy(item)) {
    return `${item.name} is a trophy, not something you buy. Trophies unlock at a level and you claim them free once you get there. This one is at ${fmtPx(item.unlock_xp)} XP.`;
  }
  if (isUnpriced(item)) {
    return `${item.name} is in the catalogue but has no price on it, which is the "not available" state: it isn't stocked for your region yet. Nothing to work hours out for until it is.`;
  }
  const px = fmtPx(priceOf(item));
  return item.config_options
    ? `${item.name} starts at ${px} px, and it's configurable, so the final price depends on the options you pick.`
    : `${item.name} is ${px} px.`;
}

function rangeLine(px, economy) {
  const r = hoursRange(px, economy);
  return (
    `Every price is set at the payout floor, so that's ${fmtHours(r.floorHours)}h at the ${fmtUsd(r.floorUsd)}/h floor rate, ` +
    `down to ${fmtHours(r.capHours)}h once your Restoration Energy has you at the ${fmtUsd(r.capUsd)}/h cap.`
  );
}

function tierLine(px, tier, economy) {
  const hours = hoursForPixels(px, { tier, economy });
  return (
    `At T${tier} ${TIER_NAMES[tier - 1]} (${rePerHour(tier, economy)} RE an hour) starting from no banked RE, ` +
    `that's about ${fmtHours(hours)}h of shipped time. You open at ${fmtPx(pxPerHour(0, economy))} px an hour and the rate steps up as your lifetime RE climbs.`
  );
}

/* ------------------------------------------------------------- answering -- */

// A finished answer, a question back, or null when this isn't a shop question
// after all. Null is the common case and matters: it hands the message straight
// back to the ordinary docs path instead of forcing a shop-shaped reply.
function directAnswer(question, data, { history = "" } = {}) {
  const items = data?.items || [];
  const economy = data?.economy || DEFAULT_ECONOMY;
  if (items.length === 0) return null;

  const source = "Pixl Shop";
  // Marks every answer below as worked out in code rather than by the model —
  // see lib/respond.js, which lets these past the intent gate.
  const direct = true;
  const tier = parseTier(question);
  let matches = findItems(question, items);

  // "How much is the framework 13" never says shop, px or hours — naming
  // something off the shelf is the whole signal. "How much time does review
  // take" asks the same way and names nothing, so it goes back to the docs.
  // A bare tier is the third way in: it is the answer to the question pixie
  // asked a moment ago, and on its own it looks like nothing at all.
  const asksAmount = QUANTITY_ASK.test(question || "") || PRICE_WORD.test(question || "");
  const bareTier = tier !== null && isBareTierReply(question);
  if (!isShopQuestion(question) && !(asksAmount && matches.length > 0) && !bareTier) return null;

  // Only when the message itself names nothing: what they just typed always
  // wins over what the thread said earlier.
  if (matches.length === 0 && history) matches = lastMentionedItems(history, items);

  if (matches.length > 1) {
    // Naming them all is the point, but a Slack message listing a dozen is
    // worse than useless — past a few, the shop page is the better answer.
    const SHOWN = 4;
    const named = matches
      .slice(0, SHOWN)
      .map((i) => (isUnpriced(i) ? `${i.name} (not priced yet)` : `${i.name} at ${fmtPx(priceOf(i))} px`))
      .join(", ");
    const rest = matches.length - SHOWN;
    const tail = rest > 0 ? `, and ${rest} more` : "";
    return {
      source,
      direct,
      clarify: true,
      answer: `${matches.length} things in the shop match that: ${named}${tail}. Which one do you mean?`,
    };
  }

  if (matches.length === 0) {
    // A tier on its own is still a shop question, it's just missing the half
    // that decides the number. Anything else goes back to the docs path.
    if (tier === null) return null;
    return {
      source,
      direct,
      clarify: true,
      answer:
        `T${tier} ${TIER_NAMES[tier - 1]} banks ${rePerHour(tier, economy)} RE an hour, but the hours depend on what you're saving for, and ` +
        `every item in the shop has its own price. Which one did you have in mind?`,
    };
  }

  const item = matches[0];
  const lines = [priceLine(item)];
  if (!isTrophy(item) && !isUnpriced(item)) {
    const px = priceOf(item);
    if (tier) {
      lines.push(tierLine(px, tier, economy));
      lines.push(
        `${rangeLine(px, economy)} If you've already banked some RE, say roughly how much and I'll redo it from there. ${REGION_NOTE}`,
      );
    } else {
      lines.push(rangeLine(px, economy));
      lines.push(
        `Which tier your projects land on decides how fast you move between those two: T1 ${TIER_NAMES[0]} banks ${rePerHour(1, economy)} RE an hour, T4 ${TIER_NAMES[3]} banks ${rePerHour(4, economy)}. Tell me the tier and I'll give you the real number. ${REGION_NOTE}`,
      );
    }
  }
  return { source, direct, answer: lines.join("\n\n") };
}

/* --------------------------------------------------------------- corpus -- */

// The catalogue as text for the retrieval corpus. Covers "what's in the shop"
// and "is there a keyboard" — the browsing questions directAnswer deliberately
// doesn't try to handle.
function corpusText(data) {
  const items = data?.items || [];
  const economy = data?.economy || DEFAULT_ECONOMY;
  if (items.length === 0) return "";

  const steps = economy.payoutSteps || DEFAULT_ECONOMY.payoutSteps;
  const header = [
    "Live prices from the Pixl shop, in pixels (px), as the US catalogue lists them. Other regions get different stock and different prices. These are current; the docs do not list prices.",
    "",
    "Rate table, by lifetime Restoration Energy, showing what an hour of shipped work pays:",
    ...steps.map((s) => `- ${fmtPx(s.re)} RE: ${fmtUsd(s.usd)} an hour = ${fmtPx(s.usd / (economy.pixelValueUsd || 0.07))} px an hour`),
    "",
    `Tier decides how fast RE banks: ${(economy.tierRePerHour || DEFAULT_ECONOMY.tierRePerHour)
      .map((re, i) => `T${i + 1} ${TIER_NAMES[i]} ${re} RE/hour`)
      .join(", ")}.`,
    "",
    "Every price is set at the payout floor, so each item costs the most hours at the floor rate and the fewest at the cap.",
    "",
    "Catalogue:",
  ];

  const sorted = [...items].sort((a, b) => priceOf(a) - priceOf(b));
  const lines = sorted.map((item) => {
    const where = item.category ? ` [${item.category}]` : "";
    if (isTrophy(item)) return `- ${item.name}${where}: a trophy, claimed free at ${fmtPx(item.unlock_xp)} XP`;
    if (isUnpriced(item)) return `- ${item.name}${where}: not priced for this region yet, not buyable`;
    const px = priceOf(item);
    const r = hoursRange(px, economy);
    const from = item.config_options ? "from " : "";
    return `- ${item.name}${where}: ${from}${fmtPx(px)} px (${fmtHours(r.floorHours)}h at the floor rate, ${fmtHours(r.capHours)}h at the cap)`;
  });

  return [...header, ...lines].join("\n");
}

/* -------------------------------------------------------------- loading -- */

let snapshot = { items: [], economy: DEFAULT_ECONOMY, fetchedAt: 0 };
const STORE_KEY = "Pixl Shop Data";

// Tried once, not on every call: a deployment with no stored copy would
// otherwise hit the database on every message that looks like a price question.
let restoreTried = false;

function current() {
  if (snapshot.items.length === 0 && !restoreTried) {
    restoreTried = true;
    restoreFromDisk();
  }
  return snapshot;
}

function restoreFromDisk() {
  try {
    const stored = require("./db").loadSourceText(STORE_KEY);
    if (!stored?.text) return false;
    const parsed = JSON.parse(stored.text);
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return false;
    snapshot = { items: parsed.items, economy: parsed.economy || DEFAULT_ECONOMY, fetchedAt: stored.fetchedAt };
    log.info("shop", `restored ${parsed.items.length} items from disk`);
    return true;
  } catch (e) {
    log.debug("shop", `no stored catalogue: ${e.message}`);
    return false;
  }
}

// The economy config is the one that must not be wrong, so a failure there
// keeps the last good numbers rather than falling back mid-flight. The
// catalogue is the one that must not be empty, so a failure there throws and
// lets the caller keep whatever it already had.
async function refresh() {
  let economy = snapshot.economy || DEFAULT_ECONOMY;
  try {
    const res = await axios.get(ECONOMY_URL, { timeout: 10000 });
    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    if (data?.economy?.payoutSteps?.length) economy = data.economy;
  } catch (e) {
    log.warn("shop", `economy config fetch failed, keeping current rates: ${e.message}`);
  }

  const res = await axios.get(CATALOGUE_URL, { timeout: 10000 });
  const items = Array.isArray(res.data?.items) ? res.data.items : [];
  if (items.length === 0) throw new Error("shop returned an empty catalogue");

  snapshot = { items, economy, fetchedAt: Date.now() };
  try {
    require("./db").saveSourceText(STORE_KEY, JSON.stringify({ items, economy }));
  } catch (e) {
    log.warn("shop", `could not persist catalogue: ${e.message}`);
  }
  return snapshot;
}

// Called by lib/knowledge.js for a source of type "pixl-shop".
async function refreshText() {
  try {
    return corpusText(await refresh());
  } catch (e) {
    if (snapshot.items.length === 0 && !restoreFromDisk()) throw e;
    log.warn("shop", `catalogue fetch failed: ${e.message} — serving last good copy`);
    return corpusText(snapshot);
  }
}

module.exports = {
  DEFAULT_ECONOMY,
  TIER_NAMES,
  CATALOGUE_URL,
  ECONOMY_URL,
  rePerHour,
  payoutUsdPerHour,
  pxPerHour,
  hoursRange,
  hoursForPixels,
  parseTier,
  findItems,
  isShopQuestion,
  isBareTierReply,
  lastMentionedItems,
  priceOf,
  isTrophy,
  isUnpriced,
  directAnswer,
  corpusText,
  current,
  refresh,
  refreshText,
  restoreFromDisk,
};
