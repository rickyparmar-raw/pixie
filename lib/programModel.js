// The one program-behavior model. Every "should Pixie do X in this channel"
// question reads a program's `behavior.main` or `behavior.help` settings from
// here — not env flags, not hardcoded program ids.
//
// Settings persist as one JSON column (programs.behavior). A program that has
// never saved behavior gets it derived from its legacy flags (ticketsEnabled,
// helperPing, aiAnswers, autoEscalate, posture, supportActive), so migrating
// an existing program changes nothing it already does. The only deliberate
// exception is main-channel ambient replies, which the legacy pipeline never
// actually delivered (eligibility silenced them before any classifier ran):
// they default ON, as the product spec requires.

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
});

const MAIN_KEYS = Object.keys(MAIN_DEFAULTS);
const HELP_KEYS = Object.keys(HELP_DEFAULTS);

function bool(value, fallback) {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

// Legacy flags → behavior. Only used for keys the stored behavior omits.
function legacyMain(p) {
  const posture = p.posture || "active";
  return {
    enabled: posture !== "muted" && p.supportActive !== false,
    // A passive program answered its name but never chatted off-topic.
    generalMentionChat: posture !== "passive",
  };
}

function legacyHelp(p) {
  const posture = p.posture || "active";
  return {
    enabled: posture !== "muted" && p.supportActive !== false,
    aiReplies: p.aiAnswers !== false,
    ticketsEnabled: p.ticketsEnabled !== false,
    escalateUnknown: p.autoEscalate !== false,
    // helperPing was opt-in (default off) in the legacy model.
    helperPings: p.helperPing === true,
  };
}

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) if (Object.hasOwn(obj, k)) out[k] = obj[k];
  return out;
}

function resolveSection(defaults, legacy, stored, keys) {
  const out = {};
  for (const k of keys) {
    const fromStored = stored && Object.hasOwn(stored, k) ? bool(stored[k], undefined) : undefined;
    const fromLegacy = legacy && Object.hasOwn(legacy, k) ? legacy[k] : undefined;
    out[k] = fromStored !== undefined ? fromStored : fromLegacy !== undefined ? fromLegacy : defaults[k];
  }
  return Object.freeze(out);
}

function parseStoredBehavior(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Full behavior for a program record (file, env, or DB shape).
function behaviorFor(p = {}) {
  const stored = parseStoredBehavior(p.behavior);
  return Object.freeze({
    main: resolveSection(MAIN_DEFAULTS, legacyMain(p), pick(stored?.main, MAIN_KEYS), MAIN_KEYS),
    help: resolveSection(HELP_DEFAULTS, legacyHelp(p), pick(stored?.help, HELP_KEYS), HELP_KEYS),
  });
}

function statusFor(p = {}) {
  if (STATUSES.includes(p.status)) return p.status;
  if (p.posture === "muted") return "paused";
  return "live";
}

// Only known keys with boolean values survive; used by every write path
// (dashboard sync, API) so unknown or malformed input never reaches storage.
function sanitizeBehaviorPatch(patch) {
  const src = parseStoredBehavior(patch) || {};
  const out = {};
  for (const [section, keys] of [["main", MAIN_KEYS], ["help", HELP_KEYS]]) {
    if (!src[section] || typeof src[section] !== "object") continue;
    const clean = {};
    for (const k of keys) {
      const v = bool(src[section][k], undefined);
      if (v !== undefined) clean[k] = v;
    }
    if (Object.keys(clean).length) out[section] = clean;
  }
  return out;
}

function mergeBehavior(existing, patch) {
  const base = parseStoredBehavior(existing) || {};
  const clean = sanitizeBehaviorPatch(patch);
  return {
    main: { ...(base.main || {}), ...(clean.main || {}) },
    help: { ...(base.help || {}), ...(clean.help || {}) },
  };
}

// Channel-role validation. A channel may belong to exactly one program in
// exactly one role. Conflicts are configuration errors, never resolved by
// load order.
//
// `programs`   normalized program records
// `legacyHelp` SLACK_HELP_CHANNEL (single-program legacy env)
// `legacyMain` SLACK_FAQ_CHANNELS
// `claims`     hosted channel claims [{ workspace_id, channel_id, program_id, kind }]
function validateChannelRoles({ programs = [], legacyHelp = null, legacyMain = [], claims = [] } = {}) {
  const errors = [];
  const owners = new Map(); // key -> { programId, role }
  const key = (ws, ch) => `${ws || "*"}::${ch}`;

  function assign(ws, channelId, programId, role, origin) {
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
    for (const ch of p.channels || []) {
      if (ch === p.helpChannel) continue;
      assign(ws, ch, p.id, "main", "program.channels");
    }
  }

  // Legacy env only names roles, never programs; it conflicts when it gives a
  // channel a different role than the program config does.
  const roleOf = (ch) => {
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

  // Hosted claims are authoritative for their workspace; they conflict when a
  // config file gives the same channel another program or another role.
  for (const c of claims || []) {
    if (!c || !c.channel_id) continue;
    const role = c.kind === "help" ? "help" : "main";
    const k = key(c.workspace_id, c.channel_id);
    const star = key(null, c.channel_id);
    const prev = owners.get(k) || owners.get(star);
    if (prev && (prev.programId !== c.program_id || prev.role !== role)) {
      errors.push({
        channelId: c.channel_id,
        message: `hosted claim makes ${c.channel_id} ${role} of ${c.program_id}, but config makes it ${prev.role} of ${prev.programId}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
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
