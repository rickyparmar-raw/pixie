

type UntypedInput = any;
const STATUSES = ["sandbox", "live", "paused"];

const MAIN_DEFAULTS = Object.freeze({
  enabled: true,
  ambientProgramReplies: true,
  mentionReplies: true,
  generalMentionChat: true,
  commandsEnabled: true,
  ticketsEnabled: false,
  helperEscalationEnabled: false,
});

const HELP_DEFAULTS = Object.freeze({
  enabled: true,
  aiReplies: true,
  ticketsEnabled: true,
  autoCreateTickets: true,
  escalateUnknown: true,
  helperPings: true,
  expertiseRouting: true,
  autoResolve: true,
});

const MAIN_KEYS = Object.keys(MAIN_DEFAULTS);
const HELP_KEYS = Object.keys(HELP_DEFAULTS);

function bool(value: UntypedInput, fallback: UntypedInput) {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return fallback;
}


function legacyMain(p: UntypedInput) {
  const posture = p.posture || "active";
  return {
    enabled: posture !== "muted" && p.supportActive !== false,

    generalMentionChat: posture !== "passive",
  };
}

function legacyHelp(p: UntypedInput) {
  const posture = p.posture || "active";
  return {
    enabled: posture !== "muted" && p.supportActive !== false,
    aiReplies: p.aiAnswers !== false,
    ticketsEnabled: p.ticketsEnabled !== false,
    escalateUnknown: p.autoEscalate !== false,

    helperPings: p.helperPing === true,
  };
}

function pick(obj: UntypedInput, keys: string[]): Record<string, UntypedInput> {
  const out: Record<string, UntypedInput> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) if (Object.hasOwn(obj, k)) out[k] = obj[k];
  return out;
}

function resolveSection(defaults: Record<string, UntypedInput>, legacy: Record<string, UntypedInput>, stored: Record<string, UntypedInput> | null, keys: string[]): Record<string, UntypedInput> {
  const out: Record<string, UntypedInput> = {};
  for (const k of keys) {
    const fromStored = stored && Object.hasOwn(stored, k) ? bool(stored[k], undefined) : undefined;
    const fromLegacy = legacy && Object.hasOwn(legacy, k) ? legacy[k] : undefined;
    out[k] = fromStored !== undefined ? fromStored : fromLegacy !== undefined ? fromLegacy : defaults[k];
  }
  return Object.freeze(out);
}

function parseStoredBehavior(raw: UntypedInput) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_: UntypedInput) {
    return null;
  }
}


function behaviorFor(p: Record<string, UntypedInput> = {}) {
  const stored = parseStoredBehavior(p.behavior);
  return Object.freeze({
    main: resolveSection(MAIN_DEFAULTS, legacyMain(p), pick(stored?.main, MAIN_KEYS), MAIN_KEYS),
    help: resolveSection(HELP_DEFAULTS, legacyHelp(p), pick(stored?.help, HELP_KEYS), HELP_KEYS),
  });
}

function statusFor(p: Record<string, UntypedInput> = {}) {
  if (STATUSES.includes(p.status)) return p.status;
  if (p.posture === "muted") return "paused";
  return "live";
}


function sanitizeBehaviorPatch(patch: UntypedInput) {
  const src = parseStoredBehavior(patch) || {};
  const out: Record<string, UntypedInput> = {};
  const sections: Array<[string, string[]]> = [["main", MAIN_KEYS], ["help", HELP_KEYS]];
  for (const [section, keys] of sections) {
    if (!src[section] || typeof src[section] !== "object") continue;
    const clean: Record<string, UntypedInput> = {};
    for (const k of keys) {
      const v = bool(src[section][k], undefined);
      if (v !== undefined) clean[k] = v;
    }
    if (Object.keys(clean).length) out[section] = clean;
  }
  return out;
}

function mergeBehavior(existing: UntypedInput, patch: UntypedInput) {
  const base = parseStoredBehavior(existing) || {};
  const clean = sanitizeBehaviorPatch(patch);
  return {
    main: { ...(base.main || {}), ...(clean.main || {}) },
    help: { ...(base.help || {}), ...(clean.help || {}) },
  };
}


function validateChannelRoles({ programs = [], legacyHelp = null, legacyMain = [], claims = [] }: Record<string, UntypedInput> = {}) {
  const errors = [];
  const owners = new Map();
  const key = (ws: UntypedInput, ch: UntypedInput) => `${ws || "*"}::${ch}`;

  function assign(ws: UntypedInput, channelId: UntypedInput, programId: UntypedInput, role: UntypedInput, origin: UntypedInput) {
    if (!channelId) return;
    const k = key(ws, channelId);
    const star = key(null, channelId);
    for (const probe of new Set([k, star])) {
      const prev = owners.get(probe);
      if (prev && (prev.programId !== programId || prev.role !== role)) {
        errors.push({
          channelId,
          message: `channel ${channelId} resolves as ${prev.role} of ${prev.programId} (${prev.origin}) and as ${role} of ${programId} (${origin})`,
        });
        return;
      }
    }
    owners.set(k, { programId, role, origin });
  }

  for (const p of programs) {
    if (!p || !p.id || p.id === "ysws-global") continue;
    const ws = p.workspaceId || null;
    if (p.helpChannel) assign(ws, p.helpChannel, p.id, "help", "program.helpChannel");
    if (p.organizerChannel && p.organizerChannel !== p.helpChannel) assign(ws, p.organizerChannel, p.id, "organizer", "program.organizerChannel");
    for (const ch of p.channels || []) {
      if (ch === p.helpChannel || ch === p.organizerChannel) continue;
      assign(ws, ch, p.id, "main", "program.channels");
    }
  }

  const roleOf = (ch: UntypedInput) => {
    for (const [k, v] of owners) if (k.endsWith(`::${ch}`)) return v;
    return null;
  };
  if (legacyHelp) {
    const owner = roleOf(legacyHelp);
    if (owner && owner.role !== "help") {
      errors.push({ channelId: legacyHelp, message: `SLACK_HELP_CHANNEL ${legacyHelp} is configured as ${owner.role} of ${owner.programId}` });
    }
  }
  for (const ch of legacyMain || []) {
    const owner = roleOf(ch);
    if (owner && owner.role !== "main") {
      errors.push({ channelId: ch, message: `SLACK_FAQ_CHANNELS entry ${ch} is configured as ${owner.role} of ${owner.programId}` });
    }
    if (legacyHelp && ch === legacyHelp) {
      errors.push({ channelId: ch, message: `${ch} is in both SLACK_HELP_CHANNEL and SLACK_FAQ_CHANNELS` });
    }
  }

  for (const c of claims || []) {
    if (!c || !c.channel_id) continue;
    const role = c.kind === "help" ? "help" : c.kind === "organizer" ? "organizer" : "main";
    const k = key(c.workspace_id, c.channel_id);
    const star = key(null, c.channel_id);
    const prev = owners.get(k) || owners.get(star);
    const sameProgramOrganizer = prev && prev.programId === c.program_id && role === "organizer" && prev.role === "main";
    if (prev && !sameProgramOrganizer && (prev.programId !== c.program_id || prev.role !== role)) {
      errors.push({
        channelId: c.channel_id,
        message: `hosted claim makes ${c.channel_id} ${role} of ${c.program_id}, but config makes it ${prev.role} of ${prev.programId}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export = {
  STATUSES,
  MAIN_DEFAULTS,
  HELP_DEFAULTS,
  MAIN_KEYS,
  HELP_KEYS,
  behaviorFor,
  statusFor,
  sanitizeBehaviorPatch,
  mergeBehavior,
  parseStoredBehavior,
  validateChannelRoles,
};
