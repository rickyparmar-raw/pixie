// The App Home tab: pixie's private homepage, one per viewer.
//
// Public information for anyone who opens it — what pixie knows, what it can
// walk them through, how well the docs are holding up — plus, for helpers only,
// the review queue as clickable buttons.
const knowledge = require("./knowledge");
const guides = require("./guides");
const learn = require("./learn");
const db = require("./db");
const cache = require("./cache");
const log = require("./log");
const { isAdmin } = require("./config");
const { relativeTime, coverageStats, statsText } = require("./stats");

// How many candidates the home tab renders. Slack caps a view at 100 blocks and
// each candidate costs two, so this stays well clear of the ceiling while still
// showing enough to work through in one sitting.
const HOME_REVIEW_LIMIT = 8;
const HOME_LEARNED_LIMIT = 3;

const APPROVE_ACTION = "learn_approve";
const DROP_ACTION = "learn_drop";

// Below this, the docs are failing more questions than they answer and the
// message says so plainly. The number was 23% when this was written — visible
// nowhere except one bullet in the middle of /pixie-stats, which is why nobody
// knew the corpus needed work.
const HEALTHY_COVERAGE = 50;

function coverageBlocks() {
  const { docs, asked, rate } = coverageStats();
  if (asked === 0) return [];

  const verdict =
    rate >= HEALTHY_COVERAGE
      ? "the docs are carrying most questions."
      : "most answers came from general knowledge, not the docs — the gaps below are what to write next.";

  return [
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*docs coverage — ${rate}%* _(last 7d)_\n${docs} of ${asked} questions answered from the docs. ${verdict}`,
      },
    },
  ];
}

// What pixie has picked up by being used. Separate from docs coverage on
// purpose: coverage is a question about the docs, this is a question about
// pixie — every answer here is one it can now give without a model call.
function learnedBlocks() {
  const { known, cacheHits, instant } = coverageStats();
  if (known === 0) return [];

  const top = cache.topCached(HOME_LEARNED_LIMIT).filter((row) => row.ask_count > 1);
  const lines = [`*answers known cold — ${known}*`, `${cacheHits} replies (${instant}%) needed no thinking at all.`];

  if (top.length > 0) {
    lines.push("", "asked most:");
    for (const row of top) lines.push(`• _${row.question}_ — ${row.ask_count}x`);
  }

  return [{ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
}

// The review queue, as buttons. `/pixie-pending` prints the same rows and
// `/pixie-approve <n>` accepts them one id at a time, which is why 96 rows
// accumulated without a single review: matching numbers by eye across a wall of
// ephemeral text is work nobody was going to do. Approving here is one click.
function reviewBlocks(userId) {
  if (!isAdmin(userId)) return [];

  const rows = learn.pending(HOME_REVIEW_LIMIT);
  if (rows.length === 0) {
    return [
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "*waiting for review*\n_nothing queued_ :yay:" } },
    ];
  }

  const blocks = [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*waiting for review* — ${rows.length} candidate answer(s)` } },
  ];

  for (const row of rows) {
    // A row lib/report.js drafted from repeated help-channel questions has no
    // author — `<@null>` would render as literal broken text instead of a
    // mention, so it gets its own attribution rather than pretending a human
    // wrote it.
    const attribution = row.author_id ? `from <@${row.author_id}>` : "drafted from repeated help-channel questions";
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*asked:* _${row.question.slice(0, 150)}_\n>${row.answer.slice(0, 300).replace(/\n/g, "\n>")}\n_${attribution}, ${relativeTime(row.created_at)}_`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve", emoji: true },
            action_id: `${APPROVE_ACTION}_${row.id}`,
            value: String(row.id),
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Drop", emoji: true },
            action_id: `${DROP_ACTION}_${row.id}`,
            value: String(row.id),
          },
        ],
      },
    );
  }

  return blocks;
}

function homeBlocks(userId) {
  const sources = (() => {
    try {
      return knowledge.loadSources();
    } catch {
      return [];
    }
  })();

  const gaps = db.topGaps(5);
  const topics = db.getTopics(userId).slice(0, 5);

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "pixie", emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "i answer Pixl questions from the docs. ping me anywhere, DM me here, or use `/pixie <question>` for a private answer.",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*what i know*\n${sources.map((s) => `• ${s.name}`).join("\n") || "_no sources loaded_"}\n\n_refreshed ${relativeTime(knowledge.lastBuiltAt?.getTime())}_`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*what i can walk you through*\n${Object.values(guides.GUIDES)
          .map((g) => `• ${g.name}`)
          .join("\n")}`,
      },
    },
    ...coverageBlocks(),
    ...learnedBlocks(),
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*stats*\n${statsText().split("\n").slice(1).join("\n")}` } },
  ];

  if (topics.length > 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*you've asked about*\n${topics.map((t) => `• ${t.topic}`).join("\n")}` },
      },
    );
  }

  if (gaps.length > 0) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*top gaps in the docs*\n${gaps.map((g) => `• ${g.count}× ${g.question.slice(0, 80)}`).join("\n")}`,
        },
      },
    );
  }

  blocks.push(...reviewBlocks(userId));

  return blocks;
}

// Both buttons do the same three things, so they share one handler: run the
// action, then re-publish the home view so the row it acted on disappears and
// the next candidate moves up.
function reviewAction(apply, verb) {
  return async ({ ack, body, action, client }) => {
    await ack();

    const userId = body?.user?.id;
    // The buttons only render for admins, but a stale view in an old tab can
    // still fire one, so re-check rather than trusting what was rendered.
    if (!isAdmin(userId)) return;

    const id = Number(action?.value);
    if (Number.isInteger(id) && id > 0) {
      log.info("learn", `${verb} #${id} from app home by ${userId}`);
      apply(id);
    }

    try {
      await client.views.publish({ user_id: userId, view: { type: "home", blocks: homeBlocks(userId) } });
    } catch (e) {
      log.error("home", "republish after review failed:", e.message);
    }
  };
}

async function onAppHomeOpened({ event, client }) {
  if (event.tab !== "home") return;
  try {
    await client.views.publish({
      user_id: event.user,
      view: { type: "home", blocks: homeBlocks(event.user) },
    });
  } catch (e) {
    log.error("home", "publish failed:", e.message);
  }
}

function register(app) {
  app.event("app_home_opened", onAppHomeOpened);

  // Matched by prefix because each row's action_id carries its own id, keeping
  // every button in the view distinct. Requires Interactivity to be enabled on
  // the Slack app — Socket Mode carries it with no Request URL, but the toggle
  // still has to be on or the buttons silently do nothing.
  app.action(new RegExp(`^${APPROVE_ACTION}_`), reviewAction(learn.approve, "approved"));
  app.action(new RegExp(`^${DROP_ACTION}_`), reviewAction(learn.forget, "dropped"));
}

module.exports = {
  register,
  homeBlocks,
  reviewBlocks,
  coverageBlocks,
  reviewAction,
  onAppHomeOpened,
  HOME_REVIEW_LIMIT,
  HOME_LEARNED_LIMIT,
  HEALTHY_COVERAGE,
};
