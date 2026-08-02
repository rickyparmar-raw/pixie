// Slash commands and the channel-join welcome. All answers here are ephemeral or
// private by default — the point is getting help without adding noise to a
// busy channel. The App Home tab lives in home.js.
const knowledge = require("./knowledge");
const answer = require("./answer");
const respond = require("./respond");
const learn = require("./learn");
const teachThread = require("./teachThread");
const home = require("./home");
const report = require("./report");
const db = require("./db");
const log = require("./log");
const { config, isAdmin } = require("./config");
const { relativeTime, statsText } = require("./stats");

const GAP_LIMIT = 15;
const PENDING_LIMIT = 15;
const NOT_ALLOWED = "that one's helpers-only :nono:";

// Wraps a command so it only runs for PIXIE_ADMIN_USER_IDS. Used for anything
// that changes what pixie knows or exposes the maintainer view.
function adminOnly(handler) {
  return async (args) => {
    if (!isAdmin(args.command?.user_id)) {
      await args.ack();
      await args.respond({ response_type: "ephemeral", text: NOT_ALLOWED });
      return;
    }
    await handler(args);
  };
}

// Same allowlist as adminOnly, but for shortcut args ({shortcut, ack, client}
// rather than {command, ack, respond}) — a message shortcut has no `respond`
// helper of its own the way a slash command does.
function adminOnlyShortcut(handler) {
  return async (args) => {
    if (!isAdmin(args.shortcut?.user?.id)) {
      await args.ack();
      await args.client.chat.postEphemeral({
        channel: args.shortcut.channel.id,
        user: args.shortcut.user.id,
        text: NOT_ALLOWED,
      });
      return;
    }
    await handler(args);
  };
}


/* ------------------------------------------------------ /pixie-report ---- */

// The same builder the scheduled Monday post uses, so the two can never quote
// different numbers. `last` gets the previous week instead of this one.
async function reportCommand({ command, ack, respond: sendEphemeral }) {
  await ack();

  const weeksAgo = (command.text || "").trim().toLowerCase() === "last" ? 1 : 0;
  await sendEphemeral({ response_type: "ephemeral", text: report.reportText(weeksAgo) });
}

/* ------------------------------------------------------------- /pixie ---- */

// Ephemeral answer: same pipeline, but only the asker sees it.
async function askCommand({ command, ack, respond: sendEphemeral }) {
  await ack();

  const question = (command.text || "").trim();
  if (!question) {
    await sendEphemeral({ response_type: "ephemeral", text: "ask me something! e.g. `/pixie how do i unlock the next region`" });
    return;
  }

  try {
    const result = await respond.lookupAnswer(question, "");
    if (result) {
      await sendEphemeral({
        response_type: "ephemeral",
        text: `${result.answer}${respond.sourceLineFor(result.source)}`,
      });
      db.recordMetric("answer_docs");
      return;
    }

    db.recordGap(question, command.user_id, command.channel_id);
    const { getChatReply } = require("./chat");
    const chatReply = await getChatReply(question, "");
    await sendEphemeral({ response_type: "ephemeral", text: chatReply || respond.MENTION_FALLBACK });
    db.recordMetric(chatReply ? "answer_chat" : "fallback");
  } catch (e) {
    log.error("commands", "/pixie failed:", e.message);
    await sendEphemeral({ response_type: "ephemeral", text: respond.ERROR_FALLBACK });
  }
}

/* ------------------------------------------------------- /pixie-sources -- */

async function sourcesCommand({ ack, respond: sendEphemeral }) {
  await ack();

  let sources = [];
  try {
    sources = knowledge.loadSources();
  } catch (e) {
    await sendEphemeral({ response_type: "ephemeral", text: `couldn't read sources.json: ${e.message}` });
    return;
  }

  const lines = sources.map((s) => `• *${s.name}* — \`${s.type}\``);
  const built = knowledge.lastBuiltAt;
  await sendEphemeral({
    response_type: "ephemeral",
    text: [
      `*what i know* (${sources.length} source${sources.length === 1 ? "" : "s"})`,
      ...lines,
      "",
      `_last refreshed ${relativeTime(built?.getTime())}, auto-refresh every ${config.refreshIntervalMin}m_`,
    ].join("\n"),
  });
}

/* -------------------------------------------------------- /pixie-reload -- */

async function reloadCommand({ ack, respond: sendEphemeral }) {
  await ack();
  try {
    await knowledge.refreshCorpus();
    const { clearCache } = db;
    clearCache();
    await sendEphemeral({
      response_type: "ephemeral",
      text: "refreshed the docs and cleared the answer cache :yesyes:",
    });
  } catch (e) {
    await sendEphemeral({ response_type: "ephemeral", text: `refresh failed: ${e.message}` });
  }
}

/* ---------------------------------------------------------- /pixie-gaps -- */

// The docs to-do list: what people asked that the docs couldn't answer.
async function gapsCommand({ ack, respond: sendEphemeral }) {
  await ack();

  // Only questions judged to be real docs gaps. A miss is not the same claim as
  // "the docs should cover this" — an outage, someone's broken laptop and a
  // half-typed fragment all used to land here, which is why the list went
  // unread. See lib/report.js.
  const gaps = db.topGaps(GAP_LIMIT, undefined, { kind: report.DOCS });
  if (gaps.length === 0) {
    await sendEphemeral({ response_type: "ephemeral", text: "no unanswered questions logged yet :yay:" });
    return;
  }

  const lines = gaps.map((g, i) => `${i + 1}. *${g.count}×* — ${g.question.slice(0, 160)}`);
  await sendEphemeral({
    response_type: "ephemeral",
    text: ["*questions the docs didn't cover* (last 30d)", ...lines, "", "_worth adding these to the docs_"].join("\n"),
  });
}

/* --------------------------------------------------------- /pixie-stats -- */

async function statsCommand({ ack, respond: sendEphemeral }) {
  await ack();
  await sendEphemeral({ response_type: "ephemeral", text: statsText() });
}

/* ------------------------------------------------------- learning loop --- */

async function teachCommand({ command, ack, respond: sendEphemeral }) {
  await ack();

  const parsed = learn.parseTeach(command.text);
  if (!parsed) {
    await sendEphemeral({
      response_type: "ephemeral",
      text: `use \`/pixie-teach <question> ${learn.TEACH_SEPARATOR} <answer>\`\ne.g. \`/pixie-teach whats the prize for 3rd place ${learn.TEACH_SEPARATOR} 3rd place gets a mechanical keyboard\``,
    });
    return;
  }

  const id = learn.teach({ ...parsed, authorId: command.user_id });
  await sendEphemeral({
    response_type: "ephemeral",
    text: id
      ? `got it, i'll use that from now on :yesyes:\n>*Q:* ${parsed.question}\n>*A:* ${parsed.answer}\n\n_#${id} — remove it with \`/pixie-forget ${id}\`_`
      : "couldn't save that one, try again",
  });
}

// "Teach Pixie from thread" message shortcut — right-click a message → app
// actions. Not a slash command: Bolt's SlashCommand payload carries no
// thread_ts, so a slash command has no way to know which thread it was typed
// in. A message shortcut's payload does (see lib/teachThread.js).
async function teachThreadShortcut({ shortcut, ack, client }) {
  await ack();

  const channel = shortcut.channel.id;
  const threadTs = shortcut.message.thread_ts || shortcut.message_ts;
  const user = shortcut.user.id;

  try {
    const parsed = await teachThread.summarizeThread({ client, channel, threadTs });
    if (!parsed) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: "couldn't find a clear question and answer in that thread",
      });
      return;
    }

    const id = learn.captureFromThread({ ...parsed, authorId: user, threadTs, channel });
    await client.chat.postEphemeral({
      channel,
      user,
      text: id
        ? `queued for review :thinking_face:\n>*Q:* ${parsed.question}\n>*A:* ${parsed.answer}\n\n_#${id} — approve with \`/pixie-approve ${id}\`, or \`/pixie-forget ${id}\` to drop it_`
        : "already queued this thread, or couldn't save it — check `/pixie-pending`",
    });
  } catch (e) {
    log.error("commands", "teach-thread shortcut failed:", e.message);
    await client.chat.postEphemeral({ channel, user, text: respond.ERROR_FALLBACK });
  }
}

// Candidates captured from helpers answering in threads pixie missed.
async function pendingCommand({ ack, respond: sendEphemeral }) {
  await ack();

  const rows = learn.pending(PENDING_LIMIT);
  if (rows.length === 0) {
    await sendEphemeral({ response_type: "ephemeral", text: "nothing waiting for review :yay:" });
    return;
  }

  const lines = rows.map(
    (r) =>
      `*#${r.id}* — asked: _${r.question.slice(0, 100)}_\n` +
      `> ${r.answer.slice(0, 240)}\n` +
      `> _from <@${r.author_id}>, ${relativeTime(r.created_at)}_`,
  );

  await sendEphemeral({
    response_type: "ephemeral",
    text: [
      "*answers waiting for review*",
      ...lines,
      "",
      "_`/pixie-approve <n>` to start using one, `/pixie-forget <n>` to drop it_",
    ].join("\n"),
  });
}

function parseId(text) {
  const id = Number((text || "").trim().replace(/^#/, ""));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseForgetInput(text) {
  const raw = (text || "").trim();
  if (!raw) return null;
  if (raw === "all") return { type: "all" };
  if (raw.toLowerCase() === "pending") return { type: "pending" };

  const rangeMatch = raw.match(/^#?(\d+)\s*-\s*#?(\d+)$/);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1], 10);
    const to = parseInt(rangeMatch[2], 10);
    if (from > 0 && to >= from) {
      return { type: "range", from, to };
    }
  }

  const id = parseId(raw);
  if (id) return { type: "id", id };

  return null;
}

async function approveCommand({ command, ack, respond: sendEphemeral }) {
  await ack();

  const id = parseId(command.text);
  if (!id) {
    await sendEphemeral({ response_type: "ephemeral", text: "use `/pixie-approve <n>` — get the number from `/pixie-pending`" });
    return;
  }

  await sendEphemeral({
    response_type: "ephemeral",
    text: learn.approve(id) ? `approved #${id} — i'll use it from now on :yesyes:` : `couldn't find #${id}`,
  });
}

async function forgetCommand({ command, ack, respond: sendEphemeral }) {
  await ack();

  const parsed = parseForgetInput(command.text);
  if (!parsed) {
    await sendEphemeral({
      response_type: "ephemeral",
      text: "use `/pixie-forget <n>`, `/pixie-forget <from>-<to>`, `/pixie-forget pending`, or `/pixie-forget all`",
    });
    return;
  }

  if (parsed.type === "all") {
    const count = learn.forgetByStatus("all");
    await sendEphemeral({
      response_type: "ephemeral",
      text: count > 0 ? `forgot all ${count} learned fact${count === 1 ? "" : "s"}` : "no learned facts to forget",
    });
    return;
  }

  if (parsed.type === "pending") {
    const count = learn.forgetByStatus("pending");
    await sendEphemeral({
      response_type: "ephemeral",
      text: count > 0 ? `forgot ${count} pending fact${count === 1 ? "" : "s"}` : "no pending facts to forget",
    });
    return;
  }

  if (parsed.type === "range") {
    const count = learn.forgetRange(parsed.from, parsed.to);
    await sendEphemeral({
      response_type: "ephemeral",
      text: count > 0 ? `forgot ${count} fact${count === 1 ? "" : "s"} (#${parsed.from}-#${parsed.to})` : `no facts found in range #${parsed.from}-#${parsed.to}`,
    });
    return;
  }

  if (parsed.type === "id") {
    await sendEphemeral({
      response_type: "ephemeral",
      text: learn.forget(parsed.id) ? `forgot #${parsed.id}` : `couldn't find #${parsed.id}`,
    });
  }
}

/* ---------------------------------------------------------- onboarding --- */

const WELCOME = [
  "hey! welcome to Pixl :yay:",
  "",
  "i'm pixie — i answer questions from the Pixl docs. you can:",
  "• ping me in any channel",
  "• DM me right here",
  "• use `/pixie <question>` for a private answer",
  "",
  "quick links:",
  "• play: https://play.pixl.rsvp/",
  "• docs: https://www.pixl.rsvp/docs",
  "",
  "stuck on something a helper should see? post in #pixl-help :hii:",
].join("\n");

// Complements Pixorpheus's public channel welcome rather than duplicating it —
// this one is private, so it can be longer without adding channel noise.
//
// Linkified at send time, not at module load: the channel ID is read from
// config when the DM goes out, so the const above stays readable as the plain
// name and tests can still swap the channel.
async function onMemberJoined({ event, client }) {
  if (event.channel !== config.slack.autoReplyChannel) return;
  try {
    await client.chat.postMessage({ channel: event.user, text: answer.linkifyHelpChannel(WELCOME) });
    log.debug("onboarding", `welcomed ${event.user}`);
  } catch (e) {
    log.debug("onboarding", `could not DM ${event.user}: ${e.message}`);
  }
}

/* ----------------------------------------------------------- registration -- */

function register(app) {
  app.command("/pixie", askCommand);
  app.command("/pixie-sources", sourcesCommand);
  app.command("/pixie-stats", statsCommand);

  // Maintainer surface: changes what pixie knows, or exposes the review queue.
  app.command("/pixie-report", adminOnly(reportCommand));
  app.command("/pixie-reload", adminOnly(reloadCommand));
  app.command("/pixie-gaps", adminOnly(gapsCommand));
  app.command("/pixie-teach", adminOnly(teachCommand));
  app.command("/pixie-pending", adminOnly(pendingCommand));
  app.command("/pixie-approve", adminOnly(approveCommand));
  app.command("/pixie-forget", adminOnly(forgetCommand));

  app.shortcut("pixie_teach_thread", adminOnlyShortcut(teachThreadShortcut));

  app.event("member_joined_channel", onMemberJoined);

  home.register(app);
}

module.exports = {
  register,
  adminOnly,
  adminOnlyShortcut,
  askCommand,
  sourcesCommand,
  reloadCommand,
  gapsCommand,
  statsCommand,
  teachCommand,
  teachThreadShortcut,
  pendingCommand,
  approveCommand,
  forgetCommand,
  parseId,
  parseForgetInput,
  onMemberJoined,
  WELCOME,
};
