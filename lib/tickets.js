// Helper Ticket Escalation System.
// Creates, claims, assigns, resolves, reopens, snoozes, and updates helper
// ticket cards in Slack. Every transition writes a ticket_events row and an
// audit_events row so the dashboard timeline and the audit trail stay in sync.
const db = require("./db");
const reply = require("./reply");
const log = require("./log");
const slackMessages = require("./slackMessages");
const { config, isAdmin } = require("./config");
const programs = require("./programs");

function isActorAllowed(programId, actorId) {
  if (!actorId) return false;
  try {
    if (isAdmin && isAdmin(actorId)) return true;
  } catch (_) {}
  try {
    if (db.isHelper(programId, actorId)) return true;
  } catch (_) {}
  return false;
}

function getOrganizerChannel(program, workspaceId = null) {
  if (!program) return null;
  const direct = program.organizerChannel || program.organizer_channel || program.organizer_channel_id || program.helperChannel;
  if (direct) return direct;
  if (program.id) {
    try {
      const channels = db.listProgramChannels(program.id);
      const ws = workspaceId || program.workspaceId || program.workspace_id;
      const match = channels.find((c) => c.kind === "organizer" && (!ws || c.workspace_id === ws));
      if (match) return match.channel_id;
      const anyOrg = channels.find((c) => c.kind === "organizer");
      if (anyOrg) return anyOrg.channel_id;
    } catch (_) {}
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
    require("./audit").record({
      programId: ticket.program_id,
      actorId,
      action: `ticket.${eventType}`,
      entityType: "ticket",
      entityId: ticket.id,
      metadata: detail,
    });
  } catch (_) {}
}

function buildTicketCardBlocks(ticket, program) {
  const statusEmoji =
    ticket.status === "claimed"
      ? ":eyes:"
      : ticket.status === "resolved"
      ? ":white_check_mark:"
      : ticket.status === "closed"
      ? ":x:"
      : ":sos:";

  const progName = program ? program.name : ticket.program_id || "YSWS";
  const assigneeStr = ticket.assignee_id ? ` • Claimed by <@${ticket.assignee_id}>` : "";
  const statusStr = `*Status*: ${statusEmoji} \`${ticket.status}\`${assigneeStr}`;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `[${progName}] Ticket #${ticket.id}` },
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

  if (ticket.status === "open") {
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
      ],
    });
  } else if (ticket.status === "claimed") {
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
      ],
    });
  } else if (ticket.status === "resolved" || ticket.status === "closed") {
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

  return blocks;
}

async function updateTicketCardInSlack({ client, ticket, program, text }) {
  if (!client?.chat?.update || !ticket?.card_ts) return;
  const prog = program || (ticket.program_id ? programs.get(ticket.program_id) : null) || (ticket.program_id ? { id: ticket.program_id } : null);
  const organizerChannel = getOrganizerChannel(prog, ticket.workspace_id);
  if (!organizerChannel) {
    log.debug("tickets", `cannot update card for ticket #${ticket.id}: no organizer channel`);
    return;
  }
  try {
    await client.chat.update({
      channel: organizerChannel,
      ts: ticket.card_ts,
      text: reply.plainDashes(text),
      blocks: reply.plainDashesInBlocks(buildTicketCardBlocks(ticket, prog)),
    });
  } catch (e) {
    log.debug("tickets", `failed updating ticket card in ${organizerChannel}: ${e.message}`);
  }
}

async function escalateTicket({ program, channel, threadTs, requesterId, question, client, workspaceId = null, placeholder = null }) {
  let ticket = db.getTicketByThreadTs(threadTs, workspaceId);
  if (ticket) {
    if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
    return ticket;
  }

  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  const programId = prog ? prog.id : "pixl";
  const resolvedWorkspaceId = workspaceId || (prog ? (prog.workspaceId || prog.workspace_id || null) : null);

  if (!programs.ticketsEnabled(programId)) {
    log.debug("tickets", `tickets disabled for program ${programId} — no ticket opened`);
    if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
    return null;
  }

  // Passive programs never auto-open tickets unprompted
  if (prog && prog.posture === "passive") {
    log.debug("tickets", `skipping unprompted ticket for passive program ${prog.id}`);
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
  recordTransition(ticket, requesterId, "created", { channel, workspaceId: resolvedWorkspaceId });

  // Recommend-only by default; auto-assign runs only when the program
  // explicitly enables it — and even then it is a recorded assignment the
  // helper can undo, not a silent claim.
  if (prog && prog.autoAssign === true) {
    try {
      const [top] = require("./helperRoute").recommend({ programId, category: ticket.category, limit: 1 });
      if (top && db.assignTicket(id, top.userId)) {
        ticket = db.getTicket(id);
        recordTransition(ticket, null, "assigned", { to: top.userId, automatic: true });
      }
    } catch (_) {}
  }

  // Short in-thread acknowledgement so the requester is not left guessing.
  // Branded, factual, no buttons: state changes stay on helper/dashboard paths
  // (plus automatic reopen when the requester writes back).
  if (client && (prog.autoEscalate === undefined || prog.autoEscalate !== false)) {
    try {
      const wait = require("./waitTime");
      const est = wait.estimate({ programId, category: ticket.category, ticketId: id });
      const waitLine = wait.formatWait(est) ? `\nA helper ${wait.formatWait(est)} responds here.` : "";
      const ackText = reply.plainDashes(`Got it — I've flagged this for a ${prog.supportName || prog.name + " helper"}.${waitLine}\nI'll update this thread when someone picks it up.`);
      if (placeholder) {
        await reply.finalize(client, channel, threadTs, placeholder, ackText, { program: prog });
      } else {
        await slackMessages.sendProgramMessage({
          client,
          program: prog,
          channel,
          threadTs,
          text: ackText,
        });
      }
      db.recordFirstResponse(id, false);
    } catch (e) {
      log.debug("tickets", `ack failed for #${id}: ${e.message}`);
    }
  } else if (placeholder) {
    await reply.discardPlaceholder(client, channel, placeholder);
  }

  // Route ticket card strictly to the program's organizer channel.
  // Never route to the public help channel or fall back to it on error.
  const organizerChannel = getOrganizerChannel(prog, resolvedWorkspaceId);
  if (!organizerChannel) {
    log.error("tickets", `no organizer channel configured for program ${programId} — ticket #${ticket.id} card not posted`);
  } else if (client && client.chat && client.chat.postMessage) {
    try {
      const cardBlocks = reply.plainDashesInBlocks(buildTicketCardBlocks(ticket, prog));
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

  log.info("tickets", `created ticket #${ticket.id} for ${programId} in ${channel}`);
  return ticket;
}

// A requester writing again in their resolved/closed ticket's thread reopens
// it: "still broken" is a reopen, not a new ticket. Helper/assignee chatter
// never reopens — only the requester's own voice.
function noteThreadActivity({ channel, threadTs, userId, workspaceId = null }) {
  if (!threadTs || !userId) return null;
  const ticket = db.getTicketByThreadTs(threadTs, workspaceId);
  if (!ticket) return null;
  if (ticket.status !== "resolved" && ticket.status !== "closed") return ticket;
  if (userId !== ticket.requester_id) return ticket;
  db.reopenTicket(ticket.id);
  recordTransition(db.getTicket(ticket.id), userId, "reopened", { by: "requester" });
  log.info("tickets", `reopened ticket #${ticket.id} on requester activity`);
  return db.getTicket(ticket.id);
}

// Multi-tenant ticket organizer operations: Claim, Unclaim, Resolve, Assign, Snooze, Reopen, Close
async function claimTicket({ ticketId, actorId, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) return { error: "program mismatch" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (actorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const ok = db.claimTicket(ticketId, actorId);
  if (!ok) return { error: "ticket is not open" };

  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "claimed");

  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) {
    await updateTicketCardInSlack({
      client,
      ticket: updated,
      program: prog,
      text: `[Ticket #${updated.id}] Claimed by <@${actorId}>`,
    });
  }
  return { ok: true, ticket: updated };
}

async function unclaimTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) return { error: "program mismatch" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (actorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const ok = db.unclaimTicket(ticketId);
  if (!ok) return { error: "ticket could not be unclaimed" };

  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "unclaimed");

  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) {
    await updateTicketCardInSlack({
      client,
      ticket: updated,
      program: prog,
      text: `[Ticket #${updated.id}] Unclaimed`,
    });
  }
  return { ok: true, ticket: updated };
}

async function resolveTicket({ ticketId, actorId = null, resolution = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) return { error: "program mismatch" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (actorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const resText = resolution || (actorId ? `resolved by <@${actorId}>` : "resolved");
  const ok = db.resolveTicket(ticketId, resText);
  if (!ok) return { error: "ticket could not be resolved" };

  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "resolved");
  try {
    require("./helperRoute").recordResolution({ programId: ticket.program_id, userId: ticket.assignee_id || actorId, category: ticket.category });
  } catch (_) {}

  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) {
    await updateTicketCardInSlack({
      client,
      ticket: updated,
      program: prog,
      text: `[Ticket #${updated.id}] Resolved`,
    });
  }
  return { ok: true, ticket: updated };
}

async function assignTicket({ ticketId, actorId = null, assigneeId, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) return { error: "program mismatch" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (!assigneeId) return { error: "assigneeId required" };
  if (actorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  if (db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, assigneeId)) {
    return { error: "assignee is not a helper of this program" };
  }
  const ok = db.assignTicket(ticketId, assigneeId);
  if (!ok) return { error: "ticket is not assignable" };

  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "assigned", { to: assigneeId });

  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) {
    await updateTicketCardInSlack({
      client,
      ticket: updated,
      program: prog,
      text: `[Ticket #${updated.id}] Assigned to <@${assigneeId}>`,
    });
  }
  return { ok: true, ticket: updated };
}

function snoozeTicket({ ticketId, actorId = null, until, programId = null, workspaceId = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) return { error: "program mismatch" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (actorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
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

async function reopenTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) return { error: "program mismatch" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (actorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const ok = db.reopenTicket(ticketId);
  if (!ok) return { error: "ticket could not be reopened" };

  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "reopened");

  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) {
    await updateTicketCardInSlack({
      client,
      ticket: updated,
      program: prog,
      text: `[Ticket #${updated.id}] Reopened`,
    });
  }
  return { ok: true, ticket: updated };
}

async function closeTicket({ ticketId, actorId = null, programId = null, workspaceId = null, client = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) return { error: "program mismatch" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (actorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const ok = db.closeTicket(ticketId);
  if (!ok) return { error: "ticket could not be closed" };

  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "closed");

  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) {
    await updateTicketCardInSlack({
      client,
      ticket: updated,
      program: prog,
      text: `[Ticket #${updated.id}] Closed`,
    });
  }
  return { ok: true, ticket: updated };
}

// Authorized dashboard/helper → requester reply. Sends through the
// central program-branded abstraction (never as the human helper), posts into
// the requester's original thread in the help channel, and records the reply
// in the ticket timeline + audit. Internal notes are NEVER leaked.
async function replyToTicket({ ticketId, authorId, text, client, programId = null, workspaceId = null, program = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) {
    return { error: "program mismatch" };
  }
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) {
    return { error: "workspace mismatch" };
  }
  if (authorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, authorId)) {
    return { error: "actor is not a helper of this program" };
  }

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
  recordTransition(ticket, authorId, "helper_reply", { ts });
  return { ok: true, ts, ticket: db.getTicket(ticketId) };
}

function addInternalNote({ ticketId, authorId, body, programId = null, workspaceId = null }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (programId && ticket.program_id !== programId) {
    return { error: "program mismatch" };
  }
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) {
    return { error: "workspace mismatch" };
  }
  if (authorId && db.listHelpers(ticket.program_id).length > 0 && !isActorAllowed(ticket.program_id, authorId)) {
    return { error: "actor is not a helper of this program" };
  }

  const clean = String(body || "").trim();
  if (!clean) return { error: "note body required" };
  // Notes stay helper-side: never posted to Slack, never fed to requester
  // answers — visible only through authorized ticket reads.
  const id = db.addTicketNote({ ticketId, programId: ticket.program_id, authorId, body: clean });
  if (!id) return { error: "could not save note" };
  recordTransition(ticket, authorId, "note_added", { noteId: id });
  return { ok: true, noteId: id };
}

function registerActions(app) {
  app.action("claim_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId || !userId) return;

    const workspaceId = body.team?.id || body.team_id || null;
    await claimTicket({ ticketId, actorId: userId, workspaceId, client });
  });

  app.action("unclaim_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    const workspaceId = body.team?.id || body.team_id || null;
    await unclaimTicket({ ticketId, actorId: userId, workspaceId, client });
  });

  app.action("resolve_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    const workspaceId = body.team?.id || body.team_id || null;
    await resolveTicket({ ticketId, actorId: userId, workspaceId, client });
  });

  app.action("reopen_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    const workspaceId = body.team?.id || body.team_id || null;
    await reopenTicket({ ticketId, actorId: userId, workspaceId, client });
  });

  app.action("close_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    const workspaceId = body.team?.id || body.team_id || null;
    await closeTicket({ ticketId, actorId: userId, workspaceId, client });
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
  assignTicket,
  snoozeTicket,
  reopenTicket,
  closeTicket,
  replyToTicket,
  addInternalNote,
  registerActions,
};
