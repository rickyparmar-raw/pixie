// Jev calibration harness: 30 labeled cases through Pixie's REAL retrieval
// (knowledge.getContext on the live corpus) and REAL Jev evaluations.
// No Slack messages, no answers generated — decision labels only.
// Run: JEV_ZERO_DATA_RETENTION=false bun scripts/jev-calibration.js
process.env.PIXIE_DB_PATH = process.env.PIXIE_DB_PATH || undefined;

const db = require("../lib/db");
const knowledge = require("../lib/knowledge");
const lookup = require("../lib/lookup");
const jevDecision = require("../lib/jevDecision");
const programs = require("../lib/programs");

db.open();

// expected: "reply" | "escalate" | "silence" | "safe" (escalate-or-silence)
const CASES = [
  // 10 clearly answerable (exact KB coverage)
  { name: "ans-re", message: "what is restoration energy", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-payout", message: "how much is the starting hourly payout rate", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-resubmit", message: "my project was returned, can i fix it and resubmit", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-ai", message: "is it allowed to use ai coding assistants on my project", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-track", message: "how do i track my software hours with hackatime", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-double", message: "what counts as double counting hours", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-repo", message: "does my project repo need to be public to ship", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-demo", message: "what demo do i need for a software project", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-shop", message: "how does the pixl shop work", expected: "reply", intent: "HELP_NEEDED" },
  { name: "ans-what", message: "what is pixl", expected: "reply", intent: "HELP_NEEDED" },
  // 10 clearly unsupported (legit questions, docs lack the answer)
  { name: "uns-pay", message: "what is my exact payout amount in dollars right now", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-eta", message: "when will my project be reviewed, it has been waiting a week", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-tier", message: "what is my current RE tier", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-order", message: "has my shop order shipped yet, where is the tracking", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-aipct", message: "what is the exact maximum percentage of ai code allowed", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-pass", message: "will my project pass review if i submit today", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-delete", message: "please delete my account and all my data", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-phone", message: "what is the pixl office phone number for support", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-jobs", message: "does pixl offer paid internships", expected: "escalate", intent: "HELP_NEEDED" },
  { name: "uns-laptop", message: "which laptop should i buy for working on pixl", expected: "escalate", intent: "HELP_NEEDED" },
  // 5 ambiguous/conflicting
  { name: "amb-this", message: "how do i do this", expected: "safe", intent: "HELP_NEEDED", context: "" },
  { name: "amb-count", message: "does this count", expected: "safe", intent: "HELP_NEEDED", context: "" },
  { name: "amb-ai", message: "can i use ai for everything in my project", expected: "safe", intent: "HELP_NEEDED" },
  { name: "amb-step", message: "what about step two", expected: "safe", intent: "HELP_NEEDED", context: "" },
  { name: "amb-rate", message: "is the starting rate $3 or $4 an hour", expected: "reply", intent: "HELP_NEEDED" },
  // 5 casual chatter
  { name: "chat-lmao", message: "lmao that deploy was wild gg", expected: "silence", intent: "CASUAL_CHAT" },
  { name: "chat-friday", message: "lets gooo finally friday", expected: "silence", intent: "CASUAL_CHAT" },
  { name: "chat-thanks", message: "thanks guys got it working", expected: "silence", intent: "CASUAL_CHAT" },
  { name: "chat-mention", message: "orpheus check this out", expected: "silence", intent: "CASUAL_CHAT" },
  { name: "chat-w", message: "w", expected: "silence", intent: "CASUAL_CHAT" },
];

async function main() {
  const only = new Set(process.argv.slice(2));
  const cases = only.size > 0 ? CASES.filter((c) => only.has(c.name)) : CASES;
  const prog = programs.get("pixl") || programs.forChannel("C0B6STY9G5N");
  console.log(`program=${prog.id} jev_enabled=${jevDecision.isEnabled()} cases=${cases.length}`);
  const rows = [];
  for (const c of cases) {
    const query = lookup.retrievalQuery(c.message, "", prog);
    let corpus = "";
    try {
      corpus = knowledge.getContext(query, prog.id);
    } catch (e) {
      corpus = "";
    }
    let res;
    try {
      res = await jevDecision.evaluateSupportDecision({
        message: c.message,
        conversationContext: c.context || "",
        program: prog,
        retrievedDocumentation: corpus,
        retrievalMetadata: { corpusChars: corpus.length, inHelpChannel: true, gateVerdict: c.intent },
        currentIntent: c.intent,
        inHelpChannel: true,
      });
    } catch (e) {
      rows.push({ ...c, actual: "ERROR", err: e.message });
      console.log(`${c.name}: expected=${c.expected} actual=ERROR (${e.message})`);
      continue;
    }
    const d = res.decision;
    const p = d.probabilities || {};
    const f = (v) => (typeof v === "number" ? v.toFixed(2) : "?");
    console.log(
      `${c.name}: expected=${c.expected} actual=${res.action} ` +
      `support=${f(p.isSupportQuestion)} docs=${f(p.documentationIsSufficient)} ` +
      `reply=${f(p.shouldReply)} human=${f(p.needsHuman)} risk=${typeof d.risk === "number" ? d.risk.toFixed(1) : "?"} ` +
      `corpus=${corpus.length} reason=${res.reason} err=${res.errorKind} src=${d.source}`,
    );
    rows.push({ ...c, actual: res.action, support: p.isSupportQuestion, docs: p.documentationIsSufficient, reply: p.shouldReply, human: p.needsHuman, risk: d.risk, corpus: corpus.length, errorKind: res.errorKind, source: d.source });
    await new Promise((r) => setTimeout(r, Number(process.env.JEV_CAL_DELAY_MS || 2500)));
  }

  let fp = [], fn = [], overEsc = [], underEsc = [], rateLimited = [];
  for (const r of rows) {
    if (r.actual === "ERROR") { fn.push(r.name + "(error)"); continue; }
    if (r.errorKind === "rate_limit" || r.errorKind === "timeout" || r.errorKind === "unavailable") { rateLimited.push(`${r.name}(${r.errorKind})`); continue; }
    if (r.expected === "reply" && r.actual !== "reply") fn.push(r.name);
    else if ((r.expected === "escalate" || r.expected === "safe") && r.actual === "reply") fp.push(r.name);
    else if (r.expected === "silence" && r.actual === "reply") fp.push(r.name);
    else if (r.expected === "silence" && r.actual === "escalate") overEsc.push(r.name);
    else if (r.expected === "escalate" && r.actual === "silence") underEsc.push(r.name);
  }
  console.log(`\nFALSE POSITIVES (answered when it should not): ${fp.length} [${fp.join(", ")}]`);
  console.log(`FALSE NEGATIVES (blocked when answerable): ${fn.length} [${fn.join(", ")}]`);
  console.log(`OVER-ESCALATIONS (chatter escalated instead of silent): ${overEsc.length} [${overEsc.join(", ")}]`);
  console.log(`UNDER-ESCALATIONS (escalate-worthy left silent, still safe): ${underEsc.length} [${underEsc.join(", ")}]`);
  console.log(`INCONCLUSIVE (gateway error, excluded): ${rateLimited.length} [${rateLimited.join(", ")}]`);
  const replyPs = rows.filter((r) => r.expected === "reply" && typeof r.reply === "number").map((r) => r.reply).sort((a, b) => a - b);
  if (replyPs.length) console.log(`reply_p distribution on expected-reply: min=${Math.min(...replyPs).toFixed(2)} max=${Math.max(...replyPs).toFixed(2)} sorted=[${replyPs.map((v) => v.toFixed(2)).join(", ")}]`);
  const docsPs = rows.filter((r) => r.expected === "reply" && typeof r.docs === "number").map((r) => r.docs).sort((a, b) => a - b);
  if (docsPs.length) console.log(`docs_p distribution on expected-reply: min=${Math.min(...docsPs).toFixed(2)} max=${Math.max(...docsPs).toFixed(2)} sorted=[${docsPs.map((v) => v.toFixed(2)).join(", ")}]`);
  try {
    const s = jevDecision.getStats();
    console.log(`jev_gateway_calls=${s.calls} jev_cache_hits=${s.cacheHits}`);
  } catch (_) {}
}

main().then(() => process.exit(0)).catch((e) => { console.error("HARNESS-FAILED:", e.message); process.exit(1); });
