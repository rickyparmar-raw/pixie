const fs = require("fs");
const path = require("path");
const { config } = require("./config");
const db = require("./db");
const log = require("./log");

const PROGRAMS_FILE = path.join(__dirname, "..", "programs.json");
const SOURCES_FILE = path.join(__dirname, "..", "sources.json");
const PROGRAM_FILE = path.join(__dirname, "..", "program.json");

// Channel IDs are only unique within one workspace — the same default the
// claim table (lib/db.js) and lib/workspace.js use, so an omitted workspace
// resolves the same row everywhere.
const DEFAULT_WORKSPACE = "default";
const SHARED_PROGRAM_ID = "ysws-global";

let cachedPrograms = null;
// See loadEnvPrograms(): keyed by the raw variable so a changed value re-parses.
let cachedEnvRaw = null;
let cachedEnvPrograms = null;

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    log.warn("programs", `failed to read ${path.basename(filePath)}: ${e.message}`);
    return fallback;
  }
}

function readSourcesJson() {
  return readJsonFile(SOURCES_FILE, []);
}

function readProgramJsonMilestones() {
  const data = readJsonFile(PROGRAM_FILE, {});
  return data.milestones || [];
}

// Every program field that was ever renamed keeps its legacy key as a fallback,
// so a fleet blob written against the old shape still resolves. First truthy
// wins — empty strings fall through exactly like the || chains this replaces.
function alt(p, ...keys) {
  for (const k of keys) {
    if (p[k]) return p[k];
  }
  return undefined;
}

// One shape for a program record, whatever it was loaded from. Both the env
// loader and the file loader go through this, so a field can't be normalized in
// one path and raw in the other.
//
// Note `scope` differs deliberately from legacyFallbackProgram()'s default: a
// program someone configured explicitly defaults to "any", while the unconfigured
// single-program fallback defaults to "program". Preserved as-is here — changing
// it would alter what an existing deployment answers when nobody addressed it.
function normalizeProgram(p) {
  return {
    id: p.id,
    name: p.name || p.id,
    posture: p.posture || "active",
    scope: p.scope === "program" ? "program" : "any",
    workspaceId: alt(p, "workspaceId", "workspace_id") || null,
    deploymentMode: alt(p, "deploymentMode", "deployment_mode") || "dedicated_legacy",
    supportName: alt(p, "supportName", "support_name") || null,
    iconUrl: alt(p, "iconUrl", "icon_url") || null,
    replySignature: alt(p, "replySignature", "reply_signature") || null,
    aiAnswers: p.aiAnswers === false || p.ai_answers === false ? false : true,
    ticketsEnabled: p.ticketsEnabled === false ? false : true,
    autoEscalate: p.autoEscalate === false ? false : true,
    sensitiveCategories: Array.isArray(p.sensitiveCategories || p.sensitive_categories) ? (p.sensitiveCategories || p.sensitive_categories) : [],
    supportActive: p.supportActive === false ? false : true,
    autoAssign: p.autoAssign === true || p.auto_assign === 1,
    helperPing: p.helperPing === true || p.helper_ping_enabled === 1,
    // Classification rules.
    categories: p.categories && typeof p.categories === "object" ? p.categories : null,
    // Defaults to thread.
    ticketVisibility: ["thread", "organizer", "dashboard"].includes(p.ticketVisibility || p.ticket_visibility)
      ? (p.ticketVisibility || p.ticket_visibility)
      : "thread",
    shadowMode: p.id === "jame-gam" ? false : (p.shadowMode === true || p.shadow_mode === 1),
    incidentMode: alt(p, "incidentMode", "incident_mode") || "ANSWER_AND_TRACK",
    publicTicketsEnabled: p.publicTicketsEnabled === false || p.public_tickets_enabled === 0 ? false : true,
    helpChannel: alt(p, "helpChannel", "help_channel") || null,
    organizerChannel: alt(p, "organizerChannel", "organizer_channel", "organizer_channel_id", "helperChannel") || null,
    channels: Array.isArray(p.channels) ? p.channels : [],
    helperGroup: alt(p, "helperGroup", "helper_group") || null,
    sources: Array.isArray(p.sources) ? p.sources : [],
    // Whether the cross-program shared layer (repo sources.json / a ysws-global
    // entry) is stacked on top of this program's own sources. A program that
    // ships its own complete docs and has its own policy — one that would be
    // contradicted, not helped, by the generic YSWS guidelines — sets this
    // false so its corpus is exactly its own sources.
    sharedSources: p.id === "ysws-global" ? true : false,
    milestones: Array.isArray(p.milestones) ? p.milestones : [],
    guides: Array.isArray(p.guides) ? p.guides : ["submit-ysws-guidelines"],
    // Concrete policy lines pinned into this program's answer prompt as
    // reinforcement (a specific number a small model kept getting wrong). Empty
    // for every program that answers purely from its own corpus.
    pinnedRules: Array.isArray(p.pinnedRules) ? p.pinnedRules.filter((r) => typeof r === "string" && r.trim()) : [],
    links: p.links || {},
    // Stored settings only; lib/programModel.js resolves the effective values.
    behavior: p.behavior && typeof p.behavior === "object" ? p.behavior : null,
    status: ["sandbox", "live", "paused"].includes(p.status) ? p.status : null,
  };
}

// Program config as a variable rather than a file on disk. One engine image
// serves the whole bot fleet, so the image cannot carry any single bot's
// channels, sources or milestones — a wizard-provisioned bot receives them here
// instead.
//
// Accepts either a bare array of programs or `{ programs: [...] }`, since the
// control plane finds the wrapped form easier to extend and hand-editing the
// bare form is easier.
//
// Malformed JSON deliberately does NOT throw: a bot whose blob got truncated in
// transit should fall through to the file loaders and come up answering
// something, rather than crash-looping where nobody can reach it to fix it. The
// warning is the signal — it lands in the deploy logs on the very first boot.
function loadEnvPrograms() {
  const raw = (process.env.PIXIE_PROGRAMS_JSON || "").trim();
  if (!raw) return null;
  // shared() consults this on every corpus build, so the parse is memoized
  // against the raw string — keyed by the value, not just "have I parsed", so a
  // test that changes the variable mid-process still sees its own value.
  if (cachedEnvRaw === raw) return cachedEnvPrograms;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn("programs", `PIXIE_PROGRAMS_JSON is not valid JSON (${err.message}) — falling back to files`);
    cachedEnvRaw = raw;
    cachedEnvPrograms = null;
    return null;
  }

  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.programs) ? parsed.programs : null;
  if (!list) {
    log.warn("programs", "PIXIE_PROGRAMS_JSON must be an array or { programs: [...] } — falling back to files");
    cachedEnvRaw = raw;
    cachedEnvPrograms = null;
    return null;
  }

  // An id is what forChannel/get/posture all key off, so a record without one
  // is unaddressable rather than merely incomplete.
  const usable = list.filter((p) => p && typeof p.id === "string" && p.id.trim());
  if (usable.length !== list.length) {
    log.warn("programs", `ignored ${list.length - usable.length} program(s) in PIXIE_PROGRAMS_JSON with no id`);
  }

  cachedEnvRaw = raw;
  cachedEnvPrograms = usable.length > 0 ? usable.map(normalizeProgram) : null;
  return cachedEnvPrograms;
}

function legacyFallbackProgram() {
  const sources = readSourcesJson();
  const milestones = readProgramJsonMilestones();
  const helpChannel = config?.slack?.helpChannel || null;
  const faqChannels = config?.slack?.faqChannels || [];
  const channels = helpChannel && !faqChannels.includes(helpChannel)
    ? [helpChannel, ...faqChannels]
    : faqChannels;

  return {
    id: "pixl",
    name: "Pixl",
    posture: "active",
    scope: process.env.PIXIE_SCOPE === "any" ? "any" : "program",
    helpChannel,
    channels,
    helperGroup: null,
    sources,
    milestones,
    guides: ["submit-ysws-guidelines"],
    links: {},
  };
}

function loadFilePrograms() {
  const fileData = readJsonFile(PROGRAMS_FILE, null);
  if (!Array.isArray(fileData) || fileData.length === 0) {
    return null;
  }
  return fileData.map(normalizeProgram);
}

// Where a program record comes from, most specific first: the variable a
// wizard-provisioned bot is deployed with, then the repo's own programs.json,
// then the single-program legacy shape assembled from SLACK_* vars.
//
// The env blob wins outright rather than merging with the file — a fleet bot must
// never inherit the image's programs.json, which holds whichever program the
// image was last built for.
function loadConfiguredPrograms() {
  return loadEnvPrograms() || loadFilePrograms();
}

function mergeSources(configured, persisted) {
  const merged = [];
  const seen = new Set();
  for (const source of [...(configured || []), ...(persisted || [])]) {
    if (!source?.name) continue;
    const key = JSON.stringify([source.name, source.type || null, source.url || null, source.content || null]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

function all() {
  if (cachedPrograms) return cachedPrograms;

  const fileProgs = loadConfiguredPrograms();
  let dbProgs = [];
  try {
    dbProgs = db.getDbPrograms();
  } catch (e) {
    log.warn("programs", `db program load failed: ${e.message}`);
    dbProgs = [];
  }

  if ((!fileProgs || fileProgs.length === 0) && dbProgs.length === 0) {
    cachedPrograms = [legacyFallbackProgram()];
    return cachedPrograms;
  }

  const map = new Map();
  if (fileProgs) {
    for (const p of fileProgs) {
      map.set(p.id, p);
    }
  }
  for (const p of dbProgs) {
    const configured = map.get(p.id);
    map.set(p.id, configured ? {
      ...configured,
      ...p,
      sources: mergeSources(configured.sources, p.sources),
      milestones: p.milestones || configured.milestones || [],
      guides: p.guides || configured.guides || [],
      links: p.links || configured.links || {},
      pinnedRules: p.pinnedRules || configured.pinnedRules || [],
      // Null DB value must not erase file rules.
      categories: p.categories || configured.categories || null,
      channels: p.channels?.length ? p.channels : configured.channels || [],
      helpChannel: p.helpChannel || configured.helpChannel || null,
      organizerChannel: p.organizerChannel || configured.organizerChannel || null,
      behavior: p.behavior || configured.behavior || null,
      status: p.status || configured.status || null,
    } : p);
  }

  cachedPrograms = Array.from(map.values());
  return cachedPrograms;
}

function invalidate() {
  cachedPrograms = null;
  cachedEnvRaw = null;
  cachedEnvPrograms = null;
}

// The cross-program corpus every channel gets on top of its own program's docs:
// the YSWS submission rules, the shared quick links.
//
// Its sources default to the repo's sources.json, which holds Pixl's quick links
// — right for the Pixl deployment, wrong for every fleet bot, where they would
// show up as a second source nobody asked for and answer Pixl questions in
// Solvable's channel.
//
// So once PIXIE_PROGRAMS_JSON is set, the file is not consulted at all: a bot gets
// the shared layer it asked for via a `ysws-global` entry, or an empty one. Scope
// is forced to "any" either way — the shared program is the fallback for channels
// no program claims, and scoping it would make it answer nothing.
function emptyShared() {
  return {
    id: SHARED_PROGRAM_ID,
    name: "YSWS Global",
    posture: "active",
    scope: "any",
    helpChannel: null,
    channels: [],
    helperGroup: null,
    sources: [],
    milestones: [],
    guides: ["submit-ysws-guidelines"],
    links: {},
  };
}

function shared() {
  const envProgs = loadEnvPrograms();
  if (envProgs) {
    const fromEnv = envProgs.find((p) => p.id === SHARED_PROGRAM_ID);
    return fromEnv ? { ...fromEnv, scope: "any" } : emptyShared();
  }

  return {
    ...emptyShared(),
    sources: readSourcesJson(),
    milestones: readProgramJsonMilestones(),
  };
}

function get(id) {
  if (!id || id === SHARED_PROGRAM_ID) return shared();
  return all().find((p) => p.id === id) || null;
}

// Hosted claims live in SQLite and win over every config list. Workspace-
// scoped so two workspaces sharing a channel ID shape never cross-resolve.
// Never throws: a registry hiccup must degrade to config lists, not 500.
function hostedClaim(workspaceId, channelId) {
  try {
    return db.getChannelOwner(workspaceId || DEFAULT_WORKSPACE, channelId) || null;
  } catch (e) {
    log.debug("programs", `claim lookup failed (${channelId}): ${e.message}`);
    return null;
  }
}

function claimedProgram(claim) {
  if (!claim || !claim.program_id) return null;
  return get(claim.program_id) || null;
}

// A program serves a channel when the workspace matches (or the program is
// workspace-agnostic) and the channel is its help channel or a listed one.
function servesChannel(program, channelId, workspaceId) {
  if (workspaceId && program.workspaceId && program.workspaceId !== workspaceId) return false;
  return program.helpChannel === channelId || (program.channels && program.channels.includes(channelId));
}

function forChannel(channelId, workspaceId = null) {
  if (!channelId) return shared();

  const claimed = claimedProgram(hostedClaim(workspaceId, channelId));
  if (claimed) return claimed;

  const progs = all();
  const match = progs.find((p) => servesChannel(p, channelId, workspaceId));
  if (match) return match;

  if (config?.slack?.helpChannel && channelId === config.slack.helpChannel) {
    const helpProg = progs.find((p) => p.helpChannel === config.slack.helpChannel);
    if (helpProg) return helpProg;
  }

  return shared();
}

function isHelpChannel(channelId, workspaceId = null) {
  if (!channelId) return false;
  // A workspace-scoped claim is authoritative for that workspace: a discussion
  // claim here means "not the help channel" even if some config list says so.
  if (workspaceId) {
    const claim = hostedClaim(workspaceId, channelId);
    if (claim) return claim.kind === "help";
  }
  const progs = all();
  if (progs.some((p) => p.helpChannel === channelId)) return true;
  if (config?.slack?.helpChannel && channelId === config.slack.helpChannel) return true;
  return false;
}

function helpChannelName(programId = null) {
  const p = programId ? get(programId) : (all()[0] || null);
  if (p && p.helpChannel) return p.helpChannel;
  if (config?.slack?.helpChannel) return config.slack.helpChannel;
  return null;
}

function posture(programId) {
  const p = get(programId);
  return p ? (p.posture || "active") : "active";
}

function deploymentMode(programId) {
  const p = get(programId);
  return p ? (p.deploymentMode || "dedicated_legacy") : "dedicated_legacy";
}

function isShadow(program) {
  const p = typeof program === "string" ? get(program) : program;
  return !!p && p.shadowMode === true;
}

function isSupportActive(programId) {
  const p = get(programId);
  // Unknown programs default to active: direct program objects passed by
  // callers (tests, legacy paths) bypass the registry, and refusing them
  // would silently disable support. Only an explicit false disables.
  if (!p) return true;
  return p.supportActive !== false;
}

function ticketsEnabled(programId) {
  const p = get(programId);
  if (!p) return true;
  return p.ticketsEnabled !== false;
}

function aiAnswersEnabled(programId) {
  const p = get(programId);
  if (!p) return true;
  return p.aiAnswers !== false;
}

// What pixie will answer when nobody addressed her.
//
//   "any"     — anything someone is stuck on: the program, their code, git,
//               hackatime, whatever. The original behaviour.
//   "program" — only questions about this program. Everything else is left to
//               the humans in the channel.
//
// Either way, being pinged or DM'd bypasses this entirely — if someone asks
// her directly, she answers.
function scope(programId) {
  const p = get(programId);
  return p && p.scope === "program" ? "program" : "any";
}

function isProgramScoped(program) {
  if (!program) return false;
  if (typeof program === "string") return scope(program) === "program";
  return program.scope === "program";
}

function saveProgram(prog) {
  db.saveProgram(prog);
  invalidate();
}

function removeProgram(id) {
  db.deleteProgram(id);
  invalidate();
}

// One row shape for every channel source below — program registry entries and
// legacy SLACK_* fallbacks alike — so callers never branch on where a row came
// from.
function channelRow(channelId, { programId, programName, isHelp, posture = "active" }) {
  return {
    channelId,
    programId,
    programName,
    isHelpChannel: isHelp,
    isTicketDestination: isHelp,
    posture,
    replyEnabled: posture !== "muted",
    type: isHelp ? "help" : "discussion",
  };
}

function getChannelsList() {
  const progs = all();
  const channelsMap = new Map();

  for (const p of progs) {
    if (p.helpChannel) {
      channelsMap.set(
        p.helpChannel,
        channelRow(p.helpChannel, { programId: p.id, programName: p.name, isHelp: true, posture: p.posture || "active" }),
      );
    }
    if (Array.isArray(p.channels)) {
      for (const ch of p.channels) {
        if (!channelsMap.has(ch)) {
          channelsMap.set(
            ch,
            channelRow(ch, {
              programId: p.id,
              programName: p.name,
              isHelp: ch === p.helpChannel,
              posture: p.posture || "active",
            }),
          );
        }
      }
    }
  }

  if (config?.slack?.helpChannel && !channelsMap.has(config.slack.helpChannel)) {
    channelsMap.set(
      config.slack.helpChannel,
      channelRow(config.slack.helpChannel, { programId: "pixl", programName: "Pixl", isHelp: true }),
    );
  }

  if (Array.isArray(config?.slack?.faqChannels)) {
    for (const ch of config.slack.faqChannels) {
      if (!channelsMap.has(ch)) {
        channelsMap.set(
          ch,
          channelRow(ch, {
            programId: "pixl",
            programName: "Pixl",
            isHelp: ch === config?.slack?.helpChannel,
          }),
        );
      }
    }
  }

  return Array.from(channelsMap.values());
}

// Pure set-add: channel membership edits across add/remove/set-destination all
// funnel through one shape instead of three inline Set dances.
function withChannel(channels, channelId) {
  return Array.from(new Set([...(Array.isArray(channels) ? channels : []), channelId]));
}

// Refuse to silently steal a channel another program claimed. Hosted claims
// are authoritative; the caller decides how to surface the conflict.
function stolenByAnother(programId, workspaceId, channelId) {
  if (!workspaceId) return false;
  const owner = hostedClaim(workspaceId, channelId);
  return !!owner && owner.program_id !== programId;
}

function persistChannels(program, channels, helpChannel) {
  saveProgram({ ...program, channels, helpChannel });
}

function addChannelToProgram(programId, channelId, isHelp = false, workspaceId = null) {
  const p = get(programId) || (all()[0] || null);
  if (!p) return false;
  if (stolenByAnother(p.id, workspaceId, channelId)) return false;

  persistChannels(p, withChannel(p.channels, channelId), isHelp ? channelId : p.helpChannel);
  if (workspaceId) {
    try {
      db.claimProgramChannel({ workspaceId, channelId, programId: p.id, kind: isHelp ? "help" : "discussion" });
    } catch (e) {
      log.warn("programs", `channel claim failed (${channelId}): ${e.message}`);
    }
  }
  return true;
}

function removeChannelFromProgram(programId, channelId) {
  const p = get(programId);
  if (!p) return false;

  persistChannels(
    p,
    (Array.isArray(p.channels) ? p.channels : []).filter((c) => c !== channelId),
    p.helpChannel === channelId ? null : p.helpChannel,
  );
  return true;
}

function setChannelTicketDestination(programId, channelId) {
  const p = get(programId);
  if (!p) return false;

  persistChannels(p, withChannel(p.channels, channelId), channelId);
  return true;
}

module.exports = {
  all,
  get,
  shared,
  forChannel,
  isHelpChannel,
  helpChannelName,
  posture,
  deploymentMode,
  isShadow,
  isSupportActive,
  ticketsEnabled,
  aiAnswersEnabled,
  scope,
  isProgramScoped,
  saveProgram,
  removeProgram,
  getChannelsList,
  addChannelToProgram,
  removeChannelFromProgram,
  setChannelTicketDestination,
  invalidate,
};
