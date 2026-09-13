// Authorization boundary for grounded answers: which results may carry an
// exact claim, and which material-policy answers are withheld without support.
const programs = require("./programs");
const knowledge = require("./knowledge");
const grounding = require("./grounding");

function idOf(program) {
  if (!program) return null;
  return typeof program === "string" ? program : program.id || null;
}

function programSources(record) {
  record = typeof record === "string" ? programs.get(record) : record;
  const shared = record && record.sharedSources === false ? [] : (programs.shared().sources || []);
  return [...(record?.sources || []), ...shared];
}

function exactClaimAllowed(result, prog, question = "") {
  if (!result) return false;
  prog = typeof prog === "string" ? programs.get(prog) : prog;
  let structuredSupport = false;
  if (result.groundingVerdict || result.evidence) {
    const programId = idOf(prog);
    if (!programId) return false;
    const checked = grounding.validateClaimSupport({
      verdict: result.groundingVerdict,
      evidence: result.evidence,
      programId,
      fixtureClaims: result.fixtureClaims || [],
    });
    if (!checked.supported) return false;
    structuredSupport = true;
  }

  const sources = programSources(prog);
  const source = sources.find((candidate) => candidate && candidate.name &&
    result.source && candidate.name.toLowerCase() === result.source.trim().toLowerCase());
  if (!source) return !isMaterialPolicyQuestion(question, result);
  const freshness = knowledge.sourceEligibility(source);
  return freshness.exactClaimsAllowed || (structuredSupport && freshness.authority !== "dynamic");
}

function isMaterialPolicyQuestion(question, result) {
  if (result?.direct) return false;
  return /\b(?:policy|rule|rules|eligible|eligibility|allowed|prohibited|forbidden|customs|tax|expense|locally)\b/i.test(String(question || ""));
}

function applyGroundingBoundary(result, prog, question = "") {
  if (result && isMaterialPolicyQuestion(question, result) && !result.groundingVerdict && !result.evidence) return null;
  return result && !exactClaimAllowed(result, prog, question) ? null : result;
}

module.exports = {
  idOf,
  programSources,
  exactClaimAllowed,
  isMaterialPolicyQuestion,
  applyGroundingBoundary,
};
