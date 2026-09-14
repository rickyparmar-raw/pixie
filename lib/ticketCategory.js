// Deterministic ticket classification. A category decides which human gets
// @-mentioned, so it is resolved from rules the program can read back, never
// from a model — same reasoning as lib/helperRoute.js: no LLM picks a person.
//
// Precedence is channel, then keyword, then the program's fallback. Channel
// wins because it is a structural fact (a question asked in the review channel
// IS a review question), while keywords are a guess about wording.
//
// An unconfigured program classifies nothing and returns null, which is the
// behaviour every program had before this module existed.

// WHY: a category feeds an exact-match lookup against helper_expertise.tag, so
// it has to normalize the same way helperRoute.normalizeCategory does —
// lowercase and trimmed — or a tag will never match the ticket it describes.
function normalize(value) {
  if (!value) return null;
  const clean = String(value).trim().toLowerCase().slice(0, 60);
  return clean || null;
}

// Whole-word, case-insensitive. Substring matching would file every mention of
// "approved" under review, including "my payout was approved".
function mentions(haystack, term) {
  const clean = String(term || "").trim().toLowerCase();
  if (!clean) return false;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function byChannel(rules, channel) {
  if (!channel || !rules.byChannel) return null;
  return normalize(rules.byChannel[channel]);
}

// First rule wins, so rule order is the tie-break a program controls: put the
// narrower category above the broader one.
function byKeyword(rules, question) {
  if (!Array.isArray(rules.byKeyword) || !question) return null;
  const haystack = String(question).toLowerCase();
  for (const rule of rules.byKeyword) {
    if (!rule || !Array.isArray(rule.match)) continue;
    if (rule.match.some((term) => mentions(haystack, term))) return normalize(rule.category);
  }
  return null;
}

function classify({ question = "", channel = null, rules = null } = {}) {
  if (!rules || typeof rules !== "object") return null;
  return byChannel(rules, channel) || byKeyword(rules, question) || normalize(rules.fallback);
}

// The distinct categories a program can produce. Used to show an organizer what
// their rules actually cover before they rely on routing to them.
function configuredCategories(rules) {
  if (!rules || typeof rules !== "object") return [];
  const found = new Set();
  for (const value of Object.values(rules.byChannel || {})) {
    const tag = normalize(value);
    if (tag) found.add(tag);
  }
  for (const rule of Array.isArray(rules.byKeyword) ? rules.byKeyword : []) {
    const tag = normalize(rule && rule.category);
    if (tag) found.add(tag);
  }
  const fallback = normalize(rules.fallback);
  if (fallback) found.add(fallback);
  return [...found].sort();
}

module.exports = { classify, configuredCategories, normalize };
