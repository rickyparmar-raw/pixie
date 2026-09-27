import fs = require("node:fs");
import path = require("node:path");
import configModule = require("./config");
import db = require("./db");
import log = require("./log");
import ticketCategory = require("./ticketCategory");

type UntypedInput = any;
const { config } = configModule;

const PROGRAMS_FILE = path.join(__dirname, "..", "programs.json");
const SOURCES_FILE = path.join(__dirname, "..", "sources.json");
const PROGRAM_FILE = path.join(__dirname, "..", "program.json");


const DEFAULT_WORKSPACE = "default";
const SHARED_PROGRAM_ID = "ysws-global";

let cachedPrograms: UntypedInput = null;

let cachedEnvRaw: string | null = null;
let cachedEnvPrograms: UntypedInput = null;

function readJsonFile(filePath: UntypedInput, fallback: UntypedInput = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e: UntypedInput) {
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

function alt(p: UntypedInput, ...keys: string[]) {
  for (const k of keys) {
    if (p[k]) return p[k];
  }
  return undefined;
}

function normalizeProgram(p: UntypedInput) {
  const ticketsEnabled = p.ticketsEnabled === false ? false : true;
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
    ticketsEnabled,
    autoEscalate: p.autoEscalate === false ? false : true,
    sensitiveCategories: Array.isArray(p.sensitiveCategories || p.sensitive_categories) ? (p.sensitiveCategories || p.sensitive_categories) : [],
    supportActive: p.supportActive === false ? false : true,
    autoAssign: p.autoAssign === true || p.auto_assign === 1,
    helperPing: p.helperPing === true || p.helper_ping_enabled === 1,
    categories: p.categories && typeof p.categories === "object"
      ? p.categories
      : (ticketsEnabled ? ticketCategory.defaultTaxonomy() : null),
    learning: p.learning === "review" || p.learning_mode === "review" ? "review" : "auto",
    ticketVisibility: ["thread", "organizer", "dashboard"].includes(p.ticketVisibility || p.ticket_visibility)
      ? (p.ticketVisibility || p.ticket_visibility)
      : "thread",
    shadowMode: p.shadowMode === true || p.shadow_mode === 1,
    incidentMode: alt(p, "incidentMode", "incident_mode") || "ANSWER_AND_TRACK",
    publicTicketsEnabled: p.publicTicketsEnabled === false || p.public_tickets_enabled === 0 ? false : true,
    helpChannel: alt(p, "helpChannel", "help_channel") || null,
    organizerChannel: alt(p, "organizerChannel", "organizer_channel", "organizer_channel_id", "helperChannel") || null,
    channels: Array.isArray(p.channels) ? p.channels : [],
    helperGroup: alt(p, "helperGroup", "helper_group") || null,
    sources: Array.isArray(p.sources) ? p.sources : [],
    sharedSources: p.id === "ysws-global" ? true : false,
    milestones: Array.isArray(p.milestones) ? p.milestones : [],
    guides: Array.isArray(p.guides) ? p.guides : ["submit-ysws-guidelines"],
    pinnedRules: Array.isArray(p.pinnedRules) ? p.pinnedRules.filter((r: UntypedInput) => typeof r === "string" && r.trim()) : [],
    links: p.links || {},
    behavior: p.behavior && typeof p.behavior === "object" ? p.behavior : null,
    status: ["sandbox", "live", "paused"].includes(p.status) ? p.status : null,
  };
}

function loadEnvPrograms() {
  const raw = (process.env.PIXIE_PROGRAMS_JSON || "").trim();
  if (!raw) return null;
  if (cachedEnvRaw === raw) return cachedEnvPrograms;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err: UntypedInput) {
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

  const usable = list.filter((p: UntypedInput) => p && typeof p.id === "string" && p.id.trim());
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

function loadConfiguredPrograms() {
  return loadEnvPrograms() || loadFilePrograms();
}

function mergeSources(configured: UntypedInput, persisted: UntypedInput) {
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
  let dbProgs: ReturnType<typeof db.getDbPrograms> = [];
  try {
    dbProgs = db.getDbPrograms();
  } catch (e: UntypedInput) {
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
      categories: p.categories || configured.categories || (p.ticketsEnabled !== false ? ticketCategory.defaultTaxonomy() : null),
      learning: p.learning || configured.learning || "auto",
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
    const fromEnv = envProgs.find((p: UntypedInput) => p.id === SHARED_PROGRAM_ID);
    return fromEnv ? { ...fromEnv, scope: "any" } : emptyShared();
  }

  return {
    ...emptyShared(),
    sources: readSourcesJson(),
    milestones: readProgramJsonMilestones(),
  };
}

function get(id: UntypedInput) {
  if (!id || id === SHARED_PROGRAM_ID) return shared();
  return all().find((p: UntypedInput) => p.id === id) || null;
}

function hostedClaim(workspaceId: UntypedInput, channelId: UntypedInput) {
  try {
    return db.getChannelOwner(workspaceId || DEFAULT_WORKSPACE, channelId) || null;
  } catch (e: UntypedInput) {
    log.debug("programs", `claim lookup failed (${channelId}): ${e.message}`);
    return null;
  }
}

function claimedProgram(claim: UntypedInput) {
  if (!claim || !claim.program_id) return null;
  return get(claim.program_id) || null;
}

function servesChannel(program: UntypedInput, channelId: UntypedInput, workspaceId: UntypedInput) {
  if (workspaceId && program.workspaceId && program.workspaceId !== workspaceId) return false;
  return program.helpChannel === channelId || (program.channels && program.channels.includes(channelId));
}

function forChannel(channelId: UntypedInput, workspaceId: string | null = null) {
  if (!channelId) return shared();

  const claimed = claimedProgram(hostedClaim(workspaceId, channelId));
  if (claimed) return claimed;

  const progs = all();
  const match = progs.find((p: UntypedInput) => servesChannel(p, channelId, workspaceId));
  if (match) return match;

  if (config?.slack?.helpChannel && channelId === config.slack.helpChannel) {
    const helpProg = progs.find((p: UntypedInput) => p.helpChannel === config.slack.helpChannel);
    if (helpProg) return helpProg;
  }

  return shared();
}

function isHelpChannel(channelId: UntypedInput, workspaceId: string | null = null) {
  if (!channelId) return false;
  if (workspaceId) {
    const claim = hostedClaim(workspaceId, channelId);
    if (claim) return claim.kind === "help";
  }
  const progs = all();
  if (progs.some((p: UntypedInput) => p.helpChannel === channelId)) return true;
  if (config?.slack?.helpChannel && channelId === config.slack.helpChannel) return true;
  return false;
}

function helpChannelName(programId = null) {
  const p = programId ? get(programId) : (all()[0] || null);
  if (p && p.helpChannel) return p.helpChannel;
  if (config?.slack?.helpChannel) return config.slack.helpChannel;
  return null;
}

function posture(programId: UntypedInput) {
  const p = get(programId);
  return p ? (p.posture || "active") : "active";
}

function deploymentMode(programId: UntypedInput) {
  const p = get(programId);
  return p ? (p.deploymentMode || "dedicated_legacy") : "dedicated_legacy";
}

function isShadow(program: UntypedInput) {
  const p = typeof program === "string" ? get(program) : program;
  return !!p && p.shadowMode === true;
}

function isSupportActive(programId: UntypedInput) {
  const p = get(programId);
  if (!p) return true;
  return p.supportActive !== false;
}

function ticketsEnabled(programId: UntypedInput) {
  const p = get(programId);
  if (!p) return true;
  return p.ticketsEnabled !== false;
}

function aiAnswersEnabled(programId: UntypedInput) {
  const p = get(programId);
  if (!p) return true;
  return p.aiAnswers !== false;
}

function scope(programId: UntypedInput) {
  const p = get(programId);
  return p && p.scope === "program" ? "program" : "any";
}

function isProgramScoped(program: UntypedInput) {
  if (!program) return false;
  if (typeof program === "string") return scope(program) === "program";
  return program.scope === "program";
}

function saveProgram(prog: UntypedInput) {
  db.saveProgram(prog);
  invalidate();
}

function removeProgram(id: UntypedInput) {
  db.deleteProgram(id);
  invalidate();
}

function channelRow(channelId: UntypedInput, { programId, programName, isHelp, posture = "active" }: Record<string, UntypedInput>) {
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

function withChannel(channels: UntypedInput, channelId: UntypedInput) {
  return Array.from(new Set([...(Array.isArray(channels) ? channels : []), channelId]));
}

function stolenByAnother(programId: UntypedInput, workspaceId: UntypedInput, channelId: UntypedInput) {
  if (!workspaceId) return false;
  const owner = hostedClaim(workspaceId, channelId);
  return !!owner && owner.program_id !== programId;
}

function persistChannels(program: UntypedInput, channels: UntypedInput, helpChannel: UntypedInput) {
  saveProgram({ ...program, channels, helpChannel });
}

function addChannelToProgram(programId: UntypedInput, channelId: UntypedInput, isHelp = false, workspaceId = null) {
  const p = get(programId) || (all()[0] || null);
  if (!p) return false;
  if (stolenByAnother(p.id, workspaceId, channelId)) return false;

  persistChannels(p, withChannel(p.channels, channelId), isHelp ? channelId : p.helpChannel);
  if (workspaceId) {
    try {
      db.claimProgramChannel({ workspaceId, channelId, programId: p.id, kind: isHelp ? "help" : "discussion" });
    } catch (e: UntypedInput) {
      log.warn("programs", `channel claim failed (${channelId}): ${e.message}`);
    }
  }
  return true;
}

function removeChannelFromProgram(programId: UntypedInput, channelId: UntypedInput) {
  const p = get(programId);
  if (!p) return false;

  persistChannels(
    p,
    (Array.isArray(p.channels) ? p.channels : []).filter((c: UntypedInput) => c !== channelId),
    p.helpChannel === channelId ? null : p.helpChannel,
  );
  return true;
}

function setChannelTicketDestination(programId: UntypedInput, channelId: UntypedInput) {
  const p = get(programId);
  if (!p) return false;

  persistChannels(p, withChannel(p.channels, channelId), channelId);
  return true;
}

export = {
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
