// Deterministic ticket classification: channel, then keyword, then fallback.

// Must match helperRoute tag shape.
function normalize(value) {
  if (!value) return null;
  const clean = String(value).trim().toLowerCase().slice(0, 60);
  return clean || null;
}

// Whole-word only.
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

// First rule wins.
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

// Categories these rules can produce.
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
