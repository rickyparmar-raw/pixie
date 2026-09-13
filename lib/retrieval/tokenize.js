// Tokenize stage: query/document text -> matchable terms.
//
// Words carried by nearly every question, so they say nothing about which chunk
// is the right one and just add noise to the scores.
// Contractions are listed alongside the words they contract. Punctuation is
// stripped before this runs, so "what's" arrives as "whats" — which meant the
// apostrophe form dropped "what" as filler while the contracted form kept
// "whats" as if it were meaningful, and the two hashed to different cache keys.
// Measured: "whats restoration energy" missed a cached "What's Restoration
// Energy?" for exactly this reason.
//
// Negation contractions are deliberately NOT here. "cant"/"wont" would collapse
// into the words they negate, and "can i submit" is not the same question as
// "cant i submit".
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at", "for", "with", "is", "are", "was",
  "were", "be", "been", "it", "its", "this", "that", "these", "those", "i", "im", "my", "me", "you", "your",
  "we", "our", "they", "them", "do", "does", "did", "how", "what", "when", "where", "why", "who", "can", "could",
  "should", "would", "will", "get", "got", "have", "has", "had", "not", "no", "yes", "so", "just", "pixie",
  "whats", "hows", "wheres", "whens", "whos", "whys", "thats", "theres", "heres", "ive", "ill", "youre",
  "u", "ur", "pls", "plz",
]);

// Matching was exact, so a question about "rates" scored zero against docs
// that say "rate" and the retriever handed back unrelated chunks. Deliberately
// blunter than a real stemmer: only regular plurals, and never on words short
// enough or -ss enough that folding would collide two different words.
function foldPlural(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text) {
  const rawWords = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const tokens = [];
  for (const word of rawWords) {
    if (word.includes("-")) {
      for (const part of word.split("-")) {
        if (part.length > 1 && !STOPWORDS.has(part)) {
          tokens.push(foldPlural(part));
        }
      }
      const combined = word.replace(/-/g, "");
      if (combined.length > 1 && !STOPWORDS.has(combined)) {
        tokens.push(foldPlural(combined));
      }
    } else if (word.length > 1 && !STOPWORDS.has(word)) {
      tokens.push(foldPlural(word));
    }
  }

  if (tokens.includes("old") && !tokens.includes("age")) {
    tokens.push("age");
  }
  if (tokens.includes("expiration") && !tokens.includes("expire")) {
    tokens.push("expire");
  }
  if (tokens.includes("expires") && !tokens.includes("expire")) {
    tokens.push("expire");
  }
  if (tokens.includes("resubmission") && !tokens.includes("resubmit")) {
    tokens.push("resubmit");
  }
  if (tokens.includes("returned") && !tokens.includes("return")) {
    tokens.push("return");
  }
  if (tokens.includes("return") && !tokens.includes("returned")) {
    tokens.push("returned");
  }
  if ((tokens.includes("disclosure") || tokens.includes("disclosing")) && !tokens.includes("disclose")) {
    tokens.push("disclose");
  }
  if (tokens.includes("disclose") && !tokens.includes("disclosure")) {
    tokens.push("disclosure");
  }

  return tokens;
}

module.exports = { STOPWORDS, foldPlural, tokenize };
