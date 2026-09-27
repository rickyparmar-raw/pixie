// Deterministic ticket classification: channel, then keyword, then fallback.

interface KeywordRule {
  category?: unknown;
  match?: unknown[];
}

interface CategoryRules {
  byChannel?: Record<string, unknown>;
  byKeyword?: KeywordRule[];
  fallback?: unknown;
}

const DEFAULT_TAXONOMY = {
  byChannel: {},
  byKeyword: [
    { category: "review", match: ["review", "reviewer", "submission", "submit", "resubmit", "rejected", "approval", "rubric", "feedback"] },
    { category: "fulfillment_shipping", match: ["shipping", "shipped", "tracking", "package", "delivery", "order", "fulfillment", "payout", "reward"] },
    { category: "account_access", match: ["account", "login", "log in", "sign in", "password", "access", "permission", "email"] },
    { category: "site_bug", match: ["bug", "broken", "error", "crash", "crashing", "not working", "doesn't work", "not loading", "down"] },
    { category: "advice_how_to", match: ["how do", "how can", "how to", "help me", "advice", "guide", "configure", "install", "setup"] },
  ],
  fallback: "other",
};

function defaultTaxonomy(): CategoryRules {
  return {
    byChannel: { ...DEFAULT_TAXONOMY.byChannel },
    byKeyword: DEFAULT_TAXONOMY.byKeyword.map((rule) => ({ ...rule, match: [...rule.match] })),
    fallback: DEFAULT_TAXONOMY.fallback,
  };
}

// Must match helperRoute tag shape.
function normalize(value: unknown): string | null {
  if (!value) return null;
  const clean = String(value).trim().toLowerCase().slice(0, 60);
  return clean || null;
}

// Whole-word only.
function mentions(haystack: string, term: unknown): boolean {
  const clean = String(term || "").trim().toLowerCase();
  if (!clean) return false;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function byChannel(rules: CategoryRules, channel: string | null): string | null {
  if (!channel || !rules.byChannel) return null;
  return normalize(rules.byChannel[channel]);
}

// First rule wins.
function byKeyword(rules: CategoryRules, question: unknown): string | null {
  if (!Array.isArray(rules.byKeyword) || !question) return null;
  const haystack = String(question).toLowerCase();
  for (const rule of rules.byKeyword) {
    if (!rule || !Array.isArray(rule.match)) continue;
    if (rule.match.some((term) => mentions(haystack, term))) return normalize(rule.category);
  }
  return null;
}

function classify({ question = "", channel = null, rules = null }: { question?: unknown; channel?: string | null; rules?: CategoryRules | null } = {}): string | null {
  if (!rules || typeof rules !== "object") return null;
  return byChannel(rules, channel) || byKeyword(rules, question) || normalize(rules.fallback);
}

// Categories these rules can produce.
function configuredCategories(rules: CategoryRules | null | undefined): string[] {
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
  return [...found].sort().map((value) => String(value));
}

export = { classify, configuredCategories, defaultTaxonomy, normalize };
