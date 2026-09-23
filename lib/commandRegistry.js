// One registry of every command Pixie implements, so channel text can be
// dispatched through `match` + `authorize` BEFORE any conversational
// classification (see the recommended wiring in the workstream report).
//
// Handlers stay where they are — each definition carries a `handlerKey` and
// the architect maps that key to the existing function in lib/commands.js,
// lib/handlers.js or lib/respond.js. This module never answers, posts, reads
// the database, or calls the network: matching is pure regex over the text,
// authorization is pure predicate over the caller's flags.
//
// Trigger semantics are pinned to today's patterns, not re-derived:
//   - channel-text teach/sum shapes mirror handlers.teachPattern(false) and
//     handlers.sumPattern(false) exactly (anchored, case-insensitive);
//   - mention shapes mirror the mentionOnly=true variants, applied only after
//     an explicit <@BOTID> mention is stripped — a bare "teach foo" with no
//     mention matches nothing today, and still matches nothing here;
//   - !mute/!stfu mirror the command_bypass half of eligibility that has no
//     conversational reading ("stfu pixie" stays conversational and is owned
//     by respond.isMuteRequest, not by this registry);
//   - guide text shapes mirror respond.isGuideMenuRequest plus the
//     "<prefix> <topic>" form from respond.handleNewGuide.
// Slash names are never matched here: Bolt matches those exactly at
// registration (lib/commands.js via brand.cmd), so there is nothing to parse.
const brand = require("./brand");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One entry per (name, surface) pair. Teach appears twice on purpose: the
// text form is helper-runnable (actorRunsCommands: admin OR program helper)
// while the slash form is adminOnly — a single permission would either lock
// helpers out of !teach or let them into /pixie-teach, and both are wrong.
const COMMANDS = Object.freeze([
  {
    name: "ask",
    aliases: [],
    surface: "slash",
    permission: "anyone",
    channelRoles: ["main", "help", "dm"],
    usage: "[question] | help",
    description: "Private answer — help without cluttering the channel",
    handlerKey: "ask",
  },
  {
    name: "sources",
    aliases: [],
    surface: "slash",
    permission: "anyone",
    channelRoles: ["main", "help", "dm"],
    usage: "",
    description: "What's loaded and when it last refreshed",
    handlerKey: "sources",
  },
  {
    name: "stats",
    aliases: [],
    surface: "slash",
    permission: "anyone",
    channelRoles: ["main", "help", "dm"],
    usage: "",
    description: "Answer rate, cache hits, feedback, latency",
    handlerKey: "stats",
  },
  {
    name: "guide",
    aliases: ["guides"],
    surface: "both",
    permission: "anyone",
    channelRoles: ["main", "help", "dm"],
    usage: "[guide-name]",
    description: "Interactive step-by-step walkthrough guides",
    handlerKey: "guide",
  },
  {
    name: "check",
    aliases: [],
    surface: "slash",
    permission: "anyone",
    channelRoles: ["main", "help", "dm"],
    usage: "<github_repo_url>",
    description: "Check GitHub repository readiness for YSWS submission",
    handlerKey: "check",
  },
  {
    name: "calc",
    aliases: [],
    surface: "slash",
    permission: "anyone",
    channelRoles: ["main", "help", "dm"],
    usage: "<hours/reward>",
    description: "Calculate build hours, RE progression, and shop item goals",
    handlerKey: "calc",
  },
  {
    name: "report",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "[last]",
    description: "The weekly report now",
    handlerKey: "report",
  },
  {
    name: "reload",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "",
    description: "Re-fetch the docs and clear the cache, no restart",
    handlerKey: "reload",
  },
  {
    name: "gaps",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "",
    description: "Top questions the docs didn't cover",
    handlerKey: "gaps",
  },
  {
    name: "teach",
    aliases: ["learn", "remember", "memorize"],
    surface: "text",
    permission: "helper",
    channelRoles: ["main", "help"],
    usage: "<question> :: <answer> | teach this thread",
    description: "Memorize a thread or a Q/A fact for this program",
    handlerKey: "teach",
  },
  {
    name: "teach",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "<question> :: <answer>",
    description: "Teach an answer directly",
    handlerKey: "teach",
  },
  {
    name: "pending",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "",
    description: "Captured answers awaiting review",
    handlerKey: "pending",
  },
  {
    name: "approve",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "<n>",
    description: "Start using a captured answer",
    handlerKey: "approve",
  },
  {
    name: "forget",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "<n | from-to | pending | all>",
    description: "Drop learned answer(s) by id, range, pending, or all",
    handlerKey: "forget",
  },
  {
    // Mixed internally: `tickets on|off` is helper-runnable, every other
    // subcommand (list/add/set/remove) enforces admin itself. The registry
    // marks the strictest level; the in-handler gate for the tickets
    // subcommand stays where it is (see commands.programCommand).
    name: "program",
    aliases: [],
    surface: "slash",
    permission: "organizer",
    channelRoles: ["main", "help", "dm"],
    usage: "[list|add|set|remove|tickets on|off]",
    description: "Manage program channels and posture",
    handlerKey: "program",
  },
  {
    name: "sum",
    aliases: ["summary", "summarize", "summarise"],
    surface: "text",
    permission: "helper",
    channelRoles: ["main", "help"],
    usage: "[public|share]",
    description: "Summarize this thread for helpers (never writes knowledge)",
    handlerKey: "sum",
  },
  {
    // The explicit command spelling only. Natural-language shush ("stfu
    // pixie", "please be quiet") is conversational and stays in
    // respond.isMuteRequest — see match() below.
    name: "mute",
    aliases: ["stfu"],
    surface: "text",
    permission: "anyone",
    channelRoles: ["main", "help", "dm"],
    usage: "",
    description: "Leave the thread quietly",
    handlerKey: "mute",
  },
]);

function byHandlerKey(handlerKey, surface = null) {
  return COMMANDS.filter(
    (c) => c.handlerKey === handlerKey && (surface === null || c.surface === surface || c.surface === "both"),
  );
}

function byName(name, surface = null) {
  const want = String(name || "").toLowerCase();
  return (
    COMMANDS.find((c) => c.name === want && (surface === null || c.surface === surface)) || null
  );
}

// Names the bot answers to in text triggers: the caller's list plus the
// brand's own slug/name plus the historical default, same set respond.js
// uses. Lowercased once here so every matcher below stays case-insensitive
// without inline flags on the name alternation.
function knownNames(botNames) {
  const names = [...(botNames || []), brand.slug(), brand.name(), brand.DEFAULT_SLUG]
    .map((n) => String(n || "").toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
}

// Today's channel-text triggers, verbatim in meaning: handlers builds these
// from brand.slug() with ^\s*(?:...)\b anchors, case-insensitive.
function teachTextSource() {
  const slug = escapeRegex(brand.slug());
  return `!teach|${slug}-teach|/${slug}-teach|teach\\s+this|teach\\s+thread`;
}

function sumTextSource() {
  const slug = escapeRegex(brand.slug());
  return `!sum|!summary|!summarize|!summarise|${slug}-sum|/${slug}-sum|sum\\s+this|sum\\s+thread|summarize\\s+thread|summarise\\s+thread`;
}

function teachMentionSource() {
  const slug = escapeRegex(brand.slug());
  return `teach|learn|remember|memorize|!teach|/${slug}-teach`;
}

function sumMentionSource() {
  const slug = escapeRegex(brand.slug());
  return `sum|summary|summarize|summarise|!sum|!summary|!summarize|!summarise|/${slug}-sum`;
}

// Guide text shapes: the exact-match menu forms from isGuideMenuRequest plus
// the "<prefix> <topic>" starter from handleNewGuide, over the same name set.
function guidePrefixSource(names) {
  const escaped = names.map(escapeRegex).join("|");
  return `(?:${escaped})[-_\\s]?guides?|!guides?|/(?:${escaped})[-_\\s]?guides?|/guides?`;
}

function tryMatch(source, text) {
  const m = String(text || "").match(new RegExp(`^\\s*(?:${source})\\b\\s*([\\s\\S]*)$`, "i"));
  if (!m) return null;
  return (m[1] || "").trim();
}

// Guide menu triggers are exact-phrase (no trailing args allowed on the bare
// menu), while the topic form takes everything after the prefix as the topic.
function tryGuideMatch(text, names) {
  const prefix = guidePrefixSource(names);
  const exact = String(text || "").trim().match(new RegExp(`^(?:${prefix})$`, "i"));
  if (exact) return "";
  const m = String(text || "").match(new RegExp(`^(?:${prefix})\\s+([\\s\\S]+)$`, "i"));
  if (!m) return null;
  return (m[1] || "").trim();
}

// Strips one leading explicit bot mention, the way the app_mention path reads
// before matching: stripBotMention removes every <@ID>, so "<@B> !mute"
// reaches the mention patterns as "!mute". Bare names are NOT stripped —
// "pixie teach ..." matches nothing on the message path today either.
function stripMention(text, botUserId) {
  if (!botUserId) return String(text || "");
  return String(text || "")
    .replace(new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, "g"), "")
    .trim();
}

// Recognizes today's triggers. Returns { command, args } with args the text
// after the trigger token, or null when nothing fired. Mention-only shapes
// (bare "teach"/"sum"/"learn ...") apply solely to text that carried an
// explicit <@mention>; everything else matches the raw channel text.
function match(text, { botUserId = null, botNames = [] } = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  const names = knownNames(botNames);

  const teachArgs = tryMatch(teachTextSource(), raw);
  if (teachArgs !== null) return { command: byName("teach", "text"), args: teachArgs };

  const sumArgs = tryMatch(sumTextSource(), raw);
  if (sumArgs !== null) return { command: byName("sum"), args: sumArgs };

  const muteArgs = tryMatch("!mute|!stfu", raw);
  if (muteArgs !== null) return { command: byName("mute"), args: muteArgs };

  const guideArgs = tryGuideMatch(raw, names);
  if (guideArgs !== null) return { command: byName("guide"), args: guideArgs };

  // Mention path: only when an explicit mention was actually present, so a
  // bare "teach me something" in-channel can never route here.
  const stripped = stripMention(raw, botUserId);
  const mentioned = stripped !== raw.trim();
  if (!mentioned) return null;

  const teachMentionArgs = tryMatch(teachMentionSource(), stripped);
  if (teachMentionArgs !== null) return { command: byName("teach", "text"), args: teachMentionArgs };

  const sumMentionArgs = tryMatch(sumMentionSource(), stripped);
  if (sumMentionArgs !== null) return { command: byName("sum"), args: sumMentionArgs };

  const muteMentionArgs = tryMatch("!mute|!stfu", stripped);
  if (muteMentionArgs !== null) return { command: byName("mute"), args: muteMentionArgs };

  const guideMentionArgs = tryGuideMatch(stripped, names);
  if (guideMentionArgs !== null) return { command: byName("guide"), args: guideMentionArgs };

  return null;
}

// Pure gate. The caller maps identities to flags (isOrganizer = isAdmin,
// isHelper = isAdmin || db.isHelper(programId, userId)) and resolves the
// channel role via channelPolicy.resolve — this function only judges.
//   - organizer commands never run for normal users, whatever the channel;
//   - commandsEnabled=false (main-channel setting) silences every non-admin
//     command in main channels — organizers stay reachable so a muted room
//     can always be managed;
//   - role "none" (unclaimed channel) matches no command's channelRoles and
//     falls through to wrong_channel, mirroring the hard scope gate;
//   - a missing role (slash context: addressed actions carry no channel
//     scope) skips the channel check.
// Reasons are machine-readable; the caller owns the user-facing wording.
function authorize(command, { userId = null, isHelper = false, isOrganizer = false, role = null, commandsEnabled = true } = {}) {
  const def = typeof command === "string" ? byName(command) : command;
  void userId;
  if (!def) return { ok: false, reason: "unknown_command" };
  if (def.permission === "organizer" && !isOrganizer) {
    return { ok: false, reason: "not_organizer" };
  }
  if (def.permission === "helper" && !(isHelper || isOrganizer)) {
    return { ok: false, reason: "not_helper" };
  }
  if (role && !def.channelRoles.includes(role)) {
    return { ok: false, reason: "wrong_channel" };
  }
  if (role === "main" && commandsEnabled === false && def.permission !== "organizer") {
    return { ok: false, reason: "commands_disabled" };
  }
  return { ok: true, reason: "allowed" };
}

// Human-readable listing for help output. Slash spellings come from
// brand.cmd() so a rebranded fleet bot lists its own names.
function list() {
  const lines = COMMANDS.map((c) => {
    const spell = c.surface === "text" ? `!${c.name}` : brand.cmd(c.name === "ask" ? "" : c.name);
    const scope = c.surface === "both" ? `${spell} / !${c.name}` : spell;
    return `• \`${scope}${c.usage ? ` ${c.usage}` : ""}\` — ${c.description}`;
  });
  return [`*${brand.name()} commands*`, ...lines].join("\n");
}

module.exports = { COMMANDS, byName, byHandlerKey, match, authorize, list };
