// Bootstrap. Event routing lives in lib/handlers.js, the answering pipeline in
// lib/respond.js, slash commands and the home tab in lib/commands.js.
const { App } = require("@slack/bolt");
const { config, validate, resolveBotUserId } = require("./lib/config");
const knowledge = require("./lib/knowledge");
const handlers = require("./lib/handlers");
const commands = require("./lib/commands");
const guides = require("./lib/guides");
const respond = require("./lib/respond");
const warm = require("./lib/warm");
const report = require("./lib/report");
const web = require("./lib/web/serve");
const db = require("./lib/db");
const log = require("./lib/log");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Measured: the first request after an idle stretch costs ~2000ms against
// ~1250ms warm — a TLS handshake pixie pays for because a help channel is quiet
// between questions, which is exactly when the socket gets dropped. GET /models
// returns 200 and costs no tokens; it exists here only to hold the connection
// open so the next real question doesn't pay for one.
const KEEPALIVE_INTERVAL_MS = 60 * 1000;

function startKeepAlive() {
  return setInterval(() => {
    const key = config.zenApiKeys?.[0] || (typeof config.answer.apiKey === "function" ? config.answer.apiKey() : config.answer.apiKey);
    fetch(`${config.answer.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    }).catch((e) => log.debug("keepalive", `ping failed: ${errorText(e)}`));
  }, KEEPALIVE_INTERVAL_MS);
}

async function startBot() {
  validate({ needsSlack: true });
  db.open();
  require("./lib/draftSandbox").loadPersisted();
  try {
    require("./lib/knowledge").loadDraftPersisted();
  } catch (e) {
    log.debug("draft", `draft index rebuild failed: ${errorText(e)}`);
  }
  db.startSweeper();

  // A channel with two roles (main of one program, help of another; or env
  // and program config disagreeing) makes every routing decision depend on
  // load order. Refuse to start instead.
  const roles = require("./lib/channelPolicy").validate();
  if (!roles.ok) {
    for (const e of roles.errors) log.error("config", `channel role conflict: ${errorText(e)}`);
    throw new Error(`channel role configuration invalid (${roles.errors.length} conflict(s))`);
  }

  try {
    const channelPolicy = require("./lib/channelPolicy");
    // Rows with no channel at all date from before multi-tenancy, when this
    // bot served Pixl alone (see scripts/hardwire-isolate-legacy-facts.mjs),
    // so they belong to Pixl when Pixl is configured, and to nobody otherwise.
    const legacyOwner = require("./lib/programs").get("pixl") ? "pixl" : null;
    const facts = db.assignUnownedLearnedFacts((channel: string | null) => {
      if (!channel) return legacyOwner;
      const r = channelPolicy.resolve(channel);
      return r.role === "none" ? null : r.program?.id || null;
    });
    if (facts.unowned) log.info("knowledge", `legacy learned facts: ${facts.assigned} assigned to their channel's program, ${facts.remaining} left unowned (served to no program)`);
  } catch (e) {
    log.warn("knowledge", `legacy learned-fact ownership pass failed: ${errorText(e)}`);
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  app.event("message", handlers.onMessage);
  app.event("app_mention", handlers.onAppMention);
  app.event("reaction_added", handlers.onReactionAdded);
  app.event("reaction_removed", handlers.onReactionRemoved);
  commands.register(app);

  // Bolt swallows listener errors by default; surfacing them keeps a broken
  // handler from silently making pixie mute.
  app.error(async (error: Error) => {
    log.error("bolt", error.message);
  });

  // The warmer answers the FAQ once the corpus is actually loaded — starting it
  // first would have it asking questions against an empty knowledge base.
  knowledge
    .refreshCorpus()
    .then(() => warm.start())
    .catch((e: unknown) => log.error("knowledge", "initial corpus build failed:", errorText(e)));
  knowledge.startAutoRefresh(config.refreshIntervalMin);
  startKeepAlive();
  // Judges the unclassified gap backlog on a slow loop, and posts the weekly
  // report once it's due. Both are background work — see lib/report.js.
  report.start(app.client);
  // Stale-ticket watchdog. No-op unless programs set SLA thresholds; one
  // replica at a time via job lease — see lib/sla.js.
  try {
    require("./lib/sla").startSlaLoop(app.client);
  } catch (e) {
    log.error("sla", "loop failed to start:", errorText(e));
  }
  // Support Radar detectors, same single-flight-across-replicas shape as the
  // SLA loop — see lib/radar.js.
  try {
    require("./lib/radar").startRadarLoop();
  } catch (e) {
    log.error("radar", "loop failed to start:", errorText(e));
  }

  // Web console: starts if SLACK_CLIENT_ID is set, silently skipped otherwise.
  const webServer = web.start();
  if (webServer) {
    const api = require("./lib/web/api");
    api.setSlackClient(app.client);
  }

  await app.start();
  // Mention detection compares against this, so it has to be resolved before
  // the first message is handled in earnest.
  const botUserId = await resolveBotUserId(app.client);
  log.info("bot", `connected via Socket Mode as ${botUserId}`);

  // Automatically join all configured public program channels
  try {
    const programs = require("./lib/programs");
    const channelList = programs.getChannelsList();
    for (const item of channelList) {
      if (item.channelId && item.channelId.startsWith("C")) {
        await app.client.conversations.join({ channel: item.channelId }).catch((e: unknown) => {
          log.debug("bot", `could not auto-join channel ${item.channelId}: ${errorText(e)}`);
        });
      }
    }
  } catch (e) {
    log.debug("bot", `auto-join error: ${errorText(e)}`);
  }
  try {
    require("./lib/resolutionWatcher").start(app.client);
  } catch (e) {
    log.error("resolution", "watcher failed to start:", errorText(e));
  }
  try {
    require("./lib/ticketBackfill").start(app.client);
  } catch (e) {
    log.error("ticketBackfill", "history import failed to start:", errorText(e));
  }
}

// Offline test mode: `bun index.js --ask "how do i join pixl?"` builds the
// corpus and prints what pixie would reply, no Slack connection needed.
async function runAskCli(question: string): Promise<void> {
  validate({ needsSlack: false });
  db.open();
  await knowledge.refreshCorpus();

  const guideId = await guides.detectGuideIntent(question);
  if (guideId) {
    const result = guides.startGuide(guideId, "cli-test", "cli-user");
    console.log(`[pixie] would start guide: "${guideId}"`);
    console.log(`[pixie] first message: ${result.message}`);
    if (result.checkNext) console.log(`[pixie] prompt: ${result.checkNext}`);
    guides.cancelGuide("cli-test");
    return;
  }

  // Same single call the mention path uses, so what --ask prints is what Slack
  // would get. A null source means the docs didn't cover it and the reply is
  // conversational.
  const result = await respond.answerOrChat(question, "");
  if (result?.answer) {
    console.log(`[pixie] source: ${result.source || "(conversational — not in docs)"}`);
    console.log(`[pixie] answer: ${result.answer}`);
    return;
  }

  console.log(`[pixie] would show the fallback: "${respond.MENTION_FALLBACK}"`);
}

function main() {
  process.on("unhandledRejection", (reason) => {
    log.error("process", "unhandled rejection:", reason instanceof Error ? reason.message : reason);
  });

  const askIdx = process.argv.indexOf("--ask");
  if (askIdx !== -1) {
    const question = process.argv[askIdx + 1];
    if (!question) {
      console.error('Usage: bun index.js --ask "<question>"');
      process.exit(1);
    }
    runAskCli(question)
      .then(() => process.exit(0))
      .catch((e) => {
        console.error("[pixie] --ask failed:", errorText(e));
        process.exit(1);
      });
    return;
  }

  startBot().catch((e) => {
    console.error(`[pixie] failed to start: ${errorText(e)}`);
    process.exit(1);
  });
}

main();

export {};
