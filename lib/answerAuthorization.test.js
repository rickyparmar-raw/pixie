const { test } = require("node:test");
const assert = require("node:assert/strict");

// STEP 3: import from the extracted domain module (behavior identical).
const auth = require("./answerAuthorization");
const knowledge = require("./knowledge");
const grounding = require("./grounding");

function withStubs({ eligibility, validation }, fn) {
  const origElig = knowledge.sourceEligibility;
  const origVal = grounding.validateClaimSupport;
  if (eligibility !== undefined) knowledge.sourceEligibility = eligibility;
  if (validation !== undefined) grounding.validateClaimSupport = validation;
  try {
    return fn();
  } finally {
    knowledge.sourceEligibility = origElig;
    grounding.validateClaimSupport = origVal;
  }
}

function progWith(sources) {
  return { id: "auth-pin", sharedSources: false, sources };
}

/* ------------------------- (a) pins of current behavior ------------------------- */

test("pin: material-policy keywords deny unknown-source claims", () => {
  const keywords = ["policy", "rule", "eligible", "allowed", "prohibited", "customs", "tax", "expense", "locally"];
  const prog = progWith([]);
  for (const kw of keywords) {
    const result = { source: "Unknown", answer: "18%" };
    const out = auth.applyGroundingBoundary(result, prog, `is this ${kw} question?`);
    assert.equal(out, null, `keyword "${kw}" should be treated as material`);
  }
});

test("pin: plural/expanded forms also match", () => {
  const prog = progWith([]);
  for (const kw of ["rules", "eligibility", "forbidden"]) {
    const out = auth.applyGroundingBoundary({ source: "Unknown", answer: "x" }, prog, `what are the ${kw}?`);
    assert.equal(out, null, `keyword "${kw}" should be treated as material`);
  }
});

test("pin: direct results bypass the material-policy gate", () => {
  const prog = progWith([]);
  const result = { source: "Unknown", direct: true, answer: "direct answer" };
  const out = auth.applyGroundingBoundary(result, prog, "is this policy allowed?");
  assert.equal(out, result);
});

test("pin: unknown source + non-material question is allowed", () => {
  const prog = progWith([]);
  const result = { source: "Unknown", answer: "hello" };
  assert.equal(auth.exactClaimAllowed(result, prog, "how do I reset my password?"), true);
  assert.equal(auth.applyGroundingBoundary(result, prog, "how do I reset my password?"), result);
});

test("pin: unknown source + material question is denied", () => {
  const prog = progWith([]);
  const result = { source: "Unknown", answer: "18%" };
  assert.equal(auth.exactClaimAllowed(result, prog, "is this policy allowed?"), false);
  assert.equal(auth.applyGroundingBoundary(result, prog, "is this policy allowed?"), null);
});

test("pin: material gate needs verdict or evidence present", () => {
  const prog = progWith([]);
  // Same material question, but a verdict is attached: the first-line
  // boundary no longer fires; authorization falls through to exactClaimAllowed.
  const withVerdict = { source: "Unknown", answer: "x", groundingVerdict: { verdict: "supported", claims: [] }, evidence: [] };
  const out = withStubs({ validation: () => ({ supported: true }) }, () =>
    auth.applyGroundingBoundary(withVerdict, { id: "auth-pin", sharedSources: false, sources: [] }, "is this policy allowed?"),
  );
  // Unknown source + material question still denies via exactClaimAllowed
  // (!isMaterialPolicyQuestion is false), even with a supported verdict.
  assert.equal(out, null);
});

/* ------------------------- (b) authorization matrix A-H ------------------------- */

test("A: structured same-program support + fresh static allows", () => {
  const prog = progWith([{ name: "Policy Docs", type: "docs" }]);
  const result = {
    source: "Policy Docs",
    answer: "18%",
    groundingVerdict: { verdict: "supported", claims: [{ claim: "c", supported: true, evidenceIds: ["e1"] }] },
    evidence: [{ id: "e1", programId: "auth-pin", supportsClaims: ["c"] }],
  };
  withStubs(
    {
      eligibility: () => ({ exactClaimsAllowed: true, authority: "static", freshness: "fresh" }),
      validation: () => ({ supported: true }),
    },
    () => {
      assert.equal(auth.exactClaimAllowed(result, prog, "is this policy allowed?"), true);
      assert.equal(auth.applyGroundingBoundary(result, prog, "is this policy allowed?"), result);
    },
  );
});

test("B: structured support for a different program denies", () => {
  const prog = progWith([{ name: "Policy Docs", type: "docs" }]);
  const result = {
    source: "Policy Docs",
    answer: "18%",
    groundingVerdict: { verdict: "supported", claims: [{ claim: "c", supported: true, evidenceIds: ["e1"] }] },
    evidence: [{ id: "e1", programId: "other-program", supportsClaims: ["c"] }],
  };
  withStubs(
    {
      eligibility: () => ({ exactClaimsAllowed: true, authority: "static", freshness: "fresh" }),
      validation: () => ({ supported: false }),
    },
    () => {
      assert.equal(auth.exactClaimAllowed(result, prog, "is this policy allowed?"), false);
      assert.equal(auth.applyGroundingBoundary(result, prog, "is this policy allowed?"), null);
    },
  );
});

test("C: structured support + stale dynamic source denies", () => {
  const prog = progWith([{ name: "Live Shop", type: "live-shop" }]);
  const result = {
    source: "Live Shop",
    answer: "100 coins",
    groundingVerdict: { verdict: "supported", claims: [{ claim: "c", supported: true, evidenceIds: ["e1"] }] },
    evidence: [{ id: "e1", programId: "auth-pin", supportsClaims: ["c"] }],
  };
  withStubs(
    {
      eligibility: () => ({ exactClaimsAllowed: false, authority: "dynamic", freshness: "stale" }),
      validation: () => ({ supported: true }),
    },
    () => {
      assert.equal(auth.exactClaimAllowed(result, prog, "what is in the shop?"), false);
      assert.equal(auth.applyGroundingBoundary(result, prog, "what is in the shop?"), null);
    },
  );
});

test("D: no structured support + material question + unknown source denies", () => {
  const prog = progWith([]);
  const result = { source: "Unknown", answer: "18%" };
  assert.equal(auth.exactClaimAllowed(result, prog, "is this expense allowed by policy?"), false);
  assert.equal(auth.applyGroundingBoundary(result, prog, "is this expense allowed by policy?"), null);
});

test("E: no structured support + material question + known fresh static allows exact claim, boundary still needs verdict", () => {
  const prog = progWith([{ name: "Policy Docs", type: "docs" }]);
  const result = { source: "Policy Docs", answer: "18%" };
  withStubs({ eligibility: () => ({ exactClaimsAllowed: true, authority: "static", freshness: "fresh" }) }, () => {
    // exactClaimAllowed consults freshness: known fresh static authorizes.
    assert.equal(auth.exactClaimAllowed(result, prog, "is this expense allowed by policy?"), true);
    // applyGroundingBoundary has a first-line gate: a material question with
    // neither verdict nor evidence is denied regardless of source freshness.
    // Pinned verbatim from lookup.js; not changed by the extraction.
    assert.equal(auth.applyGroundingBoundary(result, prog, "is this expense allowed by policy?"), null);
  });
});

test("F: direct result + material question allows regardless of source", () => {
  const prog = progWith([]);
  const result = { source: "Unknown", direct: true, answer: "direct answer" };
  assert.equal(auth.exactClaimAllowed(result, prog, "is this tax policy allowed?"), true);
  assert.equal(auth.applyGroundingBoundary(result, prog, "is this tax policy allowed?"), result);
});

test("G: no verdict/evidence + non-material question allows", () => {
  const prog = progWith([]);
  const result = { source: "Unknown", answer: "hello" };
  assert.equal(auth.exactClaimAllowed(result, prog, "how do I reset my password?"), true);
  assert.equal(auth.applyGroundingBoundary(result, prog, "how do I reset my password?"), result);
});

test("H: stale static source without structured support still allows", () => {
  const prog = progWith([{ name: "Docs", type: "docs" }]);
  const result = { source: "Docs", answer: "18%" };
  withStubs({ eligibility: () => ({ exactClaimsAllowed: true, authority: "static", freshness: "stale" }) }, () => {
    assert.equal(auth.exactClaimAllowed(result, prog, "how do I reset my password?"), true);
    assert.equal(auth.applyGroundingBoundary(result, prog, "how do I reset my password?"), result);
  });
});
