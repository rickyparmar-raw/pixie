const fs = require("fs");
const path = require("path");
const { config } = require("./config");
const db = require("./db");

const PROGRAMS_FILE = path.join(__dirname, "..", "programs.json");
const SOURCES_FILE = path.join(__dirname, "..", "sources.json");
const PROGRAM_FILE = path.join(__dirname, "..", "program.json");

let cachedPrograms = null;

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
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
    scope: process.env.PIXIE_SCOPE === "program" ? "program" : "any",
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
  return fileData.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    posture: p.posture || "active",
    scope: p.scope === "program" ? "program" : "any",
    helpChannel: p.helpChannel || null,
    channels: Array.isArray(p.channels) ? p.channels : [],
    helperGroup: p.helperGroup || null,
    sources: Array.isArray(p.sources) ? p.sources : [],
    milestones: Array.isArray(p.milestones) ? p.milestones : [],
    guides: Array.isArray(p.guides) ? p.guides : ["submit-ysws-guidelines"],
    links: p.links || {},
  }));
}

function all() {
  if (cachedPrograms) return cachedPrograms;

  const fileProgs = loadFilePrograms();
  let dbProgs = [];
  try {
    dbProgs = db.getDbPrograms();
  } catch (_) {
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
    map.set(p.id, p);
  }

  cachedPrograms = Array.from(map.values());
  return cachedPrograms;
}

function invalidate() {
  cachedPrograms = null;
}

function shared() {
  return {
    id: "ysws-global",
    name: "YSWS Global",
    posture: "active",
    scope: "any",
    helpChannel: null,
    channels: [],
    helperGroup: null,
    sources: readSourcesJson(),
    milestones: readProgramJsonMilestones(),
    guides: ["submit-ysws-guidelines"],
    links: {},
  };
}

function get(id) {
  if (!id || id === "ysws-global") return shared();
  return all().find((p) => p.id === id) || null;
}

function forChannel(channelId) {
  if (!channelId) return shared();

  const progs = all();
  for (const p of progs) {
    if (p.helpChannel === channelId || (p.channels && p.channels.includes(channelId))) {
      return p;
    }
  }

  if (config?.slack?.helpChannel && channelId === config.slack.helpChannel) {
    const helpProg = progs.find((p) => p.helpChannel === config.slack.helpChannel);
    if (helpProg) return helpProg;
  }

  return shared();
}

function isHelpChannel(channelId) {
  if (!channelId) return false;
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

module.exports = {
  all,
  get,
  shared,
  forChannel,
  isHelpChannel,
  helpChannelName,
  posture,
  scope,
  isProgramScoped,
  saveProgram,
  removeProgram,
  invalidate,
};
