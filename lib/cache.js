// Answer cache. The same handful of questions get asked constantly in a help
// channel ("whats the deadline", "where do i play"), and each one was a full
// corpus round-trip. Keyed on a normalised question so wording noise doesn't
// split the key.
const crypto = require("crypto");
const db = require("./db");

// Only cache context-free lookups — once thread history or user history is in
// the prompt, the answer is specific to that conversation.
function normalize(question) {
  return (question || "")
    .toLowerCase()
    .replace(/<@[^>]+>/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function keyFor(question) {
  return crypto.createHash("sha1").update(normalize(question)).digest("hex");
}

function get(question) {
  return db.getCachedAnswer(keyFor(question));
}

function put(question, result) {
  db.putCachedAnswer(keyFor(question), question, result);
}

module.exports = { get, put, keyFor, normalize };
