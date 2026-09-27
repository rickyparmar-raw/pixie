// Builds Pixie's App Home view, including admin-only learning review actions.
import knowledge = require("./knowledge");
import reply = require("./reply");
import guides = require("./guides");
import learn = require("./learn");
import db = require("./db");
import cache = require("./cache");
import programs = require("./programs");
import log = require("./log");
import brand = require("./brand");
import configModule = require("./config");
import stats = require("./stats");
import type { KnownBlock } from "@slack/types";
import type { SlackClient } from "./types";
import type { LearnedRow } from "./db.types";

const { isAdmin } = configModule;
const { relativeTime, coverageStats, statsText } = stats;
interface TopicRow { topic: string }
interface GapRow { question: string; ask_count: number }
interface SourceRow { name: string }
interface HomeActionArgs {
  ack: () => Promise<unknown>;
  body: { user?: { id?: string } };
  action?: { value?: string };
  client: SlackClient;
}
interface HomeApp {
  event(name: string, handler: unknown): void;
  action(name: RegExp, handler: unknown): void;
}

const HOME_REVIEW_LIMIT = 8;
const HOME_LEARNED_LIMIT = 3;

const APPROVE_ACTION = "learn_approve";
const DROP_ACTION = "learn_drop";

const HEALTHY_COVERAGE = 50;

// Keep review rows below Slack's block limit: each candidate uses multiple blocks.
function divider(): KnownBlock {
  return { type: "divider" };
}

function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function coverageBlocks(): KnownBlock[] {
  // Coverage is hidden until there is a question sample; an empty denominator should not look like zero percent.
  const { docs, asked, rate } = coverageStats();
  if (asked === 0) return [];

  const verdict =
    rate >= HEALTHY_COVERAGE
      ? "the docs are carrying most questions."
      : "most answers came from general knowledge, not the docs — the gaps below are what to write next.";

  return [
    divider(),
    section(`*docs coverage — ${rate}%* _(last 7d)_\n${docs} of ${asked} questions answered from the docs. ${verdict}`),
  ];
}

function learnedBlocks(): KnownBlock[] {
  // Only repeated cache hits are useful on Home; one-off facts would crowd out actionable review data.
  const { known, cacheHits, instant } = coverageStats();
  if (known === 0) return [];

  const top = cache.topCached(HOME_LEARNED_LIMIT).filter((row) => (row.ask_count || 0) > 1);
  const lines = [`*answers known cold — ${known}*`, `${cacheHits} replies (${instant}%) needed no thinking at all.`];

  if (top.length > 0) {
    lines.push("", "asked most:");
    for (const row of top) lines.push(`• _${row.question}_ — ${row.ask_count}x`);
  }

  return [divider(), section(lines.join("\n"))];
}

function reviewBlocks(userId: string): KnownBlock[] {
  if (!isAdmin(userId)) return [];

  const rows = learn.pending(HOME_REVIEW_LIMIT) as LearnedRow[];
  if (rows.length === 0) {
    return [divider(), section("*waiting for review*\n_nothing queued_ :yay:")];
  }

  const blocks: KnownBlock[] = [divider(), section(`*waiting for review* — ${rows.length} candidate answer(s)`)];

  for (const row of rows) {
    // Pending rows without an author come from aggregated gaps, not a Slack member.
    const attribution = row.author_id ? `from <@${row.author_id}>` : "drafted from repeated help-channel questions";
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*asked:* _${row.question.slice(0, 150)}_\n>${row.answer.slice(0, 300).replace(/\n/g, "\n>")}\n_${attribution}, ${relativeTime(Number(row.created_at))}_`,
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

function programSummary(): string {
  const named = allProgramNames().filter((n: string) => n);
  if (named.length === 0) return "Hack Club YSWS programs";
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

function allProgramNames(): string[] {
  try {
    return programs
      .all()
      .filter((p: { id: string; name: string }) => p.id !== "ysws-global")
      .map((p: { id: string; name: string }) => p.name);
  } catch (e) {
    log.warn("home", `failed to get all program names: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function safeSources(): SourceRow[] {
  try {
    return knowledge.loadSources() as SourceRow[];
  } catch (e) {
    log.warn("home", `failed to load safe sources: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function homeBlocks(userId: string): KnownBlock[] {
  // Home is assembled from safe fallbacks so a broken source or program lookup cannot prevent publishing.
  const sources = safeSources();

  const gaps = db.topGaps(5);
  const topics = db.getTopics(userId).slice(0, 5);

  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: brand.name(), emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `i answer questions for ${programSummary()} from their docs. ping me anywhere, DM me here, or use \`${brand.cmd()} <question>\` for a private answer.`,
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
        text: `*what i can walk you through*\n${guides.availableFor(programs.all()[0])
          .map(([, g]: [string, { name: string }]) => `• ${g.name}`)
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
        text: { type: "mrkdwn", text: `*you've asked about*\n${(topics as TopicRow[]).map((t) => `• ${t.topic}`).join("\n")}` },
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
          text: `*top gaps in the docs*\n${(gaps as GapRow[]).map((g) => `• ${g.ask_count}× ${g.question.slice(0, 80)}`).join("\n")}`,
        },
      },
    );
  }

  blocks.push(...reviewBlocks(userId));

  return reply.plainDashesInBlocks(blocks);
}

function reviewAction(apply: (id: number) => unknown, verb: string) {
  // Button actions re-check the actor because a Home view can outlive the authorization that rendered it.
  return async ({ ack, body, action, client }: HomeActionArgs): Promise<void> => {
    await ack();

    const userId = body?.user?.id;
    // Re-check authorization because stale Home views can outlive the rendered buttons.
    if (!isAdmin(userId)) return;

    const id = Number(action?.value);
    if (Number.isInteger(id) && id > 0) {
      log.info("learn", `${verb} #${id} from app home by ${userId}`);
      apply(id);

      if (verb === "dropped") {
        try {
          const row = db.getLearnedFactById(id);
          if (row && row.question) {
            db.recordGapRejection(row.question);
            log.info("gaps", `rejected as gap, will hide from topGaps: "${row.question.slice(0, 80)}"`);
          }
        } catch (e) {
          log.debug("gaps", `failed to record gap rejection: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    try {
      await client.views.publish({ user_id: userId!, view: { type: "home", blocks: homeBlocks(userId!) } });
    } catch (e) {
      log.error("home", "republish after review failed:", e instanceof Error ? e.message : String(e));
    }
  };
}

async function onAppHomeOpened({ event, client }: { event: { tab?: string; user: string }; client: SlackClient }): Promise<void> {
  if (event.tab !== "home") return;
  try {
    await client.views.publish({
      user_id: event.user,
      view: { type: "home", blocks: homeBlocks(event.user) },
    });
  } catch (e) {
    log.error("home", "publish failed:", e instanceof Error ? e.message : String(e));
  }
}

function register(app: HomeApp): void {
  app.event("app_home_opened", onAppHomeOpened);

  app.action(new RegExp(`^${APPROVE_ACTION}_`), reviewAction(learn.approve, "approved"));
  app.action(new RegExp(`^${DROP_ACTION}_`), reviewAction(learn.forget, "dropped"));
}

export = {
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
