// Picks the parts of the corpus a question actually needs.
//
// Thin composition over the retrieval stages: tokenize, chunk, score, select.
// Ranking is BM25 over chunks. Deliberately no embeddings yet — this adds no
// dependency and no latency, and the numbers it produces are what should decide
// whether a model is worth introducing.
const { tokenize, foldPlural } = require("./retrieval/tokenize");
const { MIN_CHUNK, MAX_CHUNK, detectDomain, chunkSection, chunkSections } = require("./retrieval/chunk");
const {
  K1,
  B,
  BOOST_DECIDING_RULE,
  BOOST_SPECIFIC_CAP,
  BOOST_RETURNED_RULE,
  BOOST_DOMAIN_MATCH,
  DEMOTE_CONTRADICTION,
  buildIndex,
  score,
} = require("./retrieval/score");
const { DEFAULT_BUDGET, selectChunks, selectContext } = require("./retrieval/select");

module.exports = {
  tokenize,
  foldPlural,
  detectDomain,
  chunkSection,
  chunkSections,
  buildIndex,
  score,
  selectChunks,
  selectContext,
  MIN_CHUNK,
  MAX_CHUNK,
  DEFAULT_BUDGET,
  K1,
  B,
  BOOST_DECIDING_RULE,
  BOOST_SPECIFIC_CAP,
  BOOST_RETURNED_RULE,
  BOOST_DOMAIN_MATCH,
  DEMOTE_CONTRADICTION,
};
