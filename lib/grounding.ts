// Grounding is deliberately conservative: the model may identify evidence,
// but only retrieved records (or explicitly supplied fixtures) can support a
// claim in the answer pipeline.

const VERDICTS = new Set(["supported", "unsupported", "needs_review"]);

function fail(errors: any) {
  return { ok: false, verdict: "unsupported", claims: [], errors };
}

function asString(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeJson(text: any) {
  const input = asString(text);
  if (!input) return null;

  const candidates: any[] = [];
  const fenced = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let match: any;
  while ((match = fenced.exec(input))) candidates.push(match[1].trim());
  candidates.push(input);

  // Also handle a short explanation before/after an unfenced JSON object.
  for (let start = 0; start < input.length; start += 1) {
    if (input[start] !== "{" && input[start] !== "[") continue;
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let end = start; end < input.length; end += 1) {
      const character = input[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = false;
        continue;
      }
      if (character === '"') quote = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(input.slice(start, end + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (_: any) {
      // Try the next fenced or balanced candidate; parsing is fail closed.
    }
  }
  return null;
}

function parseGroundingVerdict(raw: any) {
  const value = typeof raw === "string" ? decodeJson(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(["verdict must be a JSON object"]);
  if (!VERDICTS.has(value.verdict)) return fail(["verdict must be supported, unsupported, or needs_review"]);
  if (!Array.isArray(value.claims) || value.claims.length === 0) return fail(["claims must be a non-empty array"]);

  const claims: any[] = [];
  for (const [index, item] of value.claims.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail([`claims[${index}] must be an object`]);
    const claim = asString(item.claim);
    if (!claim) return fail([`claims[${index}].claim must be a non-empty string`]);
    if (typeof item.supported !== "boolean") return fail([`claims[${index}].supported must be boolean`]);
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.some((id: any) => !asString(id))) {
      return fail([`claims[${index}].evidenceIds must be an array of strings`]);
    }
    if (item.supported && item.evidenceIds.length === 0) return fail([`claims[${index}] supported claims need evidenceIds`]);
    claims.push({
      claim,
      supported: item.supported,
      evidenceIds: item.evidenceIds.map(asString),
    });
  }
  return { ok: true, verdict: value.verdict, claims };
}

function claimKey(value: any) {
  return asString(value).replace(/\s+/g, " ").toLowerCase();
}

function evidenceProgramId(evidence: any) {
  return asString(evidence && (evidence.programId || evidence.program_id));
}

function validateClaimSupport({ verdict, evidence = [], programId, fixtureClaims = [], parse = parseGroundingVerdict }: any = {}) {
  if (typeof parse !== "function") return { ok: false, supported: false, claims: [], errors: ["parse must be a function"] };
  const parsed = verdict && verdict.ok === true ? verdict : parse(verdict);
  if (!parsed.ok) return { ok: false, supported: false, claims: [], errors: parsed.errors };
  if (!asString(programId)) return { ok: false, supported: false, claims: [], errors: ["programId is required"] };
  if (!Array.isArray(evidence) || !Array.isArray(fixtureClaims)) return { ok: false, supported: false, claims: [], errors: ["evidence and fixtureClaims must be arrays"] };

  const byId = new Map(evidence.map((item: any) => [asString(item && item.id), item]));
  const fixtures = new Set(fixtureClaims.map(claimKey));
  const results = parsed.claims.map((claim: any) => {
    const explicitFixture = fixtures.has(claimKey(claim.claim));
    const validEvidence = claim.evidenceIds.every((id: any) => {
      const item = byId.get(id);
      if (!item || evidenceProgramId(item) !== programId) return false;
      const supportedClaims = item.supportsClaims || item.supportedClaims || [];
      return Array.isArray(supportedClaims) && supportedClaims.some((supported: any) => claimKey(supported) === claimKey(claim.claim));
    });
    const supported = claim.supported && (explicitFixture || (claim.evidenceIds.length > 0 && validEvidence));
    return { claim: claim.claim, supported, reason: supported ? "explicit evidence" : "no exact same-program support" };
  });
  const supported = results.length > 0 && results.every((claim: any) => claim.supported);
  return { ok: true, supported, verdict: supported ? "supported" : "unsupported", claims: results, errors: [] };
}

// The model/client is intentionally outside this module. Callers inject a
// parser (or a test double) and pass its raw result to validate().
function createGroundingValidator({ parse = parseGroundingVerdict }: any = {}) {
  if (typeof parse !== "function") throw new TypeError("parse must be a function");
  return {
    parse,
    validate(input: any = {}) {
      return validateClaimSupport({ ...input, parse });
    },
  };
}

export = { decodeJson, parseGroundingVerdict, validateClaimSupport, createGroundingValidator };
