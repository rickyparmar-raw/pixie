import brand = require("./brand");

type Surface = "text" | "slash" | "both";
type Permission = "anyone" | "helper" | "organizer";
type ChannelRole = "main" | "help" | "dm";
interface CommandDefinition {
  name: string;
  aliases: string[];
  surface: Surface;
  permission: Permission;
  channelRoles: ChannelRole[];
  usage: string;
  description: string;
  handlerKey: string;
}
interface CommandMatch {
  command: CommandDefinition | null;
  args: string;
}
type AuthorizationReason =
  "unknown_command" | "not_organizer" | "not_helper" | "wrong_channel" | "commands_disabled" | "allowed";

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMMANDS: readonly CommandDefinition[] = Object.freeze([
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

function byHandlerKey(handlerKey: string, surface: Surface | null = null): CommandDefinition[] {
  return COMMANDS.filter(
    (c) => c.handlerKey === handlerKey && (surface === null || c.surface === surface || c.surface === "both"),
  );
}

function byName(name: string, surface: Surface | null = null): CommandDefinition | null {
  const want = String(name || "").toLowerCase();
  return COMMANDS.find((c) => c.name === want && (surface === null || c.surface === surface)) || null;
}

function knownNames(botNames: string[] = []): string[] {
  const names = [...(botNames || []), brand.slug(), brand.name(), brand.DEFAULT_SLUG]
    .map((n) => String(n || "").toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
}

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

function guidePrefixSource(names: string[]): string {
  const escaped = names.map(escapeRegex).join("|");
  return `(?:${escaped})[-_\\s]?guides?|!guides?|/(?:${escaped})[-_\\s]?guides?|/guides?`;
}

function tryMatch(source: string, text: string): string | null {
  const m = String(text || "").match(new RegExp(`^\\s*(?:${source})\\b\\s*([\\s\\S]*)$`, "i"));
  if (!m) return null;
  return (m[1] || "").trim();
}

function tryGuideMatch(text: string, names: string[]): string | null {
  const prefix = guidePrefixSource(names);
  const exact = String(text || "")
    .trim()
    .match(new RegExp(`^(?:${prefix})$`, "i"));
  if (exact) return "";
  const m = String(text || "").match(new RegExp(`^(?:${prefix})\\s+([\\s\\S]+)$`, "i"));
  if (!m) return null;
  return (m[1] || "").trim();
}

function stripMention(text: string, botUserId: string | null): string {
  if (!botUserId) return String(text || "");
  return String(text || "")
    .replace(new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, "g"), "")
    .trim();
}

function match(
  text: string,
  { botUserId = null, botNames = [] }: { botUserId?: string | null; botNames?: string[] } = {},
): CommandMatch | null {
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

  // bare forms first
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

function authorize(
  command: CommandDefinition | string | null,
  {
    userId = null,
    isHelper = false,
    isOrganizer = false,
    role = null,
    commandsEnabled = true,
  }: {
    userId?: string | null;
    isHelper?: boolean;
    isOrganizer?: boolean;
    role?: ChannelRole | null;
    commandsEnabled?: boolean;
  } = {},
): { ok: boolean; reason: AuthorizationReason } {
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

function list() {
  const lines = COMMANDS.map((c) => {
    const spell = c.surface === "text" ? `!${c.name}` : brand.cmd(c.name === "ask" ? "" : c.name);
    const scope = c.surface === "both" ? `${spell} / !${c.name}` : spell;
    return `• \`${scope}${c.usage ? ` ${c.usage}` : ""}\` — ${c.description}`;
  });
  return [`*${brand.name()} commands*`, ...lines].join("\n");
}

export = { COMMANDS, byName, byHandlerKey, match, authorize, list };
