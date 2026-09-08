// Everything about getting pixie's words onto a Slack message: the placeholder,
// the streamed edits, the finished post, the vote reactions and the escalation
// marker. Split out of lib/respond.js, which now owns only the decision of what
// to say — the two together were past the 500-line ceiling.
const knowledge = require("./knowledge");
const log = require("./log");
const { config } = require("./config");

const THINKING = "_thinking..._";

// Slack's own guidance is no more than one update per second on a given
// message. 350ms keeps text feeling instant and responsive without flooding.
const STREAM_UPDATE_MS = 350;

const programs = require("./programs");

// WHY: one lazy require, not three. slackMessages is required lazily (not at
// module top) to avoid a require cycle at boot; every send site goes through
// here so the cycle dodge stays in exactly one place.
function sendProgramMessage(args) {
  return require("./slackMessages").sendProgramMessage(args);
}

// Pixie doesn't talk in dashes. The model reaches for em dashes constantly and
// a lot of the static copy has them too, so this runs on the way out to Slack
// rather than being left to every author and every completion to remember.
//
// Only real dashes and a spaced double hyphen are touched. An ordinary hyphen
// is load-bearing everywhere else in a bot that hands out shell commands:
// turning `git commit --amend` into `git commit, amend` would be worse than
// any dash. Fenced and inline code is skipped for the same reason.
const DASH_ANYWHERE = /\s*[\u2014\u2013]\s*|\s+--(?=\s)\s*/g;
const DASH_LINE_END = /\s*(?:[\u2014\u2013]|--)\s*$/gm;
const DASH_LINE_START = /^\s*(?:[\u2014\u2013]|--)\s*/gm;
const CODE_SPANS = /(```[\s\S]*?```|`[^`\n]*`)/g;

function dedash(part) {
  return (
    part
      // Dropped rather than replaced at the edges: a line that ends in a comma
      // or starts with one reads as a typo, which is worse than the dash was.
      .replace(DASH_LINE_END, "")
      .replace(DASH_LINE_START, "")
      .replace(DASH_ANYWHERE, ", ")
      // Whatever the dash was standing next to, don't leave two marks doing
      // one mark's job.
      .replace(/,[\s,]*,/g, ",")
      .replace(/\s+,/g, ",")
      .replace(/,\s*([.!?;:)\]])/g, "$1")
      .replace(/([(\[])\s*,\s*/g, "$1")
  );
}

function plainDashes(text) {
  if (!text) return "";
  // Odd indices are the captured code spans, which are passed through whole.
  return String(text)
    .split(CODE_SPANS)
    .map((part, i) => (i % 2 === 1 ? part : dedash(part)))
    .join("");
}

// Slack blocks carry their own copy of the text, so stripping only the
// top-level `text` would leave the dashes in the part people actually read.
function plainDashesInBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (block?.text?.text) return { ...block, text: { ...block.text, text: plainDashes(block.text.text) } };
    if (Array.isArray(block?.elements)) {
      return { ...block, elements: plainDashesInBlocks(block.elements) };
    }
    return block;
  });
}

function sourceLineFor(source) {
  if (!source) return "";
  const sourceName = typeof source === "object" ? source.name : source;
  let isHidden = typeof source === "object" ? !!source.hidden : false;

  if (typeof sourceName !== "string") return "";

  // If source is a question string from learned facts, or too long/has question marks, skip
  if (
    sourceName.length > 40 ||
    sourceName.includes("?") ||
    sourceName.toLowerCase().startsWith("how to") ||
    sourceName.toLowerCase().startsWith("how do")
  ) {
    return "";
  }

  if (!isHidden) {
    try {
      const allSources = knowledge.loadSources();
      const matched = allSources.find((s) => s && s.name && s.name.toLowerCase() === sourceName.toLowerCase());
      if (matched && matched.hidden) {
        isHidden = true;
      }
    } catch (e) {
      log.debug("reply", `source hidden check: ${e.message}`);
    }
  }
  if (isHidden) return "";

  const url = knowledge.getSourceUrl(sourceName);
  if (url) {
    return `\n\n_source: <${url}|${sourceName}>_`;
  }
  return "";
}

// Neutralizes Slack markup in untrusted text: without this a question
// containing <!channel> or <!here> pings the whole helper channel from the
// ticket card, and crafted <url|label> rewrites link destinations.
function escapeSlack(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function blocksFor(text) {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}

// Doc answers take ~2.5s and vision up to 30s. Posting a placeholder and
// editing it in place turns dead air into visible progress, and gives us a
// message ts to attach feedback reactions to.
//
// Deliberately NOT awaited by the caller: this is a Slack round-trip worth
// ~400ms, and awaiting it before starting the model call added that to every
// single reply for no reason. Callers hold the promise and resolve it only when
// they actually need the ts, by which point it has long since landed.
// Program-branded where the caller knows it: the placeholder is the first
// thing the requester sees, so it carries the support identity. Updates and
// the in-place finalize cannot rebrand (chat.update takes no identity), which
// is fine — identity is set once, at post time.
function postThinking(client, channel, threadTs, program = null) {
  return sendProgramMessage({ client, program, channel, threadTs, text: THINKING })
    .then((res) => res.ts)
    .catch((e) => {
      log.debug("respond", `could not post placeholder: ${e.message}`);
      return null;
    });
}

function stripReasoning(text) {
  if (!text) return "";
  let clean = String(text);

  // Strip XML-style thinking/scratchpad tags
  clean = clean
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/^[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*$/gi, "")
    .trim();

  // Strip leading safety headers
  while (true) {
    const next = clean.replace(
      /^(?:User\s+Safety|Safety\s+Assessment|Safety|Content\s+Filter|Safety\s+Category|Safety\s+Verdict):\s*[^\n]+\s*\n*/i,
      "",
    ).trim();
    if (next === clean) break;
    clean = next;
  }

  // Strip thinking process blocks
  if (/^(?:Here(?:\x27s|\x20is) (?:a |the )?thinking process:?|\*\*Thinking Process:?\*\*|Thinking Process:?)/i.test(clean)) {
    const markers = [
      /\n(?:SOURCE|ANSWER|OUTPUT|FINAL ANSWER):\s*/i,
      /\n[•\*]\s*\*Asker:\*/i,
      /\n(?:[^\n:]+)\s*::\s*(?:[^\n]+)$/m,
    ];
    for (const marker of markers) {
      const match = clean.match(marker);
      if (match && match.index !== undefined) {
        clean = clean.slice(match.index + match[0].length).trim();
        break;
      }
    }
  }

  // Strip leading scratchpad / reasoning labels
  while (true) {
    const next = clean
      .replace(/^(?:(?:\*{1,2})?(?:Here(?:\x27s|\x20is) (?:a |the )?)?(?:thinking\s+process|scratchpad|reasoning|internal\s+notes)(?:\*{1,2})?:?\s*[^\n]*\n*)/i, "")
      .trim();
    if (next === clean) break;
    clean = next;
  }

  return clean;
}

function stripReasoningInBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (block?.text?.text) return { ...block, text: { ...block.text, text: stripReasoning(block.text.text) } };
    if (Array.isArray(block?.elements)) {
      return { ...block, elements: stripReasoningInBlocks(block.elements) };
    }
    return block;
  });
}

// Rewrites the placeholder as the answer arrives, instead of leaving it saying
// "_thinking..._" until the whole completion lands. Measured: first token at
// ~1.5s against a p50 of 4891ms for the finished reply — that gap was dead air.
//
// Leading-edge throttle: the first fragment goes out immediately, the rest at
// most every STREAM_UPDATE_MS. Updates are chained rather than fired in
// parallel so they can't land out of order, and settle() drains the chain
// before finalize() writes the finished message over the top.
// threadTs lets each streamed edit re-check silence: a mute or takeover
// landing mid-answer stops the stream instead of finishing it in public.
function makeStreamWriter({ client, channel, ensurePlaceholder, threadTs = null }) {
  let latest = "";
  let sent = "";
  let timer = null;
  let lastAt = 0;
  let inFlight = Promise.resolve();

  const flush = () => {
    timer = null;
    lastAt = Date.now();
    const cleanLatest = stripReasoning(latest);
    if (!cleanLatest || cleanLatest === sent) return;
    sent = cleanLatest;
    const text = sent;
    inFlight = inFlight
      .then(() => ensurePlaceholder())
      .then((ts) => {
        if (!ts) return null;
        if (threadTs && silencedThread(threadTs)) return null;
        return client.chat.update({ channel, ts, text: plainDashes(text) });
      })
      .catch((e) => log.debug("respond", `stream update failed: ${e.message}`));
  };

  return {
    write(text) {
      latest = text;
      if (timer) return;
      timer = setTimeout(flush, Math.max(0, STREAM_UPDATE_MS - (Date.now() - lastAt)));
    },
    async settle() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
    },
  };
}

function silencedThread(threadTs) {
  if (!threadTs) return false;
  try {
    const db = require("./db");
    return db.isThreadMuted(threadTs) || db.isTakeover(threadTs);
  } catch (_) {
    return false;
  }
}

// WHY: a pure classify step before any Slack I/O. finalize() used to interleave
// three suppression reasons with the update/post calls; reading them as one
// decision object makes the precedence explicit: shadow swallows everything,
// a mid-stream mute/takeover removes the hanging placeholder instead of
// completing an answer nobody may see anymore, otherwise the reply goes out.
function decidePostSuppression({ program, threadTs, placeholderTs }) {
  if (program && program.shadowMode === true) return "shadow";
  if (placeholderTs && silencedThread(threadTs)) return "silenced";
  return null;
}

async function finalize(client, channel, threadTs, placeholder, text, { blocks = null, program = null } = {}) {
  const cleanText = stripReasoning(text);
  const cleanBlocks = blocks ? stripReasoningInBlocks(blocks) : null;
  const payload = {
    channel,
    text: plainDashes(cleanText),
    ...(cleanBlocks ? { blocks: plainDashesInBlocks(cleanBlocks) } : {}),
  };
  const placeholderTs = await placeholder;

  const suppressed = decidePostSuppression({ program, threadTs, placeholderTs });
  if (suppressed) {
    await discardPlaceholder(client, channel, placeholderTs);
    return null;
  }

  if (placeholderTs) {
    try {
      await client.chat.update({ ...payload, ts: placeholderTs });
      return placeholderTs;
    } catch (e) {
      log.debug("respond", `update failed, posting fresh: ${e.message}`);
      await discardPlaceholder(client, channel, placeholderTs);
    }
  }

  const res = await sendProgramMessage({ client, program, channel, threadTs, text: payload.text, blocks: payload.blocks || null });
  return res ? res.ts : null;
}

// Drops the placeholder on the paths that end up saying nothing.
// Retries on transient Slack errors and safely ignores permanent errors.
async function discardPlaceholder(client, channel, placeholder) {
  try {
    const ts = await Promise.resolve(placeholder).catch(() => null);
    if (!ts || !client?.chat?.delete) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await client.chat.delete({ channel, ts });
        if (res && res.ok === false) {
          const errCode = res.error || "";
          if (
            errCode === "message_not_found" ||
            errCode === "channel_not_found" ||
            errCode === "cant_delete_message" ||
            errCode === "compliance_exports_prevent_deletion"
          ) {
            return;
          }
          throw new Error(errCode || "delete failed");
        }
        return;
      } catch (e) {
        const code = e?.data?.error || e?.code || e?.message || "";
        if (
          code === "message_not_found" ||
          code === "channel_not_found" ||
          code === "cant_delete_message" ||
          code === "compliance_exports_prevent_deletion"
        ) {
          return;
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    }
  } catch (_) {}
}

// In the dedicated help channel, a question the docs can't answer is exactly
// the kind that needs a person. Reacting on the original message marks it for
// helpers (and for Pixorpheus's ticket flow) without posting anything.
// Configure the emoji with PIXIE_ESCALATE_REACTION; unset disables it.
async function flagForHumans(client, channel, messageTs, question = "", requesterId = null, workspaceId = null, placeholder = null) {
  if (!programs.isHelpChannel(channel) || !messageTs) {
    if (placeholder) await discardPlaceholder(client, channel, placeholder);
    return;
  }

  const prog = programs.forChannel(channel, workspaceId);
  if (prog && (prog.posture === "passive" || prog.shadowMode === true)) {
    if (placeholder) await discardPlaceholder(client, channel, placeholder);
    if (prog.posture === "passive") return;
  }

  const reaction = config.escalateReaction;
  if (reaction && !(prog && prog.shadowMode === true)) {
    try {
      await client.reactions?.add?.({ channel, timestamp: messageTs, name: reaction });
    } catch (e) {
      log.debug("respond", `could not flag for humans: ${e.message}`);
    }
  }

  try {
    const tickets = require("./tickets");
    await tickets.escalateTicket({
      program: prog,
      channel,
      threadTs: messageTs,
      requesterId: requesterId || "unknown",
      question: question || "Unanswered question in help channel",
      client,
      workspaceId,
      placeholder,
    });
  } catch (e) {
    log.debug("respond", `could not escalate ticket: ${e.message}`);
    if (placeholder) await discardPlaceholder(client, channel, placeholder);
  }
}

async function seedFeedbackReactions(client, channel, messageTs) {
  if (!messageTs) return;
  const reactions = config.feedbackReactions || [];
  if (!client || !channel || !messageTs || reactions.length === 0) return;
  for (const name of reactions) {
    client.reactions.add({ channel, timestamp: messageTs, name }).catch((e) => {
      log.debug("respond", `could not seed reaction ${name}: ${e.message}`);
    });
  }
}


module.exports = {
  escapeSlack,
  plainDashes,
  plainDashesInBlocks,
  sourceLineFor,
  blocksFor,
  postThinking,
  makeStreamWriter,
  finalize,
  discardPlaceholder,
  flagForHumans,
  seedFeedbackReactions,
  stripReasoning,
  stripReasoningInBlocks,
  decidePostSuppression,
  THINKING,
  STREAM_UPDATE_MS,
};
