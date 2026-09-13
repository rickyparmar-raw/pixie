// Terminal disposition decision, extracted from lib/respond.js without
// behavior change. respond.js keeps the I/O (placeholder, tickets, metrics,
// streaming gate) and the refinements below; this module owns ONLY the pure
// UNCLEAR/gate-verdict mapping both sides share.
//
// Return values: REPLY (the gate passed and there is answer-shaped text),
// SILENCE (stay quiet — includes help-channel escalation, which files/moves a
// ticket but posts no public reply), FALLBACK (the conversational CASE-2 reply
// path: ALWAYS mode with nothing usable posts MENTION_FALLBACK).
//
// Shapes: `result` is what lib/answer.js parseReply/parseAnswerOrChat return —
// { source, answer, unclear }. `gateResult` is the NORMALIZED intent verdict
// ({ shouldAttemptAnswer, verdict, ... }) or null when the classifier call
// itself failed. `mode` is respond's mode string ("always"/"docs-only"/
// "help-only").
//
// What stayed inline in respond.js and why:
// - Grounded-vs-conversational REPLY routing (isGroundedAnswer's non-answer
//   pattern filters) — duplicating those filters here would drift; inline can
//   only downgrade this module's REPLY to SILENCE, never invent a reply.
// - DOCS_ONLY's mayChat=false rule and staysQuiet (clarifying-question
//   suppression) — both downgrade REPLY to SILENCE for ungrounded text.
// - Ticket escalation, gap recording, shadowMode, metrics, placeholder
//   settle/discard — side effects, not a pure decision.
// - decideStreamGate's reason labels ("off_topic" vs "gate_stream") — kept
//   next to the metric call that consumes them.
const REPLY = "REPLY";
const SILENCE = "SILENCE";
const FALLBACK = "FALLBACK";

// Same value as answer.js UNCLEAR_MARKER and respond.js's local copy.
const UNCLEAR_MARKER = "UNCLEAR";

function isUnclearResult(result) {
  if (!result) return false;
  if (result.unclear === true) return true;
  return typeof result.answer === "string" && result.answer.trim().toUpperCase() === UNCLEAR_MARKER;
}

// Pass undefined when no gate ran at all (ALWAYS/DOCS_ONLY terminal: gate is
// null because none was created, not because one failed) — undefined never
// silences. Pass null for a failed classifier verdict (HELP_ONLY fail-soft) —
// null always silences, same as an explicit denial.
function gateShouldSilence(gateResult) {
  if (gateResult === undefined) return false;
  return gateResult?.shouldAttemptAnswer !== true;
}

module.exports = {
  isUnclearResult,
  gateShouldSilence,
  REPLY,
  SILENCE,
  FALLBACK,
  UNCLEAR_MARKER,
};
