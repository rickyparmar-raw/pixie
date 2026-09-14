// Differential trace for the support pipeline: Slack event -> Slack effect.
//
// WHY: the support pipeline is one long chain (eligibility, program
// resolution, intent, context, retrieval, freshness, grounding, disposition,
// posting), and a rewrite that only asserts the final reply cannot say WHERE
// a divergence crept in. This harness runs every stage through the CURRENT
// production functions with caller-supplied observations (intent verdict,
// candidate model answer) and returns the ordered stage record. A rewritten
// stage must reproduce its record entry exactly for the same inputs; the
// characterization suite in lib/contextualSupport.test.js supplies those
// inputs. Nothing here posts to Slack, calls the model, or writes tickets —
// it observes through the same read paths respond() uses.
const programs = require("./programs");
const context = require("./context");
const lookup = require("./lookup");
const knowledge = require("./knowledge");
const intent = require("./intent");

function stage(name, input, output) {
  return { stage: name, input, output };
}

// All student's own words for the trace: which program/channel/question the
// pipeline saw, and what each stage decided. Content fields carry the same
// values respond() would act on — no separate reimplementation of policy.
function traceSupportRequest({ channel, threadTs, userId, question, thread = [], intentVerdict = null, candidate = null, workspaceId = null }) {
  const trace = [];
  const trimmed = String(question || "").trim();

  const prog = programs.forChannel(channel, workspaceId);
  trace.push(stage("program-resolution", { channel, workspaceId }, prog ? { id: prog.id, name: prog.name } : null));

  const inHelpChannel = programs.isHelpChannel(channel, workspaceId);
  trace.push(stage("channel-classification", { channel }, { inHelpChannel }));

  const sensitive = prog ? require("./eligibility").sensitiveHit(trimmed, prog) : false;
  trace.push(stage("eligibility", { question: trimmed }, { sensitive }));

  const threadContext = thread.length > 0
    ? context.compactThreadContext(thread, trimmed)
    : context.getThreadContext(threadTs, trimmed);
  trace.push(stage("thread-context", { threadTs }, threadContext));

  const query = lookup.retrievalQuery(trimmed, threadContext || "", prog);
  trace.push(stage("retrieval-query", { question: trimmed }, query));

  const programId = prog ? prog.id : null;
  const corpus = knowledge.getContext(query, programId);
  const corpusSections = [...corpus.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  trace.push(stage("retrieval-results", { query }, { chars: corpus.length, sections: corpusSections }));

  const sources = programId ? (programs.get(programId)?.sources || []) : [];
  const freshness = sources.map((s) => {
    try {
      const health = knowledge.sourceEligibility(s);
      return { name: s.name, authority: health.authority, freshness: health.freshness, exactClaimsAllowed: health.exactClaimsAllowed };
    } catch (e) {
      return { name: s.name, error: e.message };
    }
  });
  trace.push(stage("source-freshness", { programId }, freshness));

  const normalized = intent.normalizeIntentResult(intentVerdict, { addressed: false });
  trace.push(stage("intent", { verdict: intentVerdict?.verdict ?? null }, normalized ? { verdict: normalized.verdict, shouldAttemptAnswer: normalized.shouldAttemptAnswer } : null));

  let grounded = null;
  if (candidate) {
    const bounded = lookup.applyGroundingBoundary(candidate, prog, trimmed);
    grounded = bounded
      ? { source: bounded.source, answerChars: bounded.answer.length }
      : null;
  }
  trace.push(stage("grounding", candidate ? { source: candidate.source } : null, grounded));

  // Disposition mirrors respond()'s terminal contract for the traced inputs:
  // sensitive always escalates; a failed/false intent always silences; an
  // insufficient-evidence candidate follows the same abstention rule as the
  // responder (help channel escalates, elsewhere silent); a grounded
  // candidate replies. This duplicates no policy — it reads the same verdicts
  // respond() branches on.
  let disposition;
  if (sensitive) {
    disposition = "ESCALATE";
  } else if (!normalized?.shouldAttemptAnswer) {
    disposition = "SILENCE";
  } else if (!grounded) {
    disposition = inHelpChannel ? "ESCALATE" : "SILENCE";
  } else {
    disposition = "REPLY";
  }
  trace.push(stage("final-disposition", { intent: normalized?.verdict ?? null, grounded: !!grounded }, disposition));

  const effects = [];
  if (disposition === "REPLY") effects.push({ kind: "slack.post", channel, threadTs, textChars: grounded.answerChars });
  if (disposition === "ESCALATE") effects.push({ kind: "ticket.ensure", channel, threadTs });
  trace.push(stage("slack-effects", { disposition }, effects));

  return { programId, inHelpChannel, trace };
}

module.exports = { traceSupportRequest };
