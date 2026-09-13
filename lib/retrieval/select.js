// Select stage: ranked chunks -> budgeted context string.
// Roughly 500-600 tokens of retrieved docs. Generated sections are added on top of
// this and are never counted against it — keeps prompts well inside Groq's TPM ceiling.
const DEFAULT_BUDGET = 2500;

const { tokenize } = require("./tokenize");
const { score } = require("./score");
const log = require("../log");

// Returns the chunks worth sending, best first, stopping at the character
// budget. Empty when nothing matched — callers decide what that means.
function selectChunks(index, question, budget = DEFAULT_BUDGET) {
  const queryTerms = tokenize(question);
  if (queryTerms.length === 0) return [];

  // Stop, don't skip ahead: once the next-best chunk doesn't fit, scanning
  // past it for a smaller, lower-ranked one that does used to mean a highly
  // relevant chunk could get bumped for filler nobody asked about, just
  // because it happened to be shorter — worse context from a corpus that had
  // the real answer sitting right there.
  const selected = [];
  let used = 0;
  for (const { chunk } of score(index, queryTerms)) {
    if (used + chunk.text.length > budget) break;
    selected.push(chunk);
    used += chunk.text.length;
  }
  return selected;
}

// Assembles the string the answer prompt actually receives.
//
// `generated` is passed through whole and always first. Those sections are
// pixie's identity, the live program timeline and everything a helper taught it
// — small, authoritative, and the exact content that broke last time it got
// buried under scraped docs (see the comment in knowledge.buildCorpus). Ranking
// them against a question would eventually drop one, so they are never ranked.
//
// Falls back to the full corpus when retrieval finds nothing, because answering
// from too much context beats answering from none.
// `exclude` names sources that must not reach the model for this particular
// question, whatever retrieval thinks of them. The shop catalogue is the case
// it exists for: it scores well on any message naming something on the shelf,
// and answering "my ps5 controller is drifting" with a price is the bot talking
// over a conversation nobody invited it into.
function selectContext({ generated, index, sources, question, budget = DEFAULT_BUDGET, exclude = null }) {
  const dropped = exclude instanceof Set ? exclude : new Set(exclude || []);
  const kept = ([name]) => !dropped.has(name);

  const head = generated.filter(kept).filter(([, text]) => text).map(([name, text]) => `### ${name}\n${text}`);

  const chunks = selectChunks(index, question, budget).filter((c) => !dropped.has(c.source));
  if (chunks.length === 0) {
    log.debug("retrieve", `no chunk matched "${(question || "").slice(0, 60)}" — sending capped corpus`);
    let used = 0;
    const capped = [];
    for (const [name, text] of sources.filter(kept)) {
      if (used >= budget) break;
      const slice = text.slice(0, Math.max(200, budget - used));
      capped.push(`### ${name}\n${slice}`);
      used += slice.length;
    }
    return [...head, ...capped].join("\n\n");
  }

  // Grouped by source so the model still sees which document a passage came
  // from — citations depend on that name matching a real source.
  const bySource = new Map();
  for (const chunk of chunks) {
    if (!bySource.has(chunk.source)) bySource.set(chunk.source, []);
    bySource.get(chunk.source).push(chunk.text);
  }

  const body = [...bySource].map(([name, texts]) => `### ${name}\n${texts.join("\n\n")}`);
  return [...head, ...body].join("\n\n");
}

module.exports = { DEFAULT_BUDGET, selectChunks, selectContext };
