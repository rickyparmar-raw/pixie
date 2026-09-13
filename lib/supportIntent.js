// Support-intent boundary: "does this message appear to genuinely need
// program support?" — and nothing else. Whether pixie knows the answer is
// decided downstream by retrieval + grounding, never here.
//
// Previously this lived inline in lib/respond.js (classify, normalize, branch
// all pasted at the call site). It moves here unchanged so the decision has
// one owner, one test target, and one future extension point.
//
// Future program-level proactive-intent toggles plug in WITHOUT another
// responder rewrite, in this order:
//   1. options.forceVerdict — an explicit caller-supplied verdict (ops/tests).
//   2. a registered override via registerIntentOverride() — e.g. a
//      program-level toggle resolved from program config once that feature
//      lands. Registry starts empty, so behavior is identical until then.
//   3. the model classifier (today's behavior).
// A forced verdict still flows through normalizeIntentResult, so downstream
// gating sees the same shape no matter which source decided.
const intent = require("./intent");

const overrides = [];

function registerIntentOverride(fn) {
  if (typeof fn !== "function") throw new TypeError("intent override must be a function");
  overrides.push(fn);
  return () => {
    const i = overrides.indexOf(fn);
    if (i !== -1) overrides.splice(i, 1);
  };
}

function clearIntentOverrides() {
  overrides.length = 0;
}

// Returns the normalized intent result, or null when the classifier failed.
// Null is fail-closed silence downstream — never a guess.
async function classifySupportIntent(message, program = null, options = {}) {
  if (options.forceVerdict !== undefined && options.forceVerdict !== null) {
    return intent.normalizeIntentResult(options.forceVerdict, options);
  }
  for (const override of [...overrides]) {
    let forced;
    try {
      forced = await override(message, program, options);
    } catch (e) {
      require("./log").debug("intent", `intent override failed, falling through: ${e.message}`);
      continue;
    }
    if (forced !== undefined && forced !== null) {
      return intent.normalizeIntentResult(forced, options);
    }
  }
  const result = await intent.classifyIntentContext(message, program, options).catch(() => null);
  return intent.normalizeIntentResult(result, options);
}

module.exports = { classifySupportIntent, registerIntentOverride, clearIntentOverrides };
