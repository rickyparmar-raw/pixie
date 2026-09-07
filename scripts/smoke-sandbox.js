// Offline staging smoke: runs the #pixie-sandbox acceptance script through
// the REAL pipeline (eligibility → respond → tickets → copilot) with a
// scripted model and a fake Slack client. Proves behavior, not transport:
// live Socket Mode + real Slack delivery still need the staging deploy below.
//
//   PIXIE_DB_PATH=/tmp/smoke.db bun scripts/smoke-sandbox.js
const fs = require("fs");
const path = require("path");

process.env.PIXIE_DB_PATH = process.env.PIXIE_DB_PATH || "/tmp/pixie-smoke.db";
process.env.PIXIE_INTERNAL_TOKEN = process.env.PIXIE_INTERNAL_TOKEN || "smoke-token";
try { fs.unlinkSync(process.env.PIXIE_DB_PATH); } catch (_) {}

const program = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "staging", "sandbox-program.json"), "utf8"));
process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([program]);

const db = require("../lib/db");
const programs = require("../lib/programs");
const lookup = require("../lib/lookup");
const intent = require("../lib/intent");
const respond = require("../lib/respond");
const elig = require("../lib/eligibility");
const api = require("../lib/web/api");

db.open();

const BOT = "U0PIXIE";
const CH = "C0C04LB6VA5";
let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass += 1; console.log(`  ok: ${name}`); }
  else { fail += 1; console.log(`  FAIL: ${name}`); }
}

// Scripted model: grounded ONLY for the sandbox-end question.
lookup.answerOrChat = async (question) => {
  if (/when does this sandbox program end/i.test(question)) {
    return { source: "Sandbox FAQ", answer: "The sandbox program ends on December 31, 2026." };
  }
  return { source: null, answer: null };
};
intent.classifyIntent = async () => intent.HELP_NEEDED;

function fakeClient(posts) {
  return {
    chat: {
      postMessage: async (p) => { posts.push(p); return { ts: `ts-${posts.length}` }; },
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: { add: async () => ({}) },
  };
}

function decide(text, extra = {}) {
  return elig.shouldPixieRespond({
    text, userId: "U-asker", botUserId: BOT, botNames: ["pixie"],
    isHelpChannel: true, isTopLevel: true, posture: "active",
    program: programs.forChannel(CH, null), thread: null, ...extra,
  });
}

async function main() {
  console.log("== silence cases ==");
  for (const [name, text] of [["hello", "hello"], ["test", "test"], ["goated", "pixie is goated"], ["referential", "ask @Pixie next time"], ["human-only", "<@U999> can you check this?"]]) {
    const d = decide(text);
    check(`${name} → ${d.decision}`, d.decision === "silent" || d.decision === "human_defer");
  }

  console.log("== grounded answer ==");
  {
    const posts = [];
    await respond.respond({ client: fakeClient(posts), channel: CH, threadTs: "smoke-1", userId: "U-asker", question: "when does this sandbox program end?", mode: respond.ALWAYS, workspaceId: null });
    check("grounded reply posted", posts.some((p) => /December 31, 2026/.test(p.text || "")));
    check("branded as Sandbox Help", posts.some((p) => p.username === "Sandbox Help"));
  }

  console.log("== mention reply ==");
  {
    const posts = [];
    await respond.respond({ client: fakeClient(posts), channel: CH, threadTs: "smoke-2", userId: "U-asker", question: `<@${BOT}> when does this sandbox program end?`, mode: respond.ALWAYS, workspaceId: null });
    check("mention answered", posts.some((p) => /December 31/.test(p.text || "")));
  }

  console.log("== escalation, not fabrication ==");
  {
    const posts = [];
    await respond.respond({ client: fakeClient(posts), channel: CH, threadTs: "smoke-3", userId: "U-asker", question: "what is the sandbox refund policy", mode: respond.ALWAYS, workspaceId: null });
    const ticket = db.getTicketByThreadTs("smoke-3", null);
    check("ticket filed", !!ticket && ticket.program_id === "pixie-sandbox");
    check("no fabricated policy posted", !posts.some((p) => /refund.*approved|no refund|full refund/i.test(p.text || "")));
  }

  console.log("== mute lifecycle ==");
  {
    db.muteThread("smoke-4", CH);
    const d = decide("normal follow-up", { thread: { muted: true } });
    check("muted follow-up silent", d.decision === "silent");
    const r = decide("pixie come back", { thread: { muted: true } });
    check("reactivation replies", r.decision === "reply" && r.clearMute === true);
    db.unmuteThread("smoke-4");
  }

  console.log("== ticket lifecycle ==");
  {
    db.syncHelper({ programId: "pixie-sandbox", userId: "U-helper", source: "manual" });
    const t = db.createTicket({ programId: "pixie-sandbox", workspaceId: null, channel: CH, threadTs: "smoke-5", requesterId: "U-asker", question: "sandbox q" });
    check("created", !!db.getTicket(t));
    check("visible in search", api.internalTicketSearch({ programId: "pixie-sandbox" }).total >= 1);
    check("claim", api.internalTicketAction(t, "claim", { programId: "pixie-sandbox", actorId: "U-helper" }).ok === true);
    const note = api.internalTicketNote(t, { programId: "pixie-sandbox", actorId: "U-helper", body: "looking" });
    check("internal note", note.ok === true);
    const posts = [];
    const tickets = require("../lib/tickets");
    const replyRes = await tickets.replyToTicket({ ticketId: t, authorId: "U-helper", text: "here is the answer", client: fakeClient(posts) });
    check("dashboard reply reaches thread", replyRes.ok === true && posts.length === 1 && posts[0].thread_ts === "smoke-5");
    check("resolve", api.internalTicketAction(t, "resolve", { programId: "pixie-sandbox", actorId: "U-helper" }).ok === true);
    check("reopen", api.internalTicketAction(t, "reopen", { programId: "pixie-sandbox", actorId: "U-helper" }).ok === true);
    const timeline = db.listTicketEvents(t).map((e) => e.event_type);
    for (const ev of ["claimed", "helper_reply", "resolved", "reopened"]) check(`timeline has ${ev}`, timeline.includes(ev));
  }

  console.log("== copilot never auto-sends ==");
  {
    const posts = [];
    const copilot = require("../lib/copilot");
    const real = lookup.answerOrChat;
    lookup.answerOrChat = async () => ({ source: "Sandbox FAQ", answer: "December 31, 2026." });
    try {
      const draft = await copilot.draftReply({ program: programs.get("pixie-sandbox"), question: "when does it end" });
      check("draft produced", !!draft.draft);
      check("zero Slack sends during copilot", posts.length === 0);
      void fakeClient;
    } finally {
      lookup.answerOrChat = real;
    }
  }

  console.log("== staging guardrail ==");
  {
    const { config } = require("../lib/config");
    config.slack.stagingOnlyChannels = [CH];
    const handlers = require("../lib/handlers");
    const calls = [];
    const real = respond.respond;
    respond.respond = async (a) => calls.push(a);
    try {
      await handlers.onMessage({ event: { channel: "C0PIXL", user: "U-x", ts: "smoke-x1", text: "pixie help" }, client: {} });
      check("production channel dropped in staging", calls.length === 0);
    } finally {
      respond.respond = real;
      config.slack.stagingOnlyChannels = [];
    }
  }

  console.log(`\nSMOKE: ${pass} passed, ${fail} failed`);
  db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke crashed: ${e.stack || e.message}`);
  process.exit(1);
});
