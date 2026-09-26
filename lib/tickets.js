const db = require("./db");
const reply = require("./reply");
const log = require("./log");
const slackMessages = require("./slackMessages");
const { config, isAdmin } = require("./config");
const programs = require("./programs");
const audit = require("./audit");
const helperRoute = require("./helperRoute");
const incidents = require("./incidents");
const assignmentLifecycle = require("./assignmentLifecycle");
const ticketCategory = require("./ticketCategory");
const resolutionPipeline = require("./resolutionPipeline");
const { ticketPolicy, resolveTicketRole } = require("./tickets/policy");

const CLAIMABLE = ["open", "waiting_for_helper", "reopened"];
const WORKABLE = ["claimed", "assigned"];
const CLOSED = ["resolved", "closed"];
const renderedTicketUI = new WeakMap();
const reconcilingTicketUI = new WeakMap();

// The requester-facing ticket in the help thread. Namespaced so it can't
// collide with the organizer-card actions, and stable so a button that has
// been sitting in a thread for a week still routes.
const SUPPORT_RESOLVE_ACTION = "st_resolve";
const SUPPORT_REOPEN_ACTION = "st_reopen";
const STATUS_EMOJI = {
  claimed: ":eyes:",
  resolved: ":white_check_mark:",
  closed: ":x:",
};

// WHY: Slack stays usable before any helper syncs, while the dashboard must
// deny strangers even then — one check, explicit empty-table policy.
function isActorAllowed(programId, actorId, allowEmpty = true) {
  if (!actorId) return false;
  try {
    if (isAdmin && isAdmin(actorId)) return true;
  } catch (e) {
    log.debug("tickets", `isAdmin check failed: ${e.message}`);
  }
  try {
    const helpers = db.listHelpers(programId);
    if (helpers.length === 0) return !!allowEmpty;
    if (db.isHelper(programId, actorId)) return true;
  } catch (e) {
    log.debug("tickets", `helper check failed: ${e.message}`);
  }
  return false;
}

function authorize(ticket, { programId, workspaceId, actorId }) {
  if (!ticket) return "ticket not found";
  if (programId && ticket.program_id !== programId) return "program mismatch";
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return "workspace mismatch";
  if (actorId && !isActorAllowed(ticket.program_id, actorId, true)) return "actor is not a helper of this program";
  return null;
}

function getOrganizerChannel(program, workspaceId = null) {
  if (!program) return null;
  const direct = program.organizerChannel || program.organizer_channel || program.organizer_channel_id;
  if (direct) return direct;
  if (program.id) {
    try {
      const channels = db.listProgramChannels(program.id);
      const ws = workspaceId || program.workspaceId || program.workspace_id;
      const match = channels.find((c) => c.kind === "organizer" && (!ws || c.workspace_id === ws));
      if (match) return match.channel_id;
      const anyOrg = channels.find((c) => c.kind === "organizer");
      if (anyOrg) return anyOrg.channel_id;
    } catch (e) {
      log.debug("tickets", `getOrganizerChannel queries failed: ${e.message}`);
    }
  }
  return null;
}

function getTicketCardDestination(program, workspaceId = null) {
  return getOrganizerChannel(program, workspaceId);
}

function recordTransition(ticket, actorId, eventType, detail = null) {
  try {
    db.addTicketEvent({ ticketId: ticket.id, programId: ticket.program_id, actorId, eventType, detail });
  } catch (e) {
    log.debug("tickets", `event record failed: ${e.message}`);
  }
  try {
    audit.record({
      programId: ticket.program_id,
      actorId,
      action: `ticket.${eventType}`,
      entityType: "ticket",
      entityId: ticket.id,
      metadata: detail,
    });
  } catch (e) {
    log.debug("tickets", `audit record failed: ${e.message}`);
  }
}

// A reopen starts a new assignment epoch: the prior round's offers stay in
// the trail as history, but a fresh pool offer reopens the routing gate so a
// later escalation can page again instead of deduping against a stale
// outstanding offer from before the resolve. DB-only — never posts.
function startNewEpoch(ticket) {
  if (!ticket || !ticket.id || !ticket.program_id) return;
  try {
    const fresh = db.getTicket(ticket.id) || ticket;
    assignmentLifecycle.recordOffer({ ticket: fresh, to: null, source: "reopened" });
  } catch (e) {
    log.debug("tickets", `reopen epoch record failed for #${ticket.id}: ${e.message}`);
  }
}

function buildTicketCardBlocks(ticket, program, candidates = null) {
  const statusEmoji = STATUS_EMOJI[ticket.status] || ":sos:";
  const progName = program ? program.name : ticket.program_id || "YSWS";
  const assigneeStr = ticket.assignee_id ? ` • Claimed by <@${ticket.assignee_id}>` : "";
  const statusStr = `*Status*: ${statusEmoji} \`${ticket.status}\`${assigneeStr}`;
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `[${progName}] Ticket ${ticketRef(ticket) || `#${ticket.id}`}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Question*: ${reply.escapeSlack(ticket.question)}\n*Requester*: <@${ticket.requester_id}> in <#${ticket.channel}>`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: statusStr },
    },
  ];
  if (CLAIMABLE.includes(ticket.status)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🙋 Claim Ticket" },
          style: "primary",
          value: String(ticket.id),
          action_id: "claim_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🙅 Decline" },
          value: String(ticket.id),
          action_id: "decline_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Resolve" },
          value: String(ticket.id),
          action_id: "resolve_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "💬 Reply" },
          value: String(ticket.id),
          action_id: "reply_ticket_button",
        },
      ],
    });
  } else if (WORKABLE.includes(ticket.status)) {
    // WHY: auto-assign lands here without a Claim click — same actions as
    // claimed, since the assignee still needs to work, hand off, or close.
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "↩️ Release" },
          value: String(ticket.id),
          action_id: "unclaim_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Resolve" },
          style: "primary",
          value: String(ticket.id),
          action_id: "resolve_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Close" },
          value: String(ticket.id),
          action_id: "close_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "💬 Reply" },
          value: String(ticket.id),
          action_id: "reply_ticket_button",
        },
      ],
    });
  } else if (CLOSED.includes(ticket.status)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔄 Reopen" },
          value: String(ticket.id),
          action_id: "reopen_ticket",
        },
      ],
    });
  }
  // WHY: a static select right on the card, not a modal — recommend() is a
  // pure DB read, so options can be built synchronously at render time.
  if (ticket.status === CLAIMABLE[0] || WORKABLE.includes(ticket.status)) {
    let list = candidates;
    if (!list) {
      try {
        list = helperRoute.recommend({ programId: ticket.program_id, category: ticket.category, limit: 5, ...routingOptions(program, ticket) });
        if (!list || list.length === 0) {
          const bot = (() => { try { return require("./config").config?.slack?.botUserId || null; } catch (_) { return null; } })();
          list = db.listHelpers(ticket.program_id, true)
            .filter((helper) => helper.user_id !== ticket.requester_id && helper.user_id !== bot)
            .map((helper) => ({
              userId: helper.user_id,
              reasons: ["program helper"],
            }));
        }
      } catch (e) {
        log.debug("tickets", `helper recommendation failed: ${e.message}`);
        list = [];
      }
    }
    let passed = new Set();
    try {
      passed = assignmentLifecycle.helpersWhoPassed(ticket.program_id, ticket.id);
    } catch (e) {
      log.debug("tickets", `helpersWhoPassed lookup failed for #${ticket.id}: ${e.message}`);
    }
    // The requester is never offered as a reassign target either.
    const botId = (() => { try { return require("./config").config?.slack?.botUserId || null; } catch (_) { return null; } })();
    const filtered = (list || []).filter((r) => r.userId !== ticket.assignee_id && !passed.has(r.userId) && r.userId !== ticket.requester_id && r.userId !== botId);
    if (filtered.length > 0) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "static_select",
            placeholder: { type: "plain_text", text: "🔁 Reassign to…" },
            action_id: "reassign_select",
            options: filtered.map((r) => ({
              text: { type: "plain_text", text: `@${r.userId} — ${r.reasons[0]}`.slice(0, 75) },
              value: `${ticket.id}:${r.userId}`,
            })),
          },
        ],
      });
    }
  }
  return blocks;
}

const TICKET_STATUS_LABELS = {
  open: "Open",
  waiting_for_helper: "Waiting for a helper",
  assigned: "Assigned",
  claimed: "Claimed",
  escalated: "Escalated",
  reopened: "Reopened",
  resolved: "Resolved",
  closed: "Closed",
  duplicate: "Duplicate",
  spam: "Spam",
  snoozed: "Snoozed",
};

function friendlyStatusLabel(status) {
  return TICKET_STATUS_LABELS[status] || status;
}

function ticketStatusLabel(ticket) {
  return TICKET_STATUS_LABELS[ticket && ticket.status] || (ticket && ticket.status);
}

// The canonical user-facing ticket identifier — always the numeric primary
// key, never a Slack channel/routing id.
function ticketRef(ticket) {
  const n = Number(ticket && ticket.id);
  return Number.isInteger(n) && n > 0 ? `#${n}` : "";
}

/* ----------------------------------------- requester-facing support ticket -- */

function docsLink(prog) {
  const links = (prog && prog.links) || {};
  return links.docs || links.site || null;
}

// The one message in the help thread that represents the ticket. Two states:
// open (a helper is coming, one Resolve button) and resolved (who resolved it,
// one Reopen button). It is chat.update-d in place on every transition, so a
// stale "Mark as resolved" button never lingers next to a resolved ticket.
// Claim/assign/reassign and everything else stay on the organizer card.
function supportTicketBlocks(ticket, prog) {
  if (CLOSED.includes(ticket.status)) {
    const by = ticket.resolved_by ? ` by <@${ticket.resolved_by}>` : "";
    return [
      { type: "section", text: { type: "mrkdwn", text: `Resolved${by}! If you have more questions, feel free to open a new thread.` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Reopen" }, value: String(ticket.id), action_id: SUPPORT_REOPEN_ACTION }] },
    ];
  }
  const link = docsLink(prog);
  const tail = link ? ` In the meantime, take a look at the docs: ${link}` : "";
  return [
    { type: "section", text: { type: "mrkdwn", text: `Someone will be here to help you soon!${tail}` } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Mark as resolved" }, value: String(ticket.id), action_id: SUPPORT_RESOLVE_ACTION }] },
  ];
}

function ticketUIProjection(ticket, prog, candidates = null) {
  return {
    card: {
      text: `[Ticket #${ticket.id}] ${friendlyStatusLabel(ticket.status)}`,
      blocks: buildTicketCardBlocks(ticket, prog, candidates),
    },
    thread: {
      text: CLOSED.includes(ticket.status) ? "Ticket resolved." : "Someone will be here to help you soon!",
      blocks: supportTicketBlocks(ticket, prog),
    },
    reaction: CLOSED.includes(ticket.status) ? config.ticketResolvedReaction : config.ticketOpenReaction,
  };
}

function projectionKey(ticket, projection) {
  return JSON.stringify({
    id: ticket.id,
    status: ticket.status,
    assignee: ticket.assignee_id || null,
    resolvedBy: ticket.resolved_by || null,
    publicAck: ticket.public_ack_ts || null,
    cardTs: ticket.card_ts || null,
    cardText: projection.card.text || null,
    reaction: projection.reaction || null,
  });
}

async function reconcileTicketUI({ client, ticket, program = null, cardText = null }) {
  if (!client || !ticket) return;
  let queues = reconcilingTicketUI.get(client);
  if (!queues) {
    queues = new Map();
    reconcilingTicketUI.set(client, queues);
  }
  const ticketKey = String(ticket.id);
  const previous = queues.get(ticketKey);
  const current = previous
    ? previous.catch(() => {}).then(() => reconcileTicketUIOnce({ client, ticket, program, cardText }))
    : reconcileTicketUIOnce({ client, ticket, program, cardText });
  queues.set(ticketKey, current.finally(() => {
    if (queues.get(ticketKey) === current) queues.delete(ticketKey);
  }));
  return current;
}

async function reconcileTicketUIOnce({ client, ticket, program = null, cardText = null }) {
  // A queued reconciliation may outlive the mutation that scheduled it. Read
  // the authoritative row again so an older snapshot can never repaint Slack
  // back to a previous lifecycle state.
  ticket = db.getTicket(ticket.id) || ticket;
  const prog = program || (ticket.program_id ? programs.get(ticket.program_id) : null);
  let candidates = [];
  try {
    candidates = helperRoute.recommend({ programId: ticket.program_id, category: ticket.category, limit: 5, ...routingOptions(prog, ticket) });
  } catch (e) {
    log.debug("tickets", `helper recommendation failed: ${e.message}`);
  }
  const projection = ticketUIProjection(ticket, prog, candidates);
  if (cardText) projection.card.text = cardText;
  const key = projectionKey(ticket, projection);
  let renderedByTicket = renderedTicketUI.get(client);
  if (!renderedByTicket) {
    renderedByTicket = new Map();
    renderedTicketUI.set(client, renderedByTicket);
  }
  const previous = renderedByTicket.get(String(ticket.id));
  if (previous === key) return true;

  const cardSynced = await syncSlack({
    client,
    channel: getOrganizerChannel(prog || { id: ticket.program_id }, ticket.workspace_id),
    ts: ticket.card_ts,
    text: projection.card.text,
    blocks: projection.card.blocks,
  }, ticket);
  const latest = db.getTicket(ticket.id) || ticket;
  if (latest.status !== ticket.status || latest.assignee_id !== ticket.assignee_id) {
    return reconcileTicketUIOnce({ client, ticket: latest, program, cardText });
  }
  const supportSynced = await syncSupportTicketUI(client, latest, prog, ticketUIProjection(latest, prog));
  if (cardSynced && supportSynced) renderedByTicket.set(String(ticket.id), key);
  return cardSynced && supportSynced;
}

async function syncSupportTicketUI(client, ticket, prog, projection = null) {
  const view = projection || ticketUIProjection(ticket, prog);
  let synced = true;
  if (client?.chat?.update && ticket.public_ack_ts) {
    try {
      await client.chat.update({
        channel: ticket.channel,
        ts: ticket.public_ack_ts,
        text: view.thread.text,
        blocks: reply.plainDashesInBlocks(view.thread.blocks),
      });
    } catch (e) {
      recordSlackSyncFailure("thread", ticket, e);
      synced = false;
    }
  }
  return synced && await syncTicketReactions(client, ticket, prog);
}

// A marker emoji on the requester's own message, so the collapsed channel
// timeline (which shows reactions but not thread replies) makes clear the
// message has a ticket. Swapped open <-> resolved on every transition. Both
// swaps are best-effort — already_reacted / no_reaction errors are expected.
async function syncTicketReactions(client, ticket, program = null) {
  const open = config.ticketOpenReaction;
  const done = config.ticketResolvedReaction;
  if (!client?.reactions?.add || !ticket?.thread_ts || !ticket?.channel || (!open && !done)) return true;
  // A reaction is a visible mark too.
  if (!ticketSurfaces(program || programs.get(ticket.program_id)).thread) return true;
  let synced = true;
  const closed = CLOSED.includes(ticket.status);
  const want = closed ? done : open;
  const drop = closed ? open : done;
  const at = { channel: ticket.channel, timestamp: ticket.thread_ts };
  if (want) await client.reactions.add({ ...at, name: want }).catch((e) => { synced = false; recordSlackSyncFailure("reaction", ticket, e); });
  if (drop && client.reactions.remove) await client.reactions.remove({ ...at, name: drop }).catch((e) => { synced = false; recordSlackSyncFailure("reaction", ticket, e); });
  return synced;
}

// Is `channel` this program's help channel? Trusts the program object's own
// helpChannel (callers pass ad-hoc program objects that aren't in the
// registry) and falls back to the registry lookup.
function isHelpChannelFor(prog, channel, workspaceId = null) {
  if (!prog || !channel) return false;
  if (prog.helpChannel === channel) return true;
  return programs.isHelpChannel(channel, workspaceId);
}

// Settings for this call, or null when the program is unknown — in which case
// callers keep the legacy behavior (which fails closed on pings: helperPing
// was opt-in). Unknown programs never get the permissive settings defaults.
function policyFor(prog, { channel = null, workspaceId = null, role = null } = {}) {
  if (!prog) return null;
  return ticketPolicy({ program: prog, role: resolveTicketRole({ program: prog, channel, workspaceId, role }) });
}

// Selection mode + exclusions shared by every helper-ranking call site: the
// requester is never a candidate, and programs with expertiseRouting off get
// plain workload selection instead of category/expertise ranking.
function routingOptions(prog, ticket) {
  const pol = policyFor(prog, { channel: ticket && ticket.channel, workspaceId: ticket && ticket.workspace_id });
  return {
    expertiseRouting: pol ? pol.expertiseRouting : true,
    exclude: ticket && ticket.requester_id ? [ticket.requester_id] : [],
  };
}

// Whether a support ticket may be opened here. The channel role's settings
// decide whether a ticket exists at all (recordTicket) and whether the
// per-question path creates one visibly (createOnSupport/autoCreateTickets);
// explicit human paging bypasses only that second bit. Posture is NOT checked
// here — the per-question log (getOrCreateOpenTicket) records passive
// programs too; only the requester-facing paths (ensureSupportTicket) skip
// passive.
//   paging=false (per-question path): help channel only, publicTicketsEnabled
//     honoured everywhere.
//   paging=true  (human paging — sensitive content, explicit escalation): a
//     ticket even outside the help channel; publicTicketsEnabled only gates
//     the help channel itself.
function ticketCreationAllowed({ prog, channel, workspaceId = null, paging = false, role = null }) {
  if (!prog) return false;
  const pol = policyFor(prog, { channel, workspaceId, role });
  if (!pol || !pol.recordTicket) return false;
  if (!paging && !pol.createOnSupport) return false;
  const inHelp = channel ? isHelpChannelFor(prog, channel, workspaceId) : true;
  if (paging) {
    if (prog.publicTicketsEnabled === false && channel && inHelp && prog.ticketVisibility !== "dashboard") return false;
    return true;
  }
  if (prog.publicTicketsEnabled === false && prog.ticketVisibility !== "dashboard") return false;
  if (channel && !inHelp) return false;
  return true;
}

// Where a ticket may appear.
function ticketSurfaces(prog) {
  const mode = (prog && prog.ticketVisibility) || "thread";
  return {
    thread: mode === "thread",
    organizer: mode === "thread" || mode === "organizer",
  };
}

function categoryRules(prog) {
  if (prog?.categories && typeof prog.categories === "object") return prog.categories;
  if (prog?.ticketsEnabled === false) return null;
  return ticketCategory.defaultTaxonomy();
}

function applyCategory(ticketId, { prog, channel, question }) {
  const rules = categoryRules(prog);
  if (!ticketId || !prog || !rules) return null;
  try {
    const category = ticketCategory.classify({ question, channel, rules });
    if (category) db.setTicketTriage(ticketId, { category, categorySource: "classifier" });
    return category;
  } catch (e) {
    log.debug("tickets", `classify failed for #${ticketId}: ${e.message}`);
    return null;
  }
}

function reclassifyOnFollowUp(ticket, { prog, question, requesterId }) {
  if (!ticket || !prog || ticket.status === "resolved" || ticket.status === "closed") return ticket;
  if (!question || requesterId !== ticket.requester_id || question === ticket.question) return ticket;
  const followUps = [];
  for (const event of db.listTicketEvents(ticket.id)) {
    if (event.event_type !== "requester_followup") continue;
    try {
      const detail = JSON.parse(event.detail || "{}");
      if (detail.text) followUps.push(detail.text);
    } catch (_) {}
  }
  if (!followUps.includes(question)) {
    recordTransition(ticket, requesterId, "requester_followup", { text: question });
    followUps.push(question);
  }
  const rules = categoryRules(prog);
  if (!rules) return ticket;
  if (ticket.category_source === "human") return db.getTicket(ticket.id) || ticket;
  const category = ticketCategory.classify({ question, channel: null, rules: { ...rules, fallback: null } });
  if (category && category !== ticket.category) db.setTicketTriage(ticket.id, { category, categorySource: "classifier" });
  return db.getTicket(ticket.id) || ticket;
}

// The reliable baseline: a ticket for every eligible root support question in
// an active help channel, created and shown BEFORE we know whether Pixie can
// answer. Idempotent — a Slack retry finds the same ticket by thread and skips
// both Slack posts because their ts is already stored. `paging` relaxes the
// help-channel gate for the human-escalation path (see ticketCreationAllowed).
async function ensureSupportTicket({ program, channel, threadTs, requesterId, question, client, workspaceId = null, paging = false, role = null }) {
  if (!threadTs) return null;
  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  if (!prog) return null;
  const wsId = workspaceId || prog.workspaceId || prog.workspace_id || null;

  let ticket = db.getTicketByThreadTs(threadTs, wsId, prog.id);
  if (!ticket) {
    // Passive blocks visible tickets only.
    const surfaces = ticketSurfaces(prog);
    if (prog.posture === "passive" && (surfaces.thread || surfaces.organizer)) return null;
    if (!ticketCreationAllowed({ prog, channel, workspaceId: wsId, paging, role })) return null;
    const id = db.createTicket({ programId: prog.id, workspaceId: wsId, channel, threadTs, requesterId, question });
    applyCategory(id, { prog, channel, question });
    ticket = id ? db.getTicket(id) : db.getTicketByThreadTs(threadTs, wsId, prog.id);
    if (ticket && !db.listTicketEvents(ticket.id).some((e) => e.event_type === "created")) {
      recordTransition(ticket, requesterId, "created", { channel, workspaceId: wsId, source: "support_question" });
    }
  }
  if (!ticket) return null;
  ticket = reclassifyOnFollowUp(ticket, { prog, question, requesterId });

  if (client && !ticket.public_ack_ts && ticketSurfaces(prog).thread) {
    try {
      const res = await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel,
        threadTs,
        text: "Someone will be here to help you soon!",
        blocks: reply.plainDashesInBlocks(supportTicketBlocks(ticket, prog)),
      });
      if (res?.ts && db.updatePublicAckTs(ticket.id, res.ts)) {
        ticket.public_ack_ts = res.ts;
        db.recordFirstResponse(ticket.id, false);
      } else if (res?.ts) {
        // A concurrent caller already attached the ack — drop this duplicate.
        await client.chat.delete({ channel, ts: res.ts }).catch(() => {});
      }
    } catch (e) {
      recordSlackSyncFailure("thread_post", ticket, e);
      log.warn("tickets", `support ticket UI post failed for #${ticket.id}: ${e.message}`);
    }
  }
  const fresh = db.getTicket(ticket.id);
  if (client) void syncTicketReactions(client, fresh, prog);
  if (client && !fresh.card_ts && ticketSurfaces(prog).organizer && getOrganizerChannel(prog, wsId)) {
    await postCard({ prog, programId: prog.id, resolvedWorkspaceId: wsId, ticket: fresh, client, requesterId, question });
  }
  return db.getTicket(ticket.id);
}

// One escalation epoch, one ping: an already-open offer (targeted or pool)
// means routing already started for this go-round, so nothing re-declares
// the pool. A fresh pool offer only belongs at the moment nobody has been
// offered this ticket yet — a decline/release/timeout closes the prior offer
// first (see declineAssignment / unclaimTicket / assignmentLifecycle), which
// is what legitimately reopens this gate.
function hasOpenOffer(ticket) {
  return !!assignmentLifecycle.openOfferFor(ticket.program_id, ticket.id);
}

// A roster helper already talking in the thread outranks any automated pick
// — paging a second person over someone already on it is exactly the "ping
// fatigue" this exists to prevent.
function hasHelperReplied(ticketId) {
  return db.listTicketEvents(ticketId).some((event) => event.event_type === "helper_reply");
}

// The requester already @-mentioned a real, active helper of this program —
// that IS the page. An automated ping on top of it would be a second one for
// the exact same ask.
function helperMentionedIn(programId, text) {
  if (!programId || !text) return false;
  const eligibility = require("./eligibility");
  const mentions = eligibility.otherMentions(text, config?.slack?.botUserId);
  return mentions.some((m) => {
    const id = (m.match(/<@([A-Z0-9]+)/) || [])[1];
    return id && db.isHelper(programId, id);
  });
}

// Pixie couldn't answer a ticket it's holding — move it to waiting_for_helper,
// run helper routing (recommend-only, or auto-assign when the program opts in),
// and refresh the organizer card. The thread UI already says a helper is
// coming, so it doesn't change and nothing new is posted there.
function markWaitingForHelper({ ticketId, client = null, program = null, question = null, role = null, explicit = false }) {
  const ticket = db.getTicket(ticketId);
  // Snoozed is an organizer's "not now" — a promotion must not wake it.
  if (!ticket || CLOSED.includes(ticket.status) || ticket.status === "snoozed") return ticket || null;
  // Durable suppression: a muted thread gets no further automated side
  // effects at all — not just no ping — until an explicit wake clears it.
  if (db.isThreadMuted(ticket.thread_ts) || db.isTakeover(ticket.thread_ts)) return ticket;
  const prog = program || programs.get(ticket.program_id);
  const pol = policyFor(prog, { channel: ticket.channel, workspaceId: ticket.workspace_id, role });
  // Automatic escalation (Pixie could not answer) honors the channel's
  // escalateUnknown setting; an explicit human escalation always moves. The
  // pool offer and the routing snapshot below are audit trail, not
  // escalation, so they are recorded either way.
  const autoBlocked = pol && !explicit && !pol.escalate;
  let updated = db.getTicket(ticketId);
  if (!autoBlocked && !WORKABLE.includes(updated.status) && updated.status !== "waiting_for_helper") {
    const changed = db.markTicketWaitingForHelper(ticketId);
    if (changed) recordTransition(db.getTicket(ticketId), null, "escalated", { by: "ai_no_answer" });
    updated = db.getTicket(ticketId);
  }
  // The ticket is now in front of the helper pool — the first lifecycle offer,
  // and ONLY the first: an already-open offer means this ticket's epoch is
  // already underway, so re-declaring a pool offer here would supersede
  // (and un-dedupe) whatever targeted ping is already outstanding.
  const alreadyOffered = hasOpenOffer(updated);
  if (updated && !updated.assignee_id && !alreadyOffered) {
    try {
      assignmentLifecycle.recordOffer({ ticket: updated, to: null, source: "queue" });
    } catch (e) {
      log.debug("tickets", `pool offer record failed for #${ticketId}: ${e.message}`);
    }
  }
  try {
    require("./shadowRouting").snapshotForTicket(updated);
  } catch (e) {
    log.warn("tickets", `shadow routing snapshot failed for #${ticketId}: ${e.message}`);
  }
  if (!autoBlocked && prog && prog.autoAssign === true && !updated.assignee_id && !alreadyOffered) {
    try {
      const [top] = helperRoute.recommend({ programId: ticket.program_id, category: updated.category, limit: 1, ...routingOptions(prog, updated) });
      if (top && db.assignTicket(ticketId, top.userId)) {
        updated = db.getTicket(ticketId);
        recordTransition(updated, null, "assigned", { to: top.userId, automatic: true });
        try {
          assignmentLifecycle.recordOffer({ ticket: updated, to: top.userId, source: "auto" });
        } catch (e) {
          log.debug("tickets", `auto offer record failed for #${ticketId}: ${e.message}`);
        }
      }
    } catch (e) {
      log.warn("tickets", `auto-assign failed for #${ticketId}: ${e.message}`);
    }
  }
  const mayPing = !autoBlocked && (pol ? pol.pingHelpers : (prog && prog.helperPing === true));
  if (mayPing) {
    void pingRecommendedHelper({ client, ticket: updated, program: prog, question, role }).catch((e) => {
      log.warn("tickets", `helper ping failed for #${ticketId}: ${e.message}`);
    });
  }
  if (!autoBlocked && client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Waiting for a helper`).catch(() => {});
  return updated;
}

// Ticket optional: mention works either way.
async function handOffToHelper({ client, program, channel, threadTs, question, ticket = null, requesterId = null, workspaceId = null, role = null }) {
  if (ticket) return markWaitingForHelper({ ticketId: ticket.id, client, program, question, role, explicit: true });
  if (!program) return null;
  const pol = policyFor(program, { channel, workspaceId, role });
  if (pol ? !pol.pingHelpers : program.helperPing !== true) return null;
  return pingThreadHelper({ client, program, channel, threadTs, question, requesterId, workspaceId, role });
}

// Ticket-free mention, once per thread. The requester is never a candidate:
// paging someone to answer their own question is the failure this guard
// exists to prevent (seen live: a helper asking Pixie got paged themself).
async function pingThreadHelper({ client, program, channel, threadTs, question, requesterId = null, workspaceId = null, role = null }) {
  if (!client || !program || !threadTs || !channel) return null;
  const pol = policyFor(program, { channel, workspaceId, role });
  if (pol ? !pol.pingHelpers : program.helperPing !== true) return null;
  if (programs.isShadow(program)) return null;
  if (db.isThreadMuted(threadTs) || db.isTakeover(threadTs)) return null;
  if (db.getThread(threadTs)?.helper_pinged) return null;
  if (helperMentionedIn(program.id, question)) return null;

  const category = ticketCategory.classify({ question, channel, rules: program.categories });
  const opts = routingOptions(program, { channel, requester_id: requesterId });
  const candidates = helperRoute.recommend({ programId: program.id, category, limit: 5, ...opts });
  const [top] = candidates;
  const logDecision = (skipReason, posted = false, selected = null) =>
    logRoutingDecision({ ticket: { channel, thread_ts: threadTs, program_id: program.id }, program, category, candidates, selected, posted, skipReason });
  if (!top) return logDecision("no_eligible_helper"), null;

  // Claim before posting.
  db.touchThread(threadTs, channel, { helperPinged: true });

  const ask = `<@${top.userId}> — could you take a look at this one?`;
  await slackMessages.sendProgramMessage({
    client,
    program,
    channel,
    threadTs,
    text: reply.plainDashes(ask),
  });
  logDecision(null, true, top.userId);
  return top.userId;
}

// One structured event per ping decision — the answer to "why did Pixie ping
// X" (or why it didn't) should always be findable in a single log line, never
// spread across several or reconstructed from hidden model reasoning.
function logRoutingDecision({ ticket, program, category, candidates = [], selected = null, posted = false, skipReason = null }) {
  const ranked = candidates.slice(0, 5).map((c) => `${c.userId}:${c.score}`).join(",");
  log.info(
    "routing",
    `program=${(program && program.id) || (ticket && ticket.program_id) || "?"} ` +
      `channel=${(ticket && ticket.channel) || "?"} thread_ts=${(ticket && ticket.thread_ts) || "?"} ` +
      `ticket_id=${ticket && ticket.id != null ? ticket.id : "?"} category=${category || "none"} ` +
      `candidates=[${ranked}] selected=${selected || "none"} posted=${posted} skip_reason=${skipReason || "none"}`,
  );
}

// Mention on an escalated ticket. Offer recorded first.
// Every path that pages one specific named helper on a ticket — routing's
// top pick, the ticket's assignee, or whoever routing retry names after a
// decline — funnels through here, so no caller can page someone by skipping
// a guard another caller remembered. The lifecycle offer (recordOffer) is the
// actual dedupe boundary; everything above it is a reason to never even try.
async function pingSpecificHelper({ client, ticket, program, userId, question = null, source = "ping", candidates = [], role = null }) {
  const logDecision = (skipReason, posted = false) =>
    logRoutingDecision({ ticket, program, category: ticket?.category, candidates, selected: userId, posted, skipReason });

  if (!client || !ticket || !program || !userId) return logDecision("missing_args"), null;
  // Opt-in enforced here too — the channel role's helper-ping setting.
  const pol = policyFor(program, { channel: ticket.channel, workspaceId: ticket.workspace_id, role });
  if (pol ? !pol.pingHelpers : program.helperPing !== true) return logDecision("helper_ping_disabled"), null;
  if (CLOSED.includes(ticket.status)) return logDecision("ticket_closed"), null;
  if (programs.isShadow(program)) return logDecision("shadow_mode"), null;
  // Pixie's own bot user is never paged, even if it lands on the roster.
  try {
    const bot = require("./config").config?.slack?.botUserId;
    if (bot && userId === bot) return logDecision("bot_user"), null;
  } catch (_) {
    // No config — no bot to exclude.
  }
  // Durable suppression: honored here too, not just at the eligibility gate —
  // this is reachable from a retry/decline path that never re-consults it.
  if (db.isThreadMuted(ticket.thread_ts)) return logDecision("thread_muted"), null;
  // Paging the requester themself (a roster helper asking Pixie a question)
  // is never useful — decline the page rather than self-pinging.
  if (userId && ticket.requester_id && userId === ticket.requester_id) return logDecision("requester_is_candidate"), null;
  if (db.isTakeover(ticket.thread_ts)) return logDecision("human_engaged"), null;
  // A helper is already in the thread; paging a second one is exactly the
  // fatigue this exists to prevent.
  if (hasHelperReplied(ticket.id)) return logDecision("helper_already_replied"), null;
  // The requester already @-mentioned a real helper themselves.
  if (helperMentionedIn(ticket.program_id, question) || helperMentionedIn(ticket.program_id, ticket.question)) {
    return logDecision("requester_already_mentioned_helper"), null;
  }

  const offer = assignmentLifecycle.recordOffer({ ticket, to: userId, source });
  if (!offer.recorded) return logDecision("dedupe_open_offer_exists"), null;

  const ask = `<@${userId}> — could you take a look at this one?`;
  await slackMessages.sendProgramMessage({
    client,
    program,
    channel: ticket.channel,
    threadTs: ticket.thread_ts,
    text: reply.plainDashes(ask),
  });
  logDecision(null, true);
  return userId;
}

async function pingRecommendedHelper({ client, ticket, program, question = null, role = null }) {
  if (!client || !ticket || !program) return null;
  // Tell the assignee, not a second pick — unless the assignee IS the
  // requester, in which case there is nobody to page.
  let userId = ticket.assignee_id || null;
  if (userId && ticket.requester_id && userId === ticket.requester_id) {
    logRoutingDecision({ ticket, program, category: ticket.category, candidates: [], selected: userId, posted: false, skipReason: "assignee_is_requester" });
    return null;
  }
  let candidates = [];
  if (!userId) {
    candidates = helperRoute.recommend({ programId: ticket.program_id, category: ticket.category, limit: 5, ...routingOptions(program, ticket) });
    const [top] = candidates;
    if (!top) {
      logRoutingDecision({ ticket, program, category: ticket.category, candidates, skipReason: "no_eligible_helper" });
      return null;
    }
    userId = top.userId;
  }
  return pingSpecificHelper({ client, ticket, program, userId, question, source: "ping", candidates, role });
}

// A failed Slack sync is non-fatal — the domain state is already written and
// the next card render self-heals — but it should not be invisible. Records
// only the ticket id, program, and the Slack error code; never the ticket
// question, a token, or any message content.
function recordSlackSyncFailure(surface, ticket, err) {
  const code = (err && (err.code || (err.data && err.data.error))) || "unknown";
  log.warn("tickets", `slack ${surface} sync failed for #${ticket?.id ?? "?"}: ${code}`);
  try {
    db.recordMetric("ticket_slack_sync_failure", null, `${surface}:${String(code).slice(0, 40)}`, ticket?.program_id || null);
  } catch (e) {
    log.debug("tickets", `sync failure metric failed: ${e.message}`);
  }
}

async function syncSlack({ client, channel, ts, text, blocks }, ticket = null) {
  if (!client?.chat?.update || !channel || !ts) return true;
  try {
    await client.chat.update({
      channel,
      ts,
      text: reply.plainDashes(text),
      blocks: reply.plainDashesInBlocks(blocks),
    });
    return true;
  } catch (e) {
    recordSlackSyncFailure("card", ticket, e);
    return false;
  }
}

async function syncCard(client, ticket, text) {
  await reconcileTicketUI({ client, ticket, cardText: text });
}

function resolveProg({ program, channel, workspaceId }) {
  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  const programId = prog ? prog.id : "pixl";
  const resolvedWorkspaceId = workspaceId || (prog ? prog.workspaceId || prog.workspace_id || null : null);
  return { prog, programId, resolvedWorkspaceId };
}

async function checkIncident({ prog, programId, question, ticket, client, channel, threadTs, requesterId, resolvedWorkspaceId, placeholder, bypassIncidentMatch }) {
  if (bypassIncidentMatch) return { done: false };
  const incidentMode = prog?.incidentMode || "ANSWER_AND_TRACK";
  if (incidentMode === "NORMAL_TICKET" || !client) return { done: false };
  let matched = null;
  try {
    matched = incidents.matchActiveIncident({ programId, question });
  } catch (e) {
    log.debug("tickets", `incident match failed: ${e.message}`);
  }
  if (!matched) return { done: false };
  const text = reply.plainDashes(matched.public_message || `We're currently aware of an issue with "${matched.title}". The team is investigating — I'll update this thread when there's a confirmed resolution.`);
  try {
    // The incident note is a normal thread reply — it never resolves or
    // annotates the ticket. Whatever ticket the thread has stays open until a
    // human resolves it.
    if (placeholder) {
      await reply.finalize(client, channel, threadTs, placeholder, text, { program: prog });
    } else {
      await slackMessages.sendProgramMessage({ client, program: prog, channel, threadTs, text });
    }
    if (incidentMode === "ANSWER_AND_TRACK") {
      incidents.recordAffectedReport({ incidentId: matched.id, programId, requesterId, channel, threadTs });
    }
    log.info("tickets", `posted active incident #${matched.id} note to the thread (${programId})`);
    return { done: true, ticket: ticket ? db.getTicket(ticket.id) : null };
  } catch (e) {
    log.warn("tickets", `incident-aware reply failed, falling back to a normal escalation: ${e.message}`);
    return { done: false };
  }
}

async function postCard({ prog, programId, resolvedWorkspaceId, ticket, client, requesterId, question }) {
  // WHY: cards route strictly to the organizer channel — never the public
  // help channel, and no fallback on error.
  const organizerChannel = getOrganizerChannel(prog, resolvedWorkspaceId);
  if (!organizerChannel) {
    log.error("tickets", `no organizer channel configured for program ${programId} — ticket #${ticket.id} card not posted`);
    return ticket;
  }
  if (client && client.chat && client.chat.postMessage) {
    try {
      let candidates = [];
      try {
        candidates = helperRoute.recommend({ programId, category: ticket.category, limit: 5, ...routingOptions(prog, ticket) });
      } catch (e) {
        log.debug("tickets", `helper recommendation failed: ${e.message}`);
      }
      const cardBlocks = reply.plainDashesInBlocks(buildTicketCardBlocks(ticket, prog, candidates));
      const res = await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel: organizerChannel,
        text: reply.plainDashes(`[Ticket #${ticket.id}] <@${requesterId}> asked: "${reply.escapeSlack(question).slice(0, 100)}"`),
        blocks: cardBlocks,
      });
      if (res?.ts) {
        if (db.updateTicketCardTs(ticket.id, res.ts)) {
          ticket.card_ts = res.ts;
        } else if (client.chat.delete) {
          await client.chat.delete({ channel: organizerChannel, ts: res.ts }).catch((e) => recordSlackSyncFailure("card_duplicate_delete", ticket, e));
        }
      }
    } catch (e) {
      recordSlackSyncFailure("card_post", ticket, e);
      log.error("tickets", `failed to post ticket card to organizer channel ${organizerChannel} for program ${programId}: ${e.message}`);
    }
  }
  return ticket;
}

// A support request that needs a human right now — a sensitive-category
// question (no AI answer allowed) or a gap Pixie could not fill. It runs the
// one ticket path: ensureSupportTicket opens the ticket and posts the
// Pixorpheus thread UI + organizer card (idempotent by thread), then
// markWaitingForHelper moves it past "open" and routes helpers. No separate
// ticket machinery, no ai_answered, no status footer.
async function escalateTicket({ program, channel, threadTs, requesterId, question, client, workspaceId = null, placeholder = null, bypassIncidentMatch = false, role = null }) {
  const { prog, programId, resolvedWorkspaceId } = resolveProg({ program, channel, workspaceId });
  const existing = db.getTicketByThreadTs(threadTs, resolvedWorkspaceId, prog?.id || null);

  const inc = await checkIncident({ prog, programId, question, ticket: existing, client, channel, threadTs, requesterId, resolvedWorkspaceId, placeholder, bypassIncidentMatch });
  if (inc.done) return inc.ticket || existing || null;

  const ticket = await ensureSupportTicket({
    program: prog,
    channel,
    threadTs,
    requesterId,
    question,
    client,
    workspaceId: resolvedWorkspaceId,
    paging: true,
    role,
  });
  if (!ticket) {
    if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
    return null;
  }

  const promoted = CLOSED.includes(ticket.status) ? ticket : markWaitingForHelper({ ticketId: ticket.id, client, program: prog, question, role, explicit: true });
  if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
  log.info("tickets", `escalated ticket #${ticket.id} for ${programId} in ${channel}`);
  return promoted || ticket;
}

function getOrCreateOpenTicket({ program, channel, threadTs, requesterId, question, workspaceId = null, role = null }) {
  if (!threadTs) return null;
  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  const resolvedWorkspaceId = workspaceId || (prog ? prog.workspaceId || prog.workspace_id || null : null);
  const existing = db.getTicketByThreadTs(threadTs, resolvedWorkspaceId);
  if (existing) return existing;
  if (!ticketCreationAllowed({ prog, channel, workspaceId: resolvedWorkspaceId, role })) return null;
  const id = db.createTicket({ programId: prog.id, workspaceId: resolvedWorkspaceId, channel, threadTs, requesterId, question });
  if (!id) return db.getTicketByThreadTs(threadTs, resolvedWorkspaceId, prog.id);
  applyCategory(id, { prog, channel, question });
  const ticket = db.getTicket(id);
  if (!db.listTicketEvents(id).some((e) => e.event_type === "created")) {
    recordTransition(ticket, requesterId, "created", { channel, workspaceId: resolvedWorkspaceId, source: "eligible_question" });
  }
  return db.getTicket(id) || ticket;
}

// WHY: "still broken" from the requester is a reopen, never a new ticket —
// helper chatter must not reopen. Same lifecycle as the Reopen button: the
// thread UI flips back to "someone will be here soon", the organizer card
// updates, and the reopen is announced in the thread.
// Credit a thread answer, once per helper.
function creditThreadReply(ticket, userId) {
  try {
    const already = db
      .listTicketEvents(ticket.id)
      .some((event) => event.event_type === "helper_reply" && event.actor_id === userId);
    if (already) return;
    recordTransition(ticket, userId, "helper_reply", { via: "thread" });
    db.recordFirstResponse(ticket.id, true);
    helperRoute.recordReply({ programId: ticket.program_id, userId, category: ticket.category });
  } catch (e) {
    log.debug("tickets", `thread reply credit failed for #${ticket.id}: ${e.message}`);
  }
}

// A roster helper speaking in someone else's thread means a human is on it:
// mark the thread taken over so no automated ping (or answer) talks over them.
// Works with or without a ticket — ticketless programs (tickets disabled) never
// had any record of helper replies, which is how Pixie kept paging people into
// threads a helper was already working.
function noteHelperEngaged({ channel, threadTs, userId, parentUserId, workspaceId }) {
  if (!parentUserId || parentUserId === userId) return;
  try {
    const prog = programs.forChannel(channel, workspaceId);
    if (!prog || !isActorAllowed(prog.id, userId, false)) return;
    if (!db.isTakeover(threadTs)) db.markTakeover(threadTs, channel, userId);
  } catch (e) {
    log.debug("tickets", `helper engagement mark failed: ${e.message}`);
  }
}

function noteThreadActivity({ channel, threadTs, userId, text = null, workspaceId = null, client = null, parentUserId = null }) {
  if (!threadTs || !userId) return null;
  noteHelperEngaged({ channel, threadTs, userId, parentUserId, workspaceId });
  let ticket = db.getTicketByThreadTs(threadTs, workspaceId);
  if (!ticket) return null;
  const prog = programs.get(ticket.program_id);
  ticket = reclassifyOnFollowUp(ticket, { prog, question: text, requesterId: userId });
  // Roster helpers only.
  if (userId !== ticket.requester_id && isActorAllowed(ticket.program_id, userId, false)) {
    creditThreadReply(ticket, userId);
  }
  let updated = ticket;
  if (CLOSED.includes(ticket.status)) {
    if (userId !== ticket.requester_id) return ticket;
    if (!db.reopenResolvedTicket(ticket.id, userId)) return db.getTicket(ticket.id);
    updated = db.getTicket(ticket.id);
    recordTransition(updated, userId, "reopened", { by: "requester" });
    startNewEpoch(updated);
    log.info("tickets", `reopened ticket #${ticket.id} on requester activity`);
    const currentProg = programs.get(ticket.program_id);
    void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Reopened` });
    if (client?.chat?.postMessage && !programs.isShadow(currentProg)) {
      void slackMessages
        .sendProgramMessage({
          client,
          program: currentProg,
          channel: updated.channel,
          threadTs: updated.thread_ts,
          text: reply.plainDashes(`Ticket reopened by <@${userId}>.`),
        })
        .catch((e) => log.debug("tickets", `reopen notice failed for #${updated.id}: ${e.message}`));
    }
  }
  try {
    require("./resolutionWatcher").schedule({ ticketId: updated.id, client, program: prog });
  } catch (e) {
    log.debug("tickets", `resolution watcher schedule failed for #${updated.id}: ${e.message}`);
  }
  return updated;
}

function claimTicket({ ticketId, actorId, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  // db.claimTicket's conditional UPDATE is the race guard: exactly one of two
  // simultaneous claims moves the row out of the open set, so only the winner
  // reaches here. recordClaim is itself idempotent against a Slack retry.
  const ok = db.claimTicket(ticketId, actorId);
  if (!ok) return { error: "ticket is not open" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "claimed");
  try {
    assignmentLifecycle.recordClaim({ ticket: updated, userId: actorId });
  } catch (e) {
    log.debug("tickets", `claim lifecycle record failed for #${ticketId}: ${e.message}`);
  }
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Claimed by <@${actorId}>`).catch(() => {});
  return { ok: true, ticket: updated };
}

// Unclaim === release: a helper who had claimed the ticket gives it back to
// the queue. Recorded as helper_assignment_released (distinct from a decline,
// which is a pass before any claim), then re-offered to the pool.
function unclaimTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  // Release is a post-claim action: there must be a claim to give back.
  if (!WORKABLE.includes(ticket.status) || !ticket.assignee_id) {
    return { error: "ticket is not claimed" };
  }
  const releasedBy = ticket.assignee_id;
  const ok = db.unclaimTicket(ticketId);
  if (!ok) return { error: "ticket could not be unclaimed" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "unclaimed");
  try {
    assignmentLifecycle.recordRelease({ ticket: updated, userId: releasedBy });
    assignmentLifecycle.recordOffer({ ticket: updated, to: null, source: "released" });
  } catch (e) {
    log.debug("tickets", `release lifecycle record failed for #${ticketId}: ${e.message}`);
  }
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Released to the queue`).catch(() => {});
  return { ok: true, ticket: updated };
}

// A helper passes on a ticket they have not claimed. Purely a lifecycle
// record: ticket status, assignee, and resolution are untouched, and the
// ticket stays offered to everyone else. Same program-scoped authorization as
// claim — a helper can only decline tickets in a program they are active in.
function declineAssignment({ ticketId, actorId = null, reason = null, programId = null, workspaceId = null, client = null, program = null, role = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  if (!actorId) return { error: "actorId required" };
  if (CLOSED.includes(ticket.status)) return { error: "ticket is already closed" };
  if (ticket.assignee_id === actorId) {
    return { error: "you have claimed this ticket — release it instead of declining" };
  }
  // A decline only closes a real open offer when it targeted this decliner —
  // a pool decline leaves the pool offer open for someone else, so nothing
  // reroutes. See assignmentLifecycle.offersFromEvents.
  const wasTargetedAtDecliner = assignmentLifecycle.openOfferFor(ticket.program_id, ticketId)?.to === actorId;
  const res = assignmentLifecycle.recordDecline({ ticket, userId: actorId, reason });
  if (!res.recorded) return { ok: true, ticket, deduped: true };
  recordTransition(ticket, actorId, "assignment_declined", reason ? { reason: String(reason).slice(0, 40) } : null);
  if (client && ticket.card_ts) void syncCard(client, db.getTicket(ticketId), `[Ticket #${ticket.id}] <@${actorId}> passed`).catch(() => {});

  // The one helper who had this ticket just passed on it: that's the
  // "something meaningful happened" this system requires before a NEW page
  // goes out. Route again, skipping everyone who already declined/timed out,
  // for exactly one fresh ping to the next eligible name — never a second one
  // for the decliner.
  if (wasTargetedAtDecliner && client) {
    const prog = program || programs.get(ticket.program_id);
    const pol = policyFor(prog, { channel: ticket.channel, workspaceId: ticket.workspace_id, role });
    if (pol ? pol.pingHelpers : (prog && prog.helperPing === true)) {
      const next = assignmentLifecycle.nextEligibleHelper({
        programId: ticket.program_id,
        ticketId,
        category: ticket.category,
        exclude: ticket.requester_id ? [ticket.requester_id] : [],
        expertiseRouting: pol ? pol.expertiseRouting : true,
      });
      if (next) {
        void pingSpecificHelper({ client, ticket: db.getTicket(ticketId), program: prog, userId: next.userId, source: "reassign_ping", role }).catch((e) => {
          log.warn("tickets", `reassign ping failed for #${ticketId}: ${e.message}`);
        });
      }
    }
  }
  return { ok: true, ticket };
}

function resolveTicketWorker(ticket, resolvingActorId = null) {
  if (!ticket || !ticket.program_id || !ticket.id) return null;
  const activeHelpers = new Set(db.listHelpers(ticket.program_id, true).map((helper) => helper.user_id));
  const replies = db.handle().query(
    `SELECT actor_id FROM ticket_events
     WHERE ticket_id = ? AND event_type = 'helper_reply' AND actor_id IS NOT NULL
     ORDER BY created_at DESC, id DESC`,
  ).all(ticket.id);
  const latestHelperReply = replies.find((event) => activeHelpers.has(event.actor_id));
  if (latestHelperReply) return latestHelperReply.actor_id;
  if (ticket.assignee_id) return ticket.assignee_id;
  return resolvingActorId && activeHelpers.has(resolvingActorId) ? resolvingActorId : null;
}

// WHY: the decision is pure data so Slack and dashboard share one outcome —
// the caller owns all I/O. `source` is the only thing that distinguishes a
// dashboard resolve from a Slack one; it lands in the audit metadata and
// nowhere in the ticket's domain state.
function finishResolve({ ticket, actorId, resolution, source = null, resolutionMeta = null, client = null }) {
  const resText = resolution || (actorId ? `resolved by <@${actorId}>` : "resolved");
  const ok = db.resolveTicket(ticket.id, resText, actorId || null);
  if (!ok) return { error: "ticket could not be resolved" };
  const updated = db.getTicket(ticket.id);
  const detail = source || resolutionMeta ? { ...(source ? { source } : {}), ...(resolutionMeta || {}) } : null;
  recordTransition(updated, actorId, "resolved", detail);
  let workerId = null;
  try {
    workerId = resolveTicketWorker(ticket, actorId);
    if (workerId) helperRoute.recordResolution({ programId: ticket.program_id, userId: workerId, category: ticket.category });
  } catch (e) {
    log.warn("tickets", `recordResolution failed: ${e.message}`);
  }
  resolutionPipeline.schedule({ ticket: updated, client, actorId, workerId });
  return { updated, cardText: `[Ticket #${updated.id}] Resolved`, ackText: `✅ Resolved${actorId ? ` by <@${actorId}>` : ""}.` };
}

function resolveTicket({ ticketId, actorId = null, resolution = null, source = null, resolutionMeta = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const d = finishResolve({ ticket, actorId, resolution, source, resolutionMeta, client });
  if (d.error) return d;
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: d.updated, program: prog, cardText: d.cardText });
  return { ok: true, ticket: d.updated };
}

// The thread's "Mark as resolved" button. Requester or a program helper only.
// Idempotent: a ticket already resolved returns deduped with no second write
// and no second Slack message.
function publicResolveTicket({ ticketId, actorId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (CLOSED.includes(ticket.status)) return { ok: true, ticket, deduped: true };
  const isRequester = actorId && actorId === ticket.requester_id;
  const isHelper = actorId && isActorAllowed(ticket.program_id, actorId, false);
  if (!isRequester && !isHelper) return { error: "not_authorized" };
  const d = finishResolve({ ticket, actorId, resolution: null, client });
  if (d.error) return d;
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: d.updated, program: prog, cardText: d.cardText });
  return { ok: true, ticket: d.updated };
}

// The resolved message's "Reopen" button. Same authorization as resolve.
// Idempotent via the guarded db call: only a resolved/closed ticket moves, so
// a double-click bumps reopen_count once and posts one "reopened" line.
async function publicReopenTicket({ ticketId, actorId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  const isRequester = actorId && actorId === ticket.requester_id;
  const isHelper = actorId && isActorAllowed(ticket.program_id, actorId, false);
  if (!isRequester && !isHelper) return { error: "not_authorized" };
  if (!CLOSED.includes(ticket.status)) return { ok: true, ticket, deduped: true };
  const ok = db.reopenResolvedTicket(ticketId, actorId || null);
  if (!ok) return { ok: true, ticket: db.getTicket(ticketId), deduped: true };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "reopened", { by: isRequester ? "requester" : "helper" });
  startNewEpoch(updated);
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Reopened` });
  if (client?.chat?.postMessage) {
    try {
      await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel: updated.channel,
        threadTs: updated.thread_ts,
        text: reply.plainDashes(`Ticket reopened${actorId ? ` by <@${actorId}>` : ""}.`),
      });
    } catch (e) {
      log.debug("tickets", `reopen notice failed for #${updated.id}: ${e.message}`);
    }
  }
  return { ok: true, ticket: updated };
}

function assignTicket({ ticketId, actorId = null, assigneeId, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  if (!assigneeId) return { error: "assigneeId required" };
  // WHY: single membership fetch — actor and assignee checks share one read.
  let helpers = [];
  try {
    helpers = db.listHelpers(ticket.program_id);
  } catch (e) {
    log.debug("tickets", `listHelpers failed during assign: ${e.message}`);
  }
  const memberIds = new Set(helpers.map((h) => h.user_id));
  let actorOk = true;
  let assigneeOk = true;
  try {
    if (actorId && helpers.length > 0 && !memberIds.has(actorId) && !(isAdmin && isAdmin(actorId))) actorOk = false;
  } catch (e) {
    log.debug("tickets", `actor isAdmin check failed during assign: ${e.message}`);
  }
  try {
    if (helpers.length > 0 && !memberIds.has(assigneeId) && !(isAdmin && isAdmin(assigneeId))) assigneeOk = false;
  } catch (e) {
    log.debug("tickets", `assignee isAdmin check failed during assign: ${e.message}`);
  }
  if (!actorOk) return { error: "actor is not a helper of this program" };
  if (!assigneeOk) return { error: "assignee is not a helper of this program" };
  const ok = db.assignTicket(ticketId, assigneeId);
  if (!ok) return { error: "ticket is not assignable" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "assigned", { to: assigneeId });
  // A targeted offer: routing (or an organizer via the reassign menu) put this
  // ticket in front of one helper. It becomes a claimed offer only when that
  // helper claims — assignment alone is not an accept.
  try {
    assignmentLifecycle.recordOffer({ ticket: updated, to: assigneeId, source: actorId ? "reassign" : "auto", actorId });
  } catch (e) {
    log.debug("tickets", `assign offer record failed for #${ticketId}: ${e.message}`);
  }
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Assigned to <@${assigneeId}>`).catch(() => {});
  return { ok: true, ticket: updated };
}

function snoozeTicket({ ticketId, actorId = null, until, programId = null, workspaceId = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const untilNum = Number(until);
  if (!until || !Number.isFinite(untilNum) || untilNum <= Date.now()) {
    return { error: "valid future until required" };
  }
  const ok = db.snoozeTicket(ticketId, untilNum);
  if (!ok) return { error: "ticket could not be snoozed" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "snoozed", { until: untilNum });
  return { ok: true, ticket: updated };
}

function duplicateTicket({ ticketId, actorId = null, canonicalId, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const canon = Number(canonicalId);
  if (!canonicalId || !Number.isInteger(canon) || canon === ticketId) return { error: "valid canonicalId required (must differ from the ticket)" };
  const target = db.getTicket(canon);
  if (!target || target.program_id !== ticket.program_id) return { error: "canonical ticket must exist in the same program" };
  const ok = db.markDuplicateTicket(ticketId, canon);
  if (!ok) return { error: "ticket could not be marked duplicate" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "duplicate", { of: canon });
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Duplicate of #${canon}`).catch(() => {});
  return { ok: true, ticket: updated };
}

function escalateStatusTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.escalateTicketStatus(ticketId);
  if (!ok) return { error: "ticket could not be escalated" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "escalated");
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Escalated`).catch(() => {});
  return { ok: true, ticket: updated };
}

function reopenTicket({ ticketId, actorId = null, source = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.reopenTicket(ticketId, actorId || null);
  if (!ok) return { error: "ticket could not be reopened" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "reopened", source ? { source } : null);
  startNewEpoch(updated);
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Reopened` });
  return { ok: true, ticket: updated };
}

function closeTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.closeTicket(ticketId);
  if (!ok) return { error: "ticket could not be closed" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "closed");
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Closed` });
  return { ok: true, ticket: updated };
}

// WHY: dashboard replies post as the program identity, never as the human —
// internal notes must never leak into this path. `source: "dashboard"` adds a
// visible "sent by @helper" line so a requester (and other helpers reading the
// thread) can tell who's actually behind the branded identity; replies coming
// from Slack itself (the reply modal, macros) skip it since the human is
// already the one typing in the thread.
async function replyToTicket({ ticketId, authorId, text, client, programId = null, workspaceId = null, program = null, source = null, requireOpen = false }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId: authorId });
  if (err) return { error: err };
  if (requireOpen && ![...CLAIMABLE, ...WORKABLE, "escalated"].includes(ticket.status)) return { error: "ticket is not open" };
  const clean = String(text || "").trim();
  if (!clean) return { error: "reply text required" };
  const prog = program || programs.get(ticket.program_id);
  if (programs.isShadow(prog)) {
    return { error: "program is in shadow mode — cut over before replying from here" };
  }
  if (!client || !client.chat || typeof client.chat.postMessage !== "function") {
    return { error: "slack client unavailable" };
  }
  const attribution = source === "dashboard" && authorId ? `\n\n_sent by <@${authorId}> via the dashboard_` : "";
  let ts = null;
  try {
    const res = await slackMessages.sendProgramMessage({
      client,
      program: prog,
      channel: ticket.channel,
      threadTs: ticket.thread_ts,
      text: `${reply.plainDashes(clean)}${attribution}`,
    });
    ts = res?.ts || null;
  } catch (e) {
    log.error("tickets", `dashboard reply failed for #${ticketId}: ${e.message}`);
    return { error: e.message };
  }
  db.recordFirstResponse(ticketId, true);
  // Learn from the reply; never fail on it.
  try {
    helperRoute.recordReply({ programId: ticket.program_id, userId: authorId, category: ticket.category });
  } catch (e) {
    log.debug("tickets", `reply expertise record failed for #${ticketId}: ${e.message}`);
  }
  const refreshed = db.getTicket(ticketId);
  recordTransition(refreshed, authorId, "helper_reply", { ts, text: clean });
  try {
    require("./resolutionWatcher").schedule({ ticketId, client, program: prog });
  } catch (e) {
    log.debug("tickets", `resolution watcher schedule failed for #${ticketId}: ${e.message}`);
  }
  return { ok: true, ts, ticket: refreshed };
}

function addInternalNote({ ticketId, authorId, body, programId = null, workspaceId = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId: authorId });
  if (err) return { error: err };
  const clean = String(body || "").trim();
  if (!clean) return { error: "note body required" };
  // WHY: notes stay helper-side — never posted, never fed to answers.
  const id = db.addTicketNote({ ticketId, programId: ticket.program_id, authorId, body: clean });
  if (!id) return { error: "could not save note" };
  recordTransition(ticket, authorId, "note_added", { noteId: id });
  return { ok: true, noteId: id };
}

function parseTicketAction(action, body) {
  const raw = action?.selected_option?.value || action?.value || "";
  const [idStr, extra] = String(raw).split(":");
  return {
    ticketId: Number(idStr),
    actorId: body?.user?.id || null,
    workspaceId: body?.team?.id || body?.team_id || null,
    assigneeId: extra || null,
    triggerId: body?.trigger_id || null,
  };
}

function registerActions(app) {
  app.action("claim_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    await claimTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("unclaim_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await unclaimTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("decline_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    const res = await declineAssignment({ ticketId, actorId, workspaceId, client });
    // Clicker-only acknowledgement so a Decline isn't a silent void — never a
    // channel post, never a ping. Silent on a plain failure, like every other
    // organizer-card action; the one hint is "you already claimed this".
    const channel = body.channel?.id;
    let text = null;
    if (res.ok) text = `Noted — you passed on ticket #${ticketId}. It stays open for the others.`;
    else if (res.error && res.error.startsWith("you have claimed this ticket")) {
      text = "You've claimed this one — use Release if you can't continue.";
    }
    if (!channel || !text || !client?.chat) return;
    try {
      await client.chat.postEphemeral({ channel, user: actorId, text });
    } catch (e) {
      log.debug("tickets", `decline ack failed for #${ticketId}: ${e.message}`);
    }
  });

  app.action("resolve_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await resolveTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("reopen_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await reopenTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("close_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await closeTicket({ ticketId, actorId, workspaceId, client });
  });

  // The thread's "Mark as resolved" — st_resolve is the current id;
  // public_resolve_ticket stays wired for buttons posted before this change.
  const onPublicResolve = async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    const res = await publicResolveTicket({ ticketId, actorId, workspaceId, client });
    if (res.error === "not_authorized") {
      try {
        await client.chat.postEphemeral({
          channel: body.channel?.id,
          user: actorId,
          text: "Only the person who asked, or a helper, can resolve this one.",
        });
      } catch (e) {
        log.debug("tickets", `ephemeral notice failed: ${e.message}`);
      }
    }
  };
  app.action(SUPPORT_RESOLVE_ACTION, onPublicResolve);
  app.action("public_resolve_ticket", onPublicResolve);

  app.action(SUPPORT_REOPEN_ACTION, async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    const res = await publicReopenTicket({ ticketId, actorId, workspaceId, client });
    if (res.error === "not_authorized") {
      try {
        await client.chat.postEphemeral({
          channel: body.channel?.id,
          user: actorId,
          text: "Only the person who asked, or a helper, can reopen this one.",
        });
      } catch (e) {
        log.debug("tickets", `ephemeral notice failed: ${e.message}`);
      }
    }
  });

  app.action("reassign_select", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId, assigneeId } = parseTicketAction(action, body);
    if (!ticketId || !assigneeId) return;
    await assignTicket({ ticketId, actorId, assigneeId, workspaceId, client });
  });

  app.action("reply_ticket_button", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, triggerId } = parseTicketAction(action, body);
    if (!ticketId || !triggerId) return;
    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "ticket_reply_modal_submit",
          private_metadata: JSON.stringify({ ticketId }),
          title: { type: "plain_text", text: `Reply to #${ticketId}`.slice(0, 24) },
          submit: { type: "plain_text", text: "Send" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "reply_block",
              label: { type: "plain_text", text: "Message to the requester" },
              element: { type: "plain_text_input", action_id: "reply_text", multiline: true },
            },
          ],
        },
      });
    } catch (e) {
      log.warn("tickets", `failed to open reply modal for #${ticketId}: ${e.message}`);
    }
  });

  app.view("ticket_reply_modal_submit", async ({ ack, body, view, client }) => {
    let ticketId = null;
    try {
      ({ ticketId } = JSON.parse(view.private_metadata || "{}"));
    } catch (e) {
      log.debug("tickets", `failed to parse view metadata: ${e.message}`);
      await ack({ response_action: "errors", errors: { reply_block: "could not read ticket — reopen and try again" } });
      return;
    }
    const text = view.state.values.reply_block?.reply_text?.value || "";
    const userId = body.user?.id;
    const workspaceId = body.team?.id || null;
    const res = await replyToTicket({ ticketId: Number(ticketId), authorId: userId, text, client, workspaceId });
    if (res.error) {
      await ack({ response_action: "errors", errors: { reply_block: res.error.slice(0, 100) } });
      return;
    }
    await ack();
  });
}

module.exports = {
  buildTicketCardBlocks,
  escalateTicket,
  ensureSupportTicket,
  supportTicketBlocks,
  syncSupportTicketUI,
  reconcileTicketUI,
  markWaitingForHelper,
  pingRecommendedHelper,
  handOffToHelper,
  pingThreadHelper,
  noteThreadActivity,
  getOrganizerChannel,
  getTicketCardDestination,
  claimTicket,
  unclaimTicket,
  declineAssignment,
  resolveTicket,
  publicResolveTicket,
  publicReopenTicket,
  SUPPORT_RESOLVE_ACTION,
  SUPPORT_REOPEN_ACTION,
  ticketRef,
  friendlyStatusLabel,
  ticketStatusLabel,
  getOrCreateOpenTicket,
  TICKET_STATUS_LABELS,
  assignTicket,
  snoozeTicket,
  duplicateTicket,
  escalateStatusTicket,
  reopenTicket,
  closeTicket,
  replyToTicket,
  addInternalNote,
  registerActions,
  isActorAllowed,
  authorize,
  resolveTicketWorker,
  parseTicketAction,
  ticketPolicy,
  resolveTicketRole,
};
