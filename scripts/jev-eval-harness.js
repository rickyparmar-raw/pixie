// Local Jev evaluation harness. Compares the existing intent gate with the
// Jev decision gate on representative messages WITHOUT posting to Slack and
// WITHOUT generating answers. Needs AI_GATEWAY_API_KEY + JEV_ENABLED=true to
// reach the real model; otherwise it reports the existing decision only.
process.env.PIXIE_DB_PATH = ":memory:";

const db = require("../lib/db");
const intent = require("../lib/intent");
const knowledge = require("../lib/knowledge");
const jevDecision = require("../lib/jevDecision");
const programs = require("../lib/programs");

db.open(":memory:");

const CASES = [
  { name: "answerable", message: "when is the deadline?", docs: "### Pixl Docs\nThe deadline is August 18." },
  { name: "missing-docs", message: "what is the exact payout amount in dollars?", docs: "### Pixl Docs\nWelcome to the program." },
  { name: "chatter", message: "lmao that deploy was wild gg", docs: "### Pixl Docs\nThe deadline is August 18." },
  { name: "ambiguous", message: "how do i do this?", docs: "### Pixl Docs\nSubmit through the portal." },
  { name: "conflicting", message: "when is the deadline?", docs: "### A\nDeadline Aug 18.\n### B\nDeadline Sept 1." },
  { name: "review-timing", message: "how long does review take?", docs: "### Pixl Docs\nProjects are reviewed by humans." },
];

async function main() {
  await knowledge.refreshCorpus().catch(() => {});
  const prog = programs.forChannel("C0B6STY9G5N") || { id: "pixl", name: "Pixl" };
  console.log(`program=${prog.id} jev_enabled=${jevDecision.isEnabled()}`);
  for (const c of CASES) {
    let existing = null;
    try {
      existing = await intent.classifyIntent(c.message, prog, { addressed: false });
    } catch (e) {
      existing = `error:${e.message}`;
    }
    let jevAction = "skipped";
    let jevReason = "disabled";
    if (jevDecision.isEnabled()) {
      try {
        const res = await jevDecision.evaluateSupportDecision({
          message: c.message,
          conversationContext: "",
          program: prog,
          retrievedDocumentation: c.docs,
          retrievalMetadata: { harness: true },
          currentIntent: existing,
          inHelpChannel: true,
        });
        jevAction = res.action;
        jevReason = res.reason;
      } catch (e) {
        jevAction = "error";
        jevReason = e.message;
      }
    }
    console.log(`- ${c.name}: existing=${existing} jev=${jevAction} (${jevReason})`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
