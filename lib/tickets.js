// Helper Ticket Escalation System.
// Creates, claims, assigns, resolves, reopens, snoozes, and updates helper
// ticket cards in Slack. Every transition writes a ticket_events row and an
// audit_events row so the dashboard timeline and the audit trail stay in sync.
const db = require("./db");
const reply = require("./reply");
const log = require("./log");
const slackMessages = require("./slackMessages");
const { config } = require("./config");
const programs = require("./programs");

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
        text: `*Question*: ${ticket.question}\n*Requester*: <@${ticket.requester_id}> in <#${ticket.channel}>`,
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

async function escalateTicket({ program, channel, threadTs, requesterId, question, client, workspaceId = null }) {
  let ticket = db.getTicketByThreadTs(threadTs, workspaceId);
  if (ticket) return ticket;

  const prog = program || programs.forChannel(channel, workspaceId);
  const programId = prog ? prog.id : "pixl";

  if (!programs.ticketsEnabled(programId)) {
    log.debug("tickets", `tickets disabled for program ${programId} — no ticket opened`);
    return null;
  }

  // Passive programs never auto-open tickets unprompted
  if (prog && prog.posture === "passive") {
    log.debug("tickets", `skipping unprompted ticket for passive program ${prog.id}`);
    return null;
  }

  const id = db.createTicket({
    programId,
    workspaceId,
    channel,
    threadTs,
    requesterId,
    question,
  });

  if (!id) return null;
  ticket = db.getTicket(id);
  recordTransition(ticket, requesterId, "created", { channel, workspaceId });

  // Recommend-only by default; auto-assign runs only when the program
  // explicitly enables it — and even then it is a recorded assignment the
  // helper can undo, not a silent claim.
  if (prog.autoAssign === true) {
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
      await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel,
        threadTs,
        text: reply.plainDashes(`Got it — I've flagged this for a ${prog.supportName || prog.name + " helper"}.${waitLine}\nI'll update this thread when someone picks it up.`),
      });
      db.recordFirstResponse(id, false);
    } catch (e) {
      log.debug("tickets", `ack failed for #${id}: ${e.message}`);
    }
  }

  const helperChannel = prog.helpChannel || config.slack.helpChannel;
  if (client && helperChannel && client.chat && client.chat.postMessage) {
    try {
      const cardBlocks = reply.plainDashesInBlocks(buildTicketCardBlocks(ticket, prog));
      const res = await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel: helperChannel,
        text: reply.plainDashes(`[Ticket #${ticket.id}] <@${requesterId}> asked: "${question.slice(0, 100)}"`),
        blocks: cardBlocks,
      });
      if (res?.ts) {
        db.updateTicketCardTs(ticket.id, res.ts);
        ticket.card_ts = res.ts;
      }
    } catch (e) {
      log.error("tickets", `failed to post ticket card: ${e.message}`);
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

// Amendment 3: authorized dashboard → requester reply. Sends through the
// central program-branded abstraction (never as the human helper), posts into
// the requester thread, and records the reply in the ticket timeline + audit.
async function replyToTicket({ ticketId, authorId, text, client }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  const clean = String(text || "").trim();
  if (!clean) return { error: "reply text required" };
  const prog = programs.get(ticket.program_id);

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

function addInternalNote({ ticketId, authorId, body }) {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
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

    const ok = db.claimTicket(ticketId, userId);
    if (!ok) return;

    const ticket = db.getTicket(ticketId);
    recordTransition(ticket, userId, "claimed");
    const prog = programs.get(ticket.program_id);
    const helperChannel = prog?.helpChannel || config.slack.helpChannel;

    if (ticket.card_ts && helperChannel) {
      try {
        await client.chat.update({
          channel: helperChannel,
          ts: ticket.card_ts,
          text: `[Ticket #${ticket.id}] Claimed by <@${userId}>`,
          blocks: buildTicketCardBlocks(ticket, prog),
        });
      } catch (e) {
        log.debug("tickets", `failed updating ticket card: ${e.message}`);
      }
    }
  });

  app.action("unclaim_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    const ok = db.unclaimTicket(ticketId);
    if (!ok) return;

    const ticket = db.getTicket(ticketId);
    recordTransition(ticket, userId, "unclaimed");
    const prog = programs.get(ticket.program_id);
    const helperChannel = prog?.helpChannel || config.slack.helpChannel;

    if (ticket.card_ts && helperChannel) {
      try {
        await client.chat.update({
          channel: helperChannel,
          ts: ticket.card_ts,
          text: `[Ticket #${ticket.id}] Unclaimed`,
          blocks: buildTicketCardBlocks(ticket, prog),
        });
      } catch (e) {
        log.debug("tickets", `failed updating ticket card: ${e.message}`);
      }
    }
  });

  app.action("resolve_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    db.resolveTicket(ticketId, `resolved by <@${userId}>`);
    const ticket = db.getTicket(ticketId);
    recordTransition(ticket, userId, "resolved");
    try {
      require("./helperRoute").recordResolution({ programId: ticket.program_id, userId, category: ticket.category });
    } catch (_) {}
    const prog = programs.get(ticket.program_id);
    const helperChannel = prog?.helpChannel || config.slack.helpChannel;

    if (ticket.card_ts && helperChannel) {
      try {
        await client.chat.update({
          channel: helperChannel,
          ts: ticket.card_ts,
          text: `[Ticket #${ticket.id}] Resolved`,
          blocks: buildTicketCardBlocks(ticket, prog),
        });
      } catch (e) {
        log.debug("tickets", `failed updating ticket card: ${e.message}`);
      }
    }
  });

  app.action("reopen_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    db.reopenTicket(ticketId);
    const ticket = db.getTicket(ticketId);
    recordTransition(ticket, userId, "reopened");
    const prog = programs.get(ticket.program_id);
    const helperChannel = prog?.helpChannel || config.slack.helpChannel;

    if (ticket.card_ts && helperChannel) {
      try {
        await client.chat.update({
          channel: helperChannel,
          ts: ticket.card_ts,
          text: `[Ticket #${ticket.id}] Reopened`,
          blocks: buildTicketCardBlocks(ticket, prog),
        });
      } catch (e) {
        log.debug("tickets", `failed updating ticket card: ${e.message}`);
      }
    }
  });

  app.action("close_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const ticketId = Number(action.value);
    const userId = body.user?.id;
    if (!ticketId) return;

    db.closeTicket(ticketId);
    const ticket = db.getTicket(ticketId);
    recordTransition(ticket, userId, "closed");
    const prog = programs.get(ticket.program_id);
    const helperChannel = prog?.helpChannel || config.slack.helpChannel;

    if (ticket.card_ts && helperChannel) {
      try {
        await client.chat.update({
          channel: helperChannel,
          ts: ticket.card_ts,
          text: `[Ticket #${ticket.id}] Closed`,
          blocks: buildTicketCardBlocks(ticket, prog),
        });
      } catch (e) {
        log.debug("tickets", `failed updating ticket card: ${e.message}`);
      }
    }
  });
}

module.exports = {
  buildTicketCardBlocks,
  escalateTicket,
  noteThreadActivity,
  replyToTicket,
  addInternalNote,
  registerActions,
};
