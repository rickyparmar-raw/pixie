// Everything about getting pixie's words onto a Slack message: the placeholder,
// the streamed edits, the finished post, the vote reactions and the escalation
// marker. Split out of lib/respond.js, which now owns only the decision of what
// to say — the two together were past the 500-line ceiling.
const knowledge = require("./knowledge");
const log = require("./log");
const { config } = require("./config");

const THINKING = "_thinking..._";

// Slack's own guidance is no more than one update per second on a given
// message. 800ms keeps the text visibly moving without crowding that.
const STREAM_UPDATE_MS = 800;

function sourceLineFor(source) {
  if (!source) return "";
  const url = knowledge.getSourceUrl(source);
  const label = url ? `<${url}|${source}>` : source;
  return `\n\n_from ${label} btw — lmk if this doesn't cover it and a helper will hop in_`;
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
function postThinking(client, channel, threadTs) {
  return client.chat
    .postMessage({ channel, thread_ts: threadTs, text: THINKING })
    .then((res) => res.ts)
    .catch((e) => {
      log.debug("respond", `could not post placeholder: ${e.message}`);
      return null;
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
function makeStreamWriter({ client, channel, ensurePlaceholder }) {
  let latest = "";
  let sent = "";
  let timer = null;
  let lastAt = 0;
  let inFlight = Promise.resolve();

  const flush = () => {
    timer = null;
    lastAt = Date.now();
    if (!latest || latest === sent) return;
    sent = latest;
    const text = sent;
    inFlight = inFlight
      .then(() => ensurePlaceholder())
      .then((ts) => (ts ? client.chat.update({ channel, ts, text }) : null))
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

async function finalize(client, channel, threadTs, placeholder, text, { blocks = null } = {}) {
  const payload = { channel, text, ...(blocks ? { blocks } : {}) };
  const placeholderTs = await placeholder;

  if (placeholderTs) {
    try {
      await client.chat.update({ ...payload, ts: placeholderTs });
      return placeholderTs;
    } catch (e) {
      log.debug("respond", `update failed, posting fresh: ${e.message}`);
    }
  }

  const res = await client.chat.postMessage({ ...payload, thread_ts: threadTs });
  return res.ts;
}

// Drops the placeholder on the paths that end up saying nothing.
async function discardPlaceholder(client, channel, placeholder) {
  const ts = await placeholder;
  if (ts) await client.chat.delete({ channel, ts }).catch(() => {});
}

// In the dedicated help channel, a question the docs can't answer is exactly
// the kind that needs a person. Reacting on the original message marks it for
// helpers (and for Pixorpheus's ticket flow) without posting anything.
// Configure the emoji with PIXIE_ESCALATE_REACTION; unset disables it.
async function flagForHumans(client, channel, messageTs) {
  const reaction = config.escalateReaction;
  if (!reaction || channel !== config.slack.helpChannel || !messageTs) return;
  try {
    await client.reactions.add({ channel, timestamp: messageTs, name: reaction });
  } catch (e) {
    log.debug("respond", `could not flag for humans: ${e.message}`);
  }
}

async function seedFeedbackReactions(client, channel, messageTs) {
  const reactions = config.feedbackReactions || [];
  if (!client || !channel || !messageTs || reactions.length === 0) return;
  for (const name of reactions) {
    client.reactions.add({ channel, timestamp: messageTs, name }).catch((e) => {
      log.debug("respond", `could not seed reaction ${name}: ${e.message}`);
    });
  }
}


module.exports = {
  sourceLineFor,
  blocksFor,
  postThinking,
  makeStreamWriter,
  finalize,
  discardPlaceholder,
  flagForHumans,
  seedFeedbackReactions,
  THINKING,
  STREAM_UPDATE_MS,
};
