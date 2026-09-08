const db = require("./db");
const reply = require("./reply");
const log = require("./log");
const slackMessages = require("./slackMessages");
const { config, isAdmin } = require("./config");
const programs = require("./programs");
const audit = require("./audit");
const helperRoute = require("./helperRoute");
const incidents = require("./incidents");
const waitTime = require("./waitTime");

const CLAIMABLE = ["open", "waiting_for_helper"];
const WORKABLE = ["claimed", "assigned"];
const CLOSED = ["resolved", "closed"];
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
          text: { type: "plain_text", text: "↩️ Unclaim" },
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
        list = helperRoute.recommend({ programId: ticket.program_id, category: ticket.category, limit: 5 });
      } catch (e) {
        log.debug("tickets", `helper recommendation failed: ${e.message}`);
        list = [];
      }
    }
    const filtered = (list || []).filter((r) => r.userId !== ticket.assignee_id);
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
  ai_answered: "Answered by Pixie",
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

const TERMINAL_TICKET_STATUSES = ["resolved", "closed", "duplicate", "spam"];

// The canonical user-facing ticket identifier — always the numeric primary
// key, never a Slack channel/routing id.
function ticketRef(ticket) {
  const n = Number(ticket && ticket.id);
  return Number.isInteger(n) && n > 0 ? `#${n}` : "";
}

// WHY: every public message carries one footer so the label can never drift
// from the real status column.
//
// verbatim:true is load-bearing here. Without it Slack's mrkdwn parser reads
// the bare `#17` as a channel name and rewrites it to `<#C0…>` on send — a
// real workspace has channels named for small numbers — so the public thread
// showed `Ticket <#C0975EV1YNB>` while the organizer card (plain_text, never
// parsed) correctly showed `Ticket #17`. verbatim disables that auto-linking
// while still rendering the bold/emoji in this fixed status string.
function buildTicketFooterBlocks(ticket) {
  const label = TICKET_STATUS_LABELS[ticket.status] || ticket.status;
  const icon = ticket.status === "ai_answered" ? "✓ " : ticket.status === "resolved" ? "✅ " : "";
  const ref = ticketRef(ticket);
  const heading = ref ? `*Ticket ${ref}* · ${icon}${label}` : `*Ticket* · ${icon}${label}`;
  const blocks = [{ type: "context", elements: [{ type: "mrkdwn", text: heading, verbatim: true }] }];
  if (!TERMINAL_TICKET_STATUSES.includes(ticket.status)) {
    blocks.push({
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "✅ Resolve" }, value: String(ticket.id), action_id: "public_resolve_ticket" }],
    });
  }
  return blocks;
}

// WHY: callers must see the footer for the status already stored, never what
// it is about to become — so this runs AFTER any transition.
function buildPublicAckBlocks(ticket, bodyText) {
  return [{ type: "section", text: { type: "mrkdwn", text: bodyText } }, ...buildTicketFooterBlocks(ticket)];
}

async function syncSlack({ client, channel, ts, text, blocks }) {
  if (!client?.chat?.update || !channel || !ts) return;
  try {
    await client.chat.update({
      channel,
      ts,
      text: reply.plainDashes(text),
      blocks: reply.plainDashesInBlocks(blocks),
    });
  } catch (e) {
    log.debug("tickets", `slack sync failed: ${e.message}`);
  }
}

async function syncCard(client, ticket, text) {
  if (!client || !ticket?.card_ts) return;
  const prog = ticket.program_id ? programs.get(ticket.program_id) : null;
  const base = prog || (ticket.program_id ? { id: ticket.program_id } : null);
  const organizerChannel = getOrganizerChannel(base, ticket.workspace_id);
  if (!organizerChannel) {
    log.debug("tickets", `cannot update card for ticket #${ticket.id}: no organizer channel`);
    return;
  }
  let candidates = [];
  try {
    candidates = helperRoute.recommend({ programId: ticket.program_id, category: ticket.category, limit: 5 });
  } catch (e) {
    log.debug("tickets", `helper recommendation failed: ${e.message}`);
  }
  const blocks = buildTicketCardBlocks(ticket, base, candidates);
  await syncSlack({ client, channel: organizerChannel, ts: ticket.card_ts, text, blocks });
}

async function syncAck(client, ticket, text) {
  if (!client || !ticket?.public_ack_ts) return;
  const blocks = buildPublicAckBlocks(ticket, text);
  await syncSlack({ client, channel: ticket.channel, ts: ticket.public_ack_ts, text, blocks });
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
    if (ticket) db.markTicketAiAnswered(ticket.id);
    const forFooter = ticket ? db.getTicket(ticket.id) : null;
    const blocks = forFooter ? buildPublicAckBlocks(forFooter, text) : null;
    if (placeholder) {
      await reply.finalize(client, channel, threadTs, placeholder, text, { blocks, program: prog });
    } else {
      await slackMessages.sendProgramMessage({ client, program: prog, channel, threadTs, text, blocks: blocks ? reply.plainDashesInBlocks(blocks) : null });
    }
    if (incidentMode === "ANSWER_AND_TRACK") {
      incidents.recordAffectedReport({ incidentId: matched.id, programId, requesterId, channel, threadTs });
    }
    log.info("tickets", `answered from active incident #${matched.id} instead of escalating (${programId})`);
    return { done: true, ticket: forFooter || null };
  } catch (e) {
    log.warn("tickets", `incident-aware reply failed, falling back to a normal escalation: ${e.message}`);
    return { done: false };
  }
}

async function ensureTicket({ prog, programId, resolvedWorkspaceId, channel, threadTs, requesterId, question, placeholder, client, ticket, isPromotion }) {
  if (!ticket) {
    if (!programs.ticketsEnabled(programId)) {
      log.debug("tickets", `tickets disabled for program ${programId} — no ticket opened`);
      if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
      return null;
    }
    if (prog && prog.posture === "passive") {
      log.debug("tickets", `skipping unprompted ticket for passive program ${prog.id}`);
      if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
      return null;
    }
    // WHY: publicTicketsEnabled is scoped to the help channel only — noisy
    // launch days must not disable tickets everywhere.
    if (prog?.publicTicketsEnabled === false && channel && programs.isHelpChannel(channel, resolvedWorkspaceId)) {
      log.debug("tickets", `public ticket creation is off for ${programId} — no ticket opened for ${channel}`);
      if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
      return null;
    }
    const id = db.createTicket({
      programId,
      workspaceId: resolvedWorkspaceId,
      channel,
      threadTs,
      requesterId,
      question,
    });
    if (!id) {
      if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
      return null;
    }
    ticket = db.getTicket(id);
    // WHY: concurrent winner may have already recorded created — re-read
    // keeps the timeline to exactly one created row.
    if (!db.listTicketEvents(id).some((e) => e.event_type === "created")) {
      recordTransition(ticket, requesterId, "created", { channel, workspaceId: resolvedWorkspaceId });
    }
  }
  const id = ticket.id;
  db.markTicketWaitingForHelper(id);
  let promoted = db.getTicket(id);
  recordTransition(promoted, requesterId, "escalated", { channel, workspaceId: resolvedWorkspaceId, promoted: isPromotion });
  // WHY: recommend-only by default — auto-assign is a recorded assignment
  // the helper can undo, never a silent claim.
  if (prog && prog.autoAssign === true) {
    try {
      const [top] = helperRoute.recommend({ programId, category: promoted.category, limit: 1 });
      if (top && db.assignTicket(id, top.userId)) {
        promoted = db.getTicket(id);
        recordTransition(promoted, null, "assigned", { to: top.userId, automatic: true });
      }
    } catch (e) {
      log.warn("tickets", `auto-assign failed: ${e.message}`);
    }
  }
  return db.getTicket(id);
}

async function ackTicket({ prog, programId, ticket, client, channel, threadTs, placeholder }) {
  const id = ticket.id;
  if (client && (prog.autoEscalate === undefined || prog.autoEscalate !== false)) {
    try {
      const est = waitTime.estimate({ programId, category: ticket.category, ticketId: id });
      const waitLine = waitTime.formatWait(est) ? `\nA helper ${waitTime.formatWait(est)} responds here.` : "";
      const ackText = reply.plainDashes(`Got it — I've flagged this for the support team.${waitLine}\nI'll update this thread when someone picks it up.`);
      const ackBlocks = buildPublicAckBlocks(ticket, ackText);
      let ackTs = null;
      if (placeholder) {
        ackTs = await reply.finalize(client, channel, threadTs, placeholder, ackText, { blocks: ackBlocks, program: prog });
      } else {
        const res = await slackMessages.sendProgramMessage({
          client,
          program: prog,
          channel,
          threadTs,
          text: ackText,
          blocks: reply.plainDashesInBlocks(ackBlocks),
        });
        ackTs = res?.ts || null;
      }
      if (ackTs) db.updatePublicAckTs(id, ackTs);
      db.recordFirstResponse(id, false);
    } catch (e) {
      log.debug("tickets", `ack failed for #${id}: ${e.message}`);
    }
  } else if (placeholder) {
    await reply.discardPlaceholder(client, channel, placeholder);
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
        candidates = helperRoute.recommend({ programId, category: ticket.category, limit: 5 });
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
        db.updateTicketCardTs(ticket.id, res.ts);
        ticket.card_ts = res.ts;
      }
    } catch (e) {
      log.error("tickets", `failed to post ticket card to organizer channel ${organizerChannel} for program ${programId}: ${e.message}`);
    }
  }
  return ticket;
}

// WHY: a promotion, never a demotion — past waiting the ticket is left alone.
async function escalateTicket({ program, channel, threadTs, requesterId, question, client, workspaceId = null, placeholder = null, bypassIncidentMatch = false }) {
  let ticket = db.getTicketByThreadTs(threadTs, workspaceId);
  if (ticket && !["open", "ai_answered"].includes(ticket.status)) {
    if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
    return ticket;
  }
  const isPromotion = !!ticket;
  const { prog, programId, resolvedWorkspaceId } = resolveProg({ program, channel, workspaceId });
  const inc = await checkIncident({ prog, programId, question, ticket, client, channel, threadTs, requesterId, resolvedWorkspaceId, placeholder, bypassIncidentMatch });
  if (inc.done) return inc.ticket;
  ticket = await ensureTicket({ prog, programId, resolvedWorkspaceId, channel, threadTs, requesterId, question, placeholder, client, ticket, isPromotion });
  if (!ticket) return null;
  await ackTicket({ prog, programId, ticket, client, channel, threadTs, placeholder });
  ticket = db.getTicket(ticket.id);
  await postCard({ prog, programId, resolvedWorkspaceId, ticket, client, requesterId, question });
  ticket = db.getTicket(ticket.id);
  log.info("tickets", `${isPromotion ? "escalated" : "created"} ticket #${ticket.id} for ${programId} in ${channel}`);
  return ticket;
}

// WHY: per-question record vs human paging intentionally disagree on passive
// and non-help — shared so the two can never drift on ticketsEnabled.
function ticketCreationAllowed({ prog, channel, workspaceId = null }) {
  if (!prog) return false;
  if (!programs.ticketsEnabled(prog.id)) return false;
  if (prog.publicTicketsEnabled === false) return false;
  if (channel && !programs.isHelpChannel(channel, workspaceId)) return false;
  return true;
}

function getOrCreateOpenTicket({ program, channel, threadTs, requesterId, question, workspaceId = null }) {
  if (!threadTs) return null;
  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  const resolvedWorkspaceId = workspaceId || (prog ? prog.workspaceId || prog.workspace_id || null : null);
  const existing = db.getTicketByThreadTs(threadTs, resolvedWorkspaceId);
  if (existing) return existing;
  if (!ticketCreationAllowed({ prog, channel, workspaceId: resolvedWorkspaceId })) return null;
  const id = db.createTicket({ programId: prog.id, workspaceId: resolvedWorkspaceId, channel, threadTs, requesterId, question });
  if (!id) return db.getTicketByThreadTs(threadTs, resolvedWorkspaceId);
  const ticket = db.getTicket(id);
  if (!db.listTicketEvents(id).some((e) => e.event_type === "created")) {
    recordTransition(ticket, requesterId, "created", { channel, workspaceId: resolvedWorkspaceId, source: "eligible_question" });
  }
  return db.getTicket(id) || ticket;
}

// WHY: ai_answered never demotes an escalated ticket — already past open is
// left alone, and first response only counts when the promotion actually ran.
function markTicketAiAnswered({ ticketId }) {
  if (!ticketId) return null;
  const changed = db.markTicketAiAnswered(ticketId);
  if (changed) db.recordFirstResponse(ticketId, false);
  const ticket = db.getTicket(ticketId);
  if (changed && ticket) recordTransition(ticket, null, "ai_answered");
  return ticket;
}

// WHY: "still broken" from the requester is a reopen, never a new ticket —
// helper chatter must not reopen.
function noteThreadActivity({ channel, threadTs, userId, workspaceId = null }) {
  if (!threadTs || !userId) return null;
  const ticket = db.getTicketByThreadTs(threadTs, workspaceId);
  if (!ticket) return null;
  if (ticket.status !== "resolved" && ticket.status !== "closed") return ticket;
  if (userId !== ticket.requester_id) return ticket;
  db.reopenTicket(ticket.id);
  const updated = db.getTicket(ticket.id);
  recordTransition(updated, userId, "reopened", { by: "requester" });
  log.info("tickets", `reopened ticket #${ticket.id} on requester activity`);
  return updated;
}

function claimTicket({ ticketId, actorId, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.claimTicket(ticketId, actorId);
  if (!ok) return { error: "ticket is not open" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "claimed");
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Claimed by <@${actorId}>`).catch(() => {});
  return { ok: true, ticket: updated };
}

function unclaimTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.unclaimTicket(ticketId);
  if (!ok) return { error: "ticket could not be unclaimed" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "unclaimed");
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Unclaimed`).catch(() => {});
  return { ok: true, ticket: updated };
}

// WHY: the decision is pure data so Slack and dashboard share one outcome —
// the caller owns all I/O.
function finishResolve({ ticket, actorId, resolution }) {
  const resText = resolution || (actorId ? `resolved by <@${actorId}>` : "resolved");
  const ok = db.resolveTicket(ticket.id, resText);
  if (!ok) return { error: "ticket could not be resolved" };
  const updated = db.getTicket(ticket.id);
  recordTransition(updated, actorId, "resolved");
  try {
    helperRoute.recordResolution({ programId: ticket.program_id, userId: ticket.assignee_id || actorId, category: ticket.category });
  } catch (e) {
    log.warn("tickets", `recordResolution failed: ${e.message}`);
  }
  return { updated, cardText: `[Ticket #${updated.id}] Resolved`, ackText: `✅ Resolved${actorId ? ` by <@${actorId}>` : ""}.` };
}

function resolveTicket({ ticketId, actorId = null, resolution = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const d = finishResolve({ ticket, actorId, resolution });
  if (d.error) return d;
  const prog = program || programs.get(ticket.program_id);
  if (client && d.updated.card_ts) void syncCard(client, d.updated, d.cardText).catch(() => {});
  if (client && d.updated.public_ack_ts) void syncAck(client, d.updated, d.ackText).catch(() => {});
  return { ok: true, ticket: d.updated };
}

function publicResolveTicket({ ticketId, actorId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (ticket.status === "resolved" || ticket.status === "closed") return { ok: true, ticket, deduped: true };
  const isRequester = actorId && actorId === ticket.requester_id;
  const isHelper = actorId && isActorAllowed(ticket.program_id, actorId, false);
  if (!isRequester && !isHelper) return { error: "not_authorized" };
  const d = finishResolve({ ticket, actorId, resolution: null });
  if (d.error) return d;
  const prog = program || programs.get(ticket.program_id);
  if (client && d.updated.card_ts) void syncCard(client, d.updated, d.cardText).catch(() => {});
  if (client && d.updated.public_ack_ts) void syncAck(client, d.updated, d.ackText).catch(() => {});
  return { ok: true, ticket: d.updated };
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

function reopenTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.reopenTicket(ticketId);
  if (!ok) return { error: "ticket could not be reopened" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "reopened");
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Reopened`).catch(() => {});
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
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Closed`).catch(() => {});
  return { ok: true, ticket: updated };
}

// WHY: dashboard replies post as the program identity, never as the human —
// internal notes must never leak into this path.
async function replyToTicket({ ticketId, authorId, text, client, programId = null, workspaceId = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId: authorId });
  if (err) return { error: err };
  const clean = String(text || "").trim();
  if (!clean) return { error: "reply text required" };
  const prog = program || programs.get(ticket.program_id);
  if (programs.isShadow(prog)) {
    return { error: "program is in shadow mode — cut over before replying from here" };
  }
  if (!client || !client.chat || typeof client.chat.postMessage !== "function") {
    return { error: "slack client unavailable" };
  }
  let ts = null;
  try {
    const res = await slackMessages.sendProgramMessage({
      client,
      program: prog,
      channel: ticket.channel,
      threadTs: ticket.thread_ts,
      text: reply.plainDashes(clean),
    });
    ts = res?.ts || null;
  } catch (e) {
    log.error("tickets", `dashboard reply failed for #${ticketId}: ${e.message}`);
    return { error: e.message };
  }
  db.recordFirstResponse(ticketId, true);
  const refreshed = db.getTicket(ticketId);
  recordTransition(refreshed, authorId, "helper_reply", { ts });
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

  app.action("public_resolve_ticket", async ({ action, body, ack, client }) => {
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
  noteThreadActivity,
  getOrganizerChannel,
  getTicketCardDestination,
  claimTicket,
  unclaimTicket,
  resolveTicket,
  publicResolveTicket,
  buildPublicAckBlocks,
  buildTicketFooterBlocks,
  ticketRef,
  friendlyStatusLabel,
  getOrCreateOpenTicket,
  markTicketAiAnswered,
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
  parseTicketAction,
};
