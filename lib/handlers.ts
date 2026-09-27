// Slack event routing decides whether Pixie should speak; response generation lives elsewhere.
import configModule = require("./config");
import visionModule = require("./vision");
import intent = require("./intent");
import contextModule = require("./context");
import respondModule = require("./respond");
import replyText = require("./reply");
import guidesModule = require("./guides");
import learnModule = require("./learn");
import teachThreadModule = require("./teachThread");
import sumThreadModule = require("./sumThread");
import dbModule = require("./db");
import rateLimitModule = require("./rateLimit");
import log = require("./log");
import programsModule = require("./programs");
import macrosModule = require("./macros");
import channelPolicyModule = require("./channelPolicy");
import workspaceModule = require("./workspace");
import brand = require("./brand");

const { config, isAdmin } = configModule;
const { worthClassifying } = intent;
interface Legacy {
  [key: string]: any;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function errorData(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined;
  const data = (error as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? data as Record<string, unknown> : undefined;
}
const context: Legacy = contextModule as Legacy;
const vision: Legacy = visionModule as Legacy;
const respond: Legacy = respondModule as Legacy;
const guides: Legacy = guidesModule as Legacy;
const learn: Legacy = learnModule as Legacy;
const teachThread: Legacy = teachThreadModule as Legacy;
const sumThread: Legacy = sumThreadModule as Legacy;
const db: Legacy = dbModule as Legacy;
const rateLimit: Legacy = rateLimitModule as Legacy;
const programs: Legacy = programsModule as Legacy;
const macros: Legacy = macrosModule as Legacy;
const channelPolicy: Legacy = channelPolicyModule as Legacy;
const workspace: Legacy = workspaceModule as Legacy;

const DELETE_REACTIONS = new Set(["pixl-delete", "x", "heavy_multiplication_x"]);
const UP_REACTIONS = new Set(["yay", "thumbs-up", "+1", "yesyes", "white_check_mark", "heavy_check_mark", "upvote", "sparkling_heart", "heart", "heart_eyes"]);
const DOWN_REACTIONS = new Set(["nono", "-1", "thumbsdown", "sad-pf"]);
const GUIDE_ADVANCE_REACTION = "upvote";

// Reaction events carry their target channel on event.item, unlike message events.

function escapeRegex(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsPixieByName(text: string): boolean {
  const customNames = (process.env.PIXIE_BOT_ALIASES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const names = [...new Set([brand.name(), brand.slug(), ...customNames])];
  const pattern = require("./eligibility").botNamePattern(names);
  return new RegExp(`\\b(?:${pattern})\\w*\\b`, "i").test(text || "");
}

function teachPattern(mentionOnly = false): RegExp {
  const slug = escapeRegex(brand.slug());
  const base = mentionOnly ? `teach|learn|remember|memorize|!teach|/${slug}-teach` : `!teach|${slug}-teach|/${slug}-teach|teach\\s+this|teach\\s+thread`;
  return new RegExp(`^\\s*(?:${base})\\b`, "i");
}

function stripTeachCommand(text: string, mentionOnly = false): string {
  return String(text || "").replace(teachPattern(mentionOnly), "").trim();
}

function actorRunsCommands(userId: string, prog: Legacy | null): boolean {
  return isAdmin(userId) || (!!prog && db.isHelper(prog.id, userId));
}

function sumPattern(mentionOnly = false): RegExp {
  const slug = escapeRegex(brand.slug());
  const base = mentionOnly
    ? `sum|summary|summarize|summarise|!sum|!summary|!summarize|!summarise|/${slug}-sum`
    : `!sum|!summary|!summarize|!summarise|${slug}-sum|/${slug}-sum|sum\\s+this|sum\\s+thread|summarize\\s+thread|summarise\\s+thread`;
  return new RegExp(`^\\s*(?:${base})\\b`, "i");
}

function mentionsPixieDirectly(text: string): boolean {
  return require("./eligibility").directMention(text, config.slack.botUserId);
}

function stripBotMention(text: string): string {
  return require("./eligibility").stripBotMention(text, config.slack.botUserId);
}

function isDirectMessage(event: Legacy): boolean {
  return event.channel_type === "im";
}

const DM_RATE_LIMIT_NOTICE = "woah slow down a sec — gimme a minute to catch up :sob-pray:";

async function checkDmRateLimit({ event, client, program = null, threadTs = null }: Legacy): Promise<boolean> {
  if (!isDirectMessage(event)) return true;

  const limit = rateLimit.check(
    { userId: event.user || null, scope: event.channel, dm: true },
    { dm: true },
  );
  if (limit.allowed) return true;

  db.recordMetric("rate_limited", null, limit.reason || "limit", program?.id || null);
  if (!program || !program.shadowMode) {
    await require("./slackMessages").sendProgramMessage({
      client,
      program,
      channel: event.channel,
      threadTs,
      text: DM_RATE_LIMIT_NOTICE,
    });
  }
  return false;
}

// Image and command entry points do not pass through respond(), so they reserve DM budget here.

function findImage(event: Legacy): Legacy | null {
  // Slack's private image URL is the only file shape the vision client can fetch safely.
  if (!event.files?.length) return null;
  return event.files.find((f: Legacy) => f.mimetype?.startsWith("image/") && f.url_private) || null;
}

async function handleImage({ event, client, imageFile, program = null }: Legacy): Promise<boolean | void> {
  const threadTs = event.thread_ts || event.ts;
  const question = stripBotMention(event.text);

  if (!(await checkDmRateLimit({ event, client, program, threadTs }))) return false;

  try {
    context.addToThread(threadTs, "user", `[uploaded image] ${question}`, event.user, event.channel);
    const reply = await vision.analyzeImage(
      imageFile.url_private,
      question,
      context.getThreadContext(threadTs),
      config.slack.botToken,
    );

    if (reply) {
      await require("./slackMessages").sendProgramMessage({ client, program, channel: event.channel, threadTs, text: replyText.plainDashes(reply) });
      context.addToThread(threadTs, "assistant", reply, null, event.channel);
      context.updateUserHistory(event.user, question || "image analysis", true);
      db.recordMetric("answer_vision");
    }
  } catch (e: unknown) {
    log.error("vision", "analysis failed:", errorMessage(e));
    if (!program || !program.shadowMode) {
      await require("./slackMessages").sendProgramMessage({ client, program, channel: event.channel, threadTs, text: replyText.plainDashes(respond.ERROR_FALLBACK) });
    }
  }
}


async function untaggedThreadTurn({ event, client }: Legacy): Promise<string> {
  // A thread stays addressed while only Pixie and the asker are present; human chatter makes it ambient.
  const crowd = await context.fetchThreadCrowd(client, {
    channel: event.channel,
    threadTs: event.thread_ts,
    messageTs: event.ts,
    userId: event.user,
    botUserId: config.slack.botUserId,
    parentUserId: event.parent_user_id || null,
  });
  if (crowd.othersPresent) return "humans_talking";
  return crowd.pixieIn ? "addressed" : "ambient";
}

function stayOutOfHumanThread({ event, threadTs, question, prog }: Legacy): void {
  log.debug("intent", "skipping thread reply — other people are talking and nobody called pixie");
  context.addToThread(threadTs, "user", question, event.user, event.channel);
  db.recordMetric("silent", null, "thread_humans_talking", prog.id);
}

const HUMAN_ONLY_REPLY = "That one needs a person to decide, so I won't guess. A helper or organizer can sort it out :hii:";
const HUMAN_ONLY_PINGED_REPLY = "That one needs a person to decide, so I won't guess. I've asked a helper to take a look :hii:";

async function escalateSensitive({ event, client, prog, workspaceId, threadTs, question, addressed }: Legacy): Promise<void> {
  // Sensitive requests record the gap first, then try a ticket and helper handoff before replying.
  const tickets = require("./tickets");
  db.recordGap(question, event.user, event.channel, threadTs, prog.id);
  let ticket = null;
  try {
    ticket = await tickets.escalateTicket({ program: prog, channel: event.channel, threadTs, requesterId: event.user, question, client, workspaceId });
  } catch (e: unknown) {
    log.warn("handlers", `sensitive escalation ticket failed: ${errorMessage(e)}`);
  }
  if (ticket) {
    db.recordMetric("silent", null, "eligibility:sensitive_escalation", prog.id);
    return;
  }
  let helper = null;
  try {
    helper = await tickets.handOffToHelper({ client, program: prog, channel: event.channel, threadTs, question, requesterId: event.user, workspaceId });
  } catch (e: unknown) {
    log.warn("handlers", `sensitive escalation helper ping failed: ${errorMessage(e)}`);
  }
  if (!addressed) {
    db.recordMetric("silent", null, "eligibility:sensitive_escalation", prog.id);
    return;
  }
  const text = helper ? HUMAN_ONLY_PINGED_REPLY : HUMAN_ONLY_REPLY;
  await require("./slackMessages").sendProgramMessage({ client, program: prog, channel: event.channel, threadTs, text: replyText.plainDashes(text) });
  context.addToThread(threadTs, "assistant", text, null, event.channel);
  db.recordMetric("fallback", null, "sensitive_unticketed", prog.id);
}

function threadRequiresMention(prog: Legacy | null): boolean {
  return process.env.PIXIE_THREAD_REQUIRE_MENTION === "1" || Boolean(prog?.threadRequireMention);
}

function shouldConsiderThreadReply(event: Legacy, prog: Legacy | null = null): boolean {
  // Muted threads still wake only for a direct invocation; otherwise mention, guide, and prior-speech rules apply.
  if (!event.thread_ts || event.thread_ts === event.ts) return true;
  if (db.isThreadMuted(event.thread_ts)) {
    return mentionsPixieDirectly(event.text);
  }
  if (mentionsPixieByName(event.text) || mentionsPixieDirectly(event.text)) return true;
  if (db.getGuide(event.thread_ts)) return true;
  if (threadRequiresMention(prog)) return false;
  return context.hasSpokenInThread(event.thread_ts);
}

function checkEligibility({ event, prog, workspaceId, threadTs, question, isDm }: Legacy): string {
  // An open ticket suppresses ambient room replies, while direct mentions still reach the eligibility gate.
  const elig = require("./eligibility");
  const isTopLevel = !event.thread_ts || event.thread_ts === event.ts;
  let ticketOpen = false;
  try {
    const ticket = event.thread_ts ? db.getTicketByThreadTs(event.thread_ts, workspaceId) : null;
    ticketOpen = !!ticket && !["resolved", "closed"].includes(ticket.status);
  } catch (e: unknown) {
    log.debug("handlers", `ticket lookup in eligibility: ${errorMessage(e)}`);
  }
  const decision = elig.shouldPixieRespond({
    text: question,
    userId: event.user,
    botUserId: config.slack.botUserId,
    botNames: [brand.name(), brand.slug()],
    isHelpChannel: channelPolicy.resolve(event.channel, workspaceId).role === "help",
    isTopLevel,
    isDM: isDm,
    posture: prog.posture,
    program: prog,
    thread: event.thread_ts
      ? {
          muted: db.isThreadMuted(event.thread_ts),
          takeover: db.isTakeover(event.thread_ts),
          pixieSpoke: context.hasSpokenInThread(event.thread_ts),
          ticketOpen,
        }
      : null,
    actorIsHelper: isAdmin(event.user),
  });

  if (decision.clearMute && event.thread_ts) db.unmuteThread(event.thread_ts);
  if (decision.clearTakeover && event.thread_ts) db.clearTakeover(event.thread_ts);
  if (decision.markTakeover && event.thread_ts) {
    db.markTakeover(event.thread_ts, event.channel, event.user);
    try {
      require("./audit").record({ programId: prog.id, actorId: event.user, action: "thread.takeover", entityType: "thread", entityId: event.thread_ts });
  } catch (e: unknown) {
      log.debug("handlers", `takeover audit failed: ${errorMessage(e)}`);
    }
  }

  if (decision.decision === elig.SILENT) {
    db.recordMetric("silent", null, `eligibility:${decision.reason}`, prog.id);
    return "stop";
  }
  if (decision.decision === elig.HUMAN_DEFER) {
    db.recordMetric("silent", null, `eligibility:${decision.reason}`, prog.id);
    if (channelPolicy.resolve(event.channel, workspaceId).role === "help") return "escalate";
    return "stop";
  }
  if (decision.decision === elig.ESCALATE) return "escalate";
  return "proceed";
}

async function refuseUnauthorizedCommand({ event, client, question, prog, policy }: Legacy): Promise<boolean> {
  // Command identity and permission are decided before conversational routing can answer the same text.
  const commandRegistry = require("./commandRegistry");
  const hit = commandRegistry.match(question, { botUserId: config.slack.botUserId, botNames: [brand.name(), brand.slug()] });
  if (!hit) return false;
  const verdict = commandRegistry.authorize(hit.command, {
    userId: event.user,
    isHelper: actorRunsCommands(event.user, prog),
    isOrganizer: isAdmin(event.user),
    role: policy.role,
    commandsEnabled: policy.role === "main" ? policy.settings?.commandsEnabled !== false : true,
  });
  if (verdict.ok) return false;
  db.claimMessage(event.ts, event.channel);
  const text = verdict.reason === "commands_disabled"
    ? "commands are switched off in this channel :nono:"
    : verdict.reason === "wrong_channel"
      ? "that command doesn't work in this channel :nono:"
      : "that one's helpers-only :nono:";
  await client.chat.postEphemeral({ channel: event.channel, user: event.user, text });
  return true;
}

async function handleTeachRequest({ event, client, question, prog, mentionOnly, claimFirst }: Legacy): Promise<boolean> {
  // Teaching is a helper action and claims the message before writing shared memory when requested.
  if (!event.thread_ts || !teachPattern(mentionOnly).test(question)) return false;
  if (!actorRunsCommands(event.user, prog)) {
    await client.chat.postEphemeral({ channel: event.channel, user: event.user, text: "that one's helpers-only :nono:" });
    return true;
  }
  if (!(await checkDmRateLimit({ event, client, program: prog, threadTs: event.thread_ts }))) return true;
  if (claimFirst && !db.claimMessage(event.ts, event.channel)) return true;

  const strippedCommand = stripTeachCommand(question, mentionOnly);
  const parsedDirect = learn.parseTeach(strippedCommand);
  if (parsedDirect) {
    const id = learn.teach({ ...parsedDirect, authorId: event.user, threadTs: event.thread_ts, channel: event.channel, programId: prog.id });
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts,
      text: id
        ? `🧚 Memorized for future questions! :yesyes:\n>*Q:* ${parsedDirect.question}\n>*A:* ${parsedDirect.answer}\n\n_#${id} — remove with \`${brand.cmd("forget")} ${id}\`_`
        : "already memorized or couldn't save it",
    });
    return true;
  }

  try {
    const parsed = await teachThread.summarizeThread({ client, channel: event.channel, threadTs: event.thread_ts });
    if (!parsed) {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts,
        text: "couldn't find a clear question and answer in this thread to memorize",
      });
      return true;
    }
    const id = learn.teach({ ...parsed, authorId: event.user, threadTs: event.thread_ts, channel: event.channel, programId: prog.id });
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts,
      text: id
        ? `🧚 Memorized this thread for future questions! :yesyes:\n>*Q:* ${parsed.question}\n>*A:* ${parsed.answer}\n\n_#${id} — remove with \`${brand.cmd("forget")} ${id}\`_`
        : "already memorized this thread!",
    });
    return true;
  } catch (e: unknown) {
    log.error("handlers", mentionOnly ? `teach thread on mention failed: ${errorMessage(e)}` : `!teach failed: ${errorMessage(e)}`);
    return false;
  }
}

async function handleSumRequest({ event, client, question, prog, mentionOnly, claimFirst }: Legacy): Promise<boolean> {
  // Summaries follow the same helper-only and single-claim boundary as direct teaching.
  if (!sumPattern(mentionOnly).test(question)) return false;
  if (!actorRunsCommands(event.user, prog)) {
    await client.chat.postEphemeral({ channel: event.channel, user: event.user, text: "that one's helpers-only :nono:" });
    return true;
  }
  if (!(await checkDmRateLimit({ event, client, program: prog, threadTs: event.thread_ts }))) return true;
  if (!event.thread_ts) {
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      text: "!sum can only be used inside a thread :nono:",
    });
    return true;
  }
  if (claimFirst && !db.claimMessage(event.ts, event.channel)) return true;

  const isPublic = /\b(?:public|share|all|post)\b/i.test(question);
  try {
    const summary = await sumThread.summarizeThreadForHelper({
      client,
      channel: event.channel,
      threadTs: event.thread_ts,
    });

    if (!summary) {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts,
        text: "couldn't generate a summary for this thread",
      });
      return true;
    }

    const formatted = replyText.plainDashes(summary);
    if (isPublic) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `🧵 *Thread Summary* (requested by <@${event.user}>):\n\n${formatted}`,
      });
    } else {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts,
        text: `🧵 *Thread Summary for Helpers:*\n\n${formatted}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🧵 *Thread Summary for Helpers:*\n\n${formatted}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "📢 Post to Thread" },
                action_id: "sum_post_to_thread",
                value: JSON.stringify({
                  threadTs: event.thread_ts,
                  channel: event.channel,
                  summary: formatted.slice(0, 1500),
                }),
              },
            ],
          },
        ],
      });
    }
    return true;
  } catch (e: unknown) {
    log.error("handlers", mentionOnly ? `sum on mention failed: ${errorMessage(e)}` : `!sum failed: ${errorMessage(e)}`);
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts,
      text: "failed to summarize the thread, check logs",
    });
    return true;
  }
}

// Staging allowlists fail closed only when explicitly configured.
function stagingBlocked(channel: string): boolean {
  const allow = config.slack.stagingOnlyChannels;
  if (!allow || allow.length === 0) return false;
  return !allow.includes(channel);
}

const MACRO_NOTE_MAX_LENGTH = 280;

function parseMacroTrigger(text: string): Legacy | null {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(String(text || "").trim());
  if (!match) return null;
  const trigger = macros.normalizeTrigger(match[1]);
  if (!trigger || (match[2] && match[2].trim().length > MACRO_NOTE_MAX_LENGTH)) return null;
  return { trigger };
}

async function reactToMacroMessage(client: Legacy, event: Legacy, name: string): Promise<void> {
  if (!client?.reactions?.add) return;
  try {
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name });
  } catch (e: unknown) {
    log.debug("macros", `reaction failed for ${event.ts}: ${errorMessage(e)}`);
  }
}

function findMacro(programId: string, trigger: string): Legacy | null {
  const bare = trigger.slice(1);
  const candidates = macros.list(programId).filter((row: Legacy) => String(row.trigger || "").slice(1) === bare);
  return candidates.find((row: Legacy) => row.trigger === trigger && row.enabled)
    || candidates.find((row: Legacy) => row.enabled)
    || candidates[0]
    || null;
}

async function postMacroEphemeral(client: Legacy, event: Legacy, text: string): Promise<void> {
  try {
    await client?.chat?.postEphemeral?.({ channel: event.channel, user: event.user, thread_ts: event.thread_ts, text });
  } catch (e: unknown) {
    log.debug("macros", `ephemeral failed for ${event.ts}: ${errorMessage(e)}`);
  }
}

function macroTargetFor(event: Legacy, workspaceId: string | null): Legacy {
  let ticket = db.getTicketByThreadTs(event.thread_ts, workspaceId);
  if (!ticket && workspaceId) ticket = db.getTicketByThreadTs(event.thread_ts);
  const foreign = ticket && (ticket.channel !== event.channel || (ticket.workspace_id && workspaceId && ticket.workspace_id !== workspaceId));
  if (ticket && !foreign) return { ticket, program: programs.get(ticket.program_id) };
  const program = programs.forChannel(event.channel, workspaceId);
  if (!program || program.id === programs.shared().id) return { ticket: null, program: null };
  return { ticket: null, program };
}

async function handleMacroTrigger({ event, client, workspaceId }: Legacy): Promise<boolean> {
  // Macros are thread-only and resolve against the ticket or channel's program before permission checks.
  if (!event.thread_ts || event.thread_ts === event.ts || !event.user) return false;
  if (teachPattern(false).test(event.text) || sumPattern(false).test(event.text)) return false;
  const parsed = parseMacroTrigger(event.text);
  if (!parsed) return false;
  const { ticket, program } = macroTargetFor(event, workspaceId);
  if (!program) return false;
  const macro = findMacro(program.id, parsed.trigger);

  if (!actorRunsCommands(event.user, program)) {
    if (!macro || !macro.enabled) return false;
    if (!db.claimMessage(event.ts, event.channel)) return true;
    await postMacroEphemeral(client, event, "that one's helpers-only :nono:");
    return true;
  }

  if (!db.claimMessage(event.ts, event.channel)) return true;
  if (!macro || !macro.enabled) {
    await reactToMacroMessage(client, event, "question");
    const enabled = macros.list(program.id, { enabledOnly: true }).slice(0, 5).map((row: Legacy) => row.trigger);
    const suggestion = enabled.length > 0 ? enabled.join(", ") : "none yet, add one on the Macros page";
    await postMacroEphemeral(client, event, `No macro \`${parsed.trigger}\` for ${program.name}. Try: ${suggestion}`);
    return true;
  }

  const sent = ticket
    ? await macros.send({ id: macro.id, ticketId: ticket.id, actorId: event.user, client })
    : await macros.sendToThread({ id: macro.id, program, channel: event.channel, threadTs: event.thread_ts, actorId: event.user, client });
  if (sent?.ok) {
    await reactToMacroMessage(client, event, "white_check_mark");
  } else {
    log.warn("macros", `send failed for ${parsed.trigger} in ${event.channel}/${event.thread_ts}: ${sent?.error || "unknown error"}`);
    await postMacroEphemeral(client, event, `Couldn't send \`${macro.trigger}\`: ${sent?.error || "unknown error"}`);
  }
  return true;
}

// A channel must explicitly belong to Pixie before any reply, escalation, or learning path runs.
async function onMessage({ event, client }: Legacy): Promise<void> {
  if (event.bot_id || event.subtype === "bot_message") return;
  if (stagingBlocked(event.channel)) return;

  const allowedSubtypes = ["file_share", "thread_broadcast"];
  if (event.subtype && !allowedSubtypes.includes(event.subtype)) return;

  const threadTs = event.thread_ts || event.ts;
  const question = (event.text || "").trim();
  const isDm = isDirectMessage(event);
  const named = mentionsPixieByName(question);
  const pinged = mentionsPixieDirectly(question);

  const workspaceId = workspace.workspaceOf(event);
  if (await handleMacroTrigger({ event, client, workspaceId })) return;
  let productionProgramMatch = null;
  try {
    const candidate = programs.forChannel(event.channel, workspaceId);
    if (candidate && candidate.id && candidate.id !== "ysws-global") productionProgramMatch = candidate.id;
  } catch (error: unknown) {
    log.debug("draft", `production channel lookup failed: ${errorMessage(error)}`);
  }
  if (!productionProgramMatch) {
    let draftBinding = null;
    try {
      draftBinding = require("./draftSandbox").getForChannel(event.channel, workspaceId);
  } catch (e: unknown) {
      log.warn("draft", `channel_id=${event.channel} message_ts=${event.ts} production_program_match=null draft_binding_match=error draft_safety_pass=false suppression_reason=binding_lookup_failed`);
    }
    if (draftBinding && draftBinding.enabled) {
      const draftProgramId = draftBinding.draftProgramId;
      const baseLog = `channel_id=${event.channel} message_ts=${event.ts} production_program_match=null draft_binding_match=${draftBinding.role} draft_program_id=${draftProgramId}`;
      if (draftBinding.role !== "help") {
        log.info("draft", `${baseLog} draft_safety_pass=true suppression_reason=ticket_sink_no_answer`);
        return;
      }
      if (!question) {
        log.info("draft", `${baseLog} draft_safety_pass=true suppression_reason=empty_text`);
        return;
      }
      const draftProgram = require("./draftSandbox").get(draftProgramId);
      const safetyPass = Boolean(
        draftProgram &&
        draftProgram.status === "suspended" &&
        draftProgram.privateSandboxOnly === true &&
        draftProgram.autoAssign !== true,
      );
      if (!safetyPass) {
        log.warn("draft", `${baseLog} draft_safety_pass=false suppression_reason=safety_check_failed`);
        return;
      }
      if (!db.claimMessage(event.ts, event.channel)) return;
      try {
        const ticket = await require("./draftSandbox").ensureSupportTicket({
          programId: draftProgramId,
          workspaceId,
          channel: event.channel,
          threadTs,
          requesterId: event.user,
          question,
          client,
        });
        if (!ticket) log.warn("draft", `${baseLog} draft_safety_pass=true suppression_reason=sandbox_ticket_unavailable`);
  } catch (e: unknown) {
        log.warn("draft", `${baseLog} draft_safety_pass=true suppression_reason=sandbox_ticket_failed`);
      }
      let corpus = "";
      try {
        corpus = require("./knowledge").getDraftContext(draftProgramId, question);
  } catch (e: unknown) {
        log.warn("draft", `${baseLog} draft_safety_pass=true suppression_reason=retrieval_error`);
        return;
      }
      const retrievalCount = corpus ? corpus.length : 0;
      if (!corpus) {
        log.warn("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=0 suppression_reason=empty_corpus`);
        return;
      }
      let answer = null;
      try {
        answer = await require("./answer").getGroundedAnswer(question, corpus, "", draftProgram, event.channel, { inHelpChannel: true });
  } catch (e: unknown) {
        log.warn("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=error suppression_reason=generation_failed`);
        return;
      }
      if (!answer?.answer) {
        const draftName = draftProgram?.name || draftProgramId;
        const fallback = `I don't have that in the ${draftName} draft knowledge yet — I'm scoped to ${draftName} sources only in this sandbox.`;
        try {
          await require("./slackMessages").sendProgramMessage({ client, program: draftProgram, channel: event.channel, threadTs, text: fallback });
          log.info("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=fallback slack_post_result=sent suppression_reason=no_grounded_answer`);
  } catch (e: unknown) {
          log.warn("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=fallback slack_post_result=failed suppression_reason=slack_post_failed`);
        }
        return;
      }
      try {
        await require("./slackMessages").sendProgramMessage({ client, program: draftProgram, channel: event.channel, threadTs, text: answer.answer });
        log.info("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=answered slack_post_result=sent`);
  } catch (e: unknown) {
        log.warn("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=answered slack_post_result=failed suppression_reason=slack_post_failed`);
      }
      return;
    }
  }
  if (event.thread_ts && event.thread_ts !== event.ts && !event.bot_id) {
    try {
      await require("./tickets").noteThreadActivity({ channel: event.channel, threadTs: event.thread_ts, userId: event.user, text: event.text || null, workspaceId, client, parentUserId: event.parent_user_id || null });
  } catch (e: unknown) {
      log.debug("handlers", `thread activity tracking: ${errorMessage(e)}`);
    }
  }
  const policy = channelPolicy.resolve(event.channel, workspaceId, { isDm });
  const prog = policy.program;
  const inHelpChannel = policy.role === "help";
  const isProgChannel = policy.role === "main" || policy.role === "organizer";

  if (!isDm && !inHelpChannel && !isProgChannel) return;
  if (!isDm && policy.settings && policy.settings.enabled === false) return;

  if (question) {
    db.recordUserMessage({ userId: event.user, channel: event.channel, threadTs, text: question });
  }

  log.debug(
    "message",
    `channel=${event.channel} dm=${isDm} thread=${event.thread_ts || "none"} ts=${event.ts} named=${named} pinged=${pinged} prog=${prog.id} posture=${prog.posture}`,
  );

  if (!event.bot_id && event.subtype !== "bot_message") {
    const elig = checkEligibility({ event, prog, workspaceId, threadTs, question, isDm });
    if (elig === "stop") {
      if (pinged) db.claimMessage(event.ts, event.channel);
      return;
    }
    if (elig === "escalate") {
      if (!db.claimMessage(event.ts, event.channel)) return;
      await escalateSensitive({ event, client, prog, workspaceId, threadTs: event.thread_ts || event.ts, question, addressed: pinged || named || isDm });
      return;
    }
  }


  if (await refuseUnauthorizedCommand({ event, client, question, prog, policy })) return;

  if (await handleTeachRequest({ event, client, question, prog, mentionOnly: false, claimFirst: true })) return;

  if (await handleSumRequest({ event, client, question, prog, mentionOnly: false, claimFirst: true })) return;

  const imageFile = findImage(event);
  if (imageFile) {
    const hasQuestion = question && question.trim().length > 0;
    const wanted = isDm || pinged || named || (inHelpChannel && hasQuestion);
    if (!wanted) return;
    if (!db.claimMessage(event.ts, event.channel)) return;
    await handleImage({ event, client, imageFile, program: prog });
    return;
  }

  if (pinged) return;

  if (isDm) {
    if (!(await checkDmRateLimit({ event, client, program: prog, threadTs: event.thread_ts || undefined }))) return;
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      workspaceId,
      client,
      channel: event.channel,
      threadTs: event.thread_ts || undefined,
      userId: event.user,
      question,
      messageTs: event.ts,
      mode: respond.ALWAYS,
      addressedHow: "dm",
      seedClient: event.thread_ts ? client : null,
       scope: event.channel,
       dm: true,
       rateLimitReserved: true,
    });
    return;
  }


  if (isProgChannel && !inHelpChannel) {
    if (named) {
      if (!db.claimMessage(event.ts, event.channel)) return;
      await respond.respond({
      workspaceId,
        client,
        channel: event.channel,
        threadTs,
        userId: event.user,
        question,
        messageTs: event.ts,
        mode: respond.ALWAYS,
        seedClient: client,
        addressed: true,
        addressedHow: "mention",
      });
      return;
    }

    if (!shouldConsiderThreadReply(event, prog)) {
      log.debug("intent", "skipping thread reply — pixie not in this thread / not addressed");
      return;
    }

    if (!worthClassifying(question)) {
      log.debug("intent", "skipping model call — nothing but emoji or a bare reaction");
      context.addToThread(threadTs, "user", question, event.user, event.channel);
      db.recordMetric("silent", null, "no_content");
      return;
    }

    const inActiveGuide = !!db.getGuide(threadTs);
    const turn = event.thread_ts && !inActiveGuide ? await untaggedThreadTurn({ event, client }) : "ambient";
    if (turn === "humans_talking") return stayOutOfHumanThread({ event, threadTs, question, prog });
    const toPixie = inActiveGuide || turn === "addressed";
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      workspaceId,
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      messageTs: event.ts,
      mode: toPixie ? respond.ALWAYS : respond.HELP_ONLY,
      addressed: toPixie,
      addressedHow: inActiveGuide ? "guide" : toPixie ? "thread" : undefined,
      seedClient: client,
    });
    return;
  }

  if (!inHelpChannel) return;

  if (event.thread_ts && !named) {
    if (!shouldConsiderThreadReply(event, prog)) {
      log.debug("intent", "skipping help thread reply — pixie not in this thread / not addressed");
      return;
    }

    if (!worthClassifying(question)) {
      log.debug("intent", "skipping model call — nothing but emoji or a bare reaction");
      context.addToThread(threadTs, "user", question, event.user, event.channel);
      db.recordMetric("silent", null, "no_content");
      return;
    }

    const inActiveGuide = !!db.getGuide(threadTs);
    const turn = inActiveGuide ? "addressed" : await untaggedThreadTurn({ event, client });
    if (turn === "humans_talking") return stayOutOfHumanThread({ event, threadTs, question, prog });
    const toPixie = turn === "addressed";
    if (!db.claimMessage(event.ts, event.channel)) return;
    await respond.respond({
      workspaceId,
      client,
      channel: event.channel,
      threadTs,
      userId: event.user,
      question,
      messageTs: event.ts,
      mode: toPixie ? respond.ALWAYS : respond.HELP_ONLY,
      seedClient: client,
      addressed: toPixie,
      addressedHow: inActiveGuide ? "guide" : toPixie ? "thread" : undefined,
    });
    return;
  }

  if (!named && !worthClassifying(question)) {
    db.recordMetric("silent", null, "no_content");
    return;
  }

  if (!db.claimMessage(event.ts, event.channel)) return;
  await respond.respond({
      workspaceId,
    client,
    channel: event.channel,
    threadTs,
    userId: event.user,
    question,
    messageTs: event.ts,
    mode: named ? respond.ALWAYS : respond.HELP_ONLY,
    seedClient: client,
    addressed: named,
    addressedHow: named ? "mention" : undefined,
  });
}

// app_mention is a second delivery of the same message; wasAnswered/claim state prevents duplicate work.
async function onAppMention({ event, client }: Legacy): Promise<void> {
  if (event.bot_id || event.subtype === "bot_message" || event.user === config.slack.botUserId) return;
  if (stagingBlocked(event.channel)) return;
  const workspaceId = workspace.workspaceOf(event);
  const question = stripBotMention(event.text);
  const threadTs = event.thread_ts || event.ts;

  const policy = channelPolicy.resolve(event.channel, workspaceId);
  const prog = policy.program;
  if (!["help", "main", "organizer"].includes(policy.role)) return;
  if (policy.settings && policy.settings.enabled === false) return;

  if (db.wasAnswered(event.ts)) return;

  if (event.thread_ts && (db.isThreadMuted(event.thread_ts) || db.isTakeover(event.thread_ts))) {
    if (db.wasAnswered(event.ts)) return;
    const elig = require("./eligibility");
    const verdict = elig.shouldPixieRespond({
      text: event.text,
      userId: event.user,
      botUserId: config.slack.botUserId,
      botNames: [brand.name(), brand.slug()],
      isHelpChannel: policy.role === "help",
      isTopLevel: false,
      posture: prog.posture,
      program: prog,
      thread: {
        muted: db.isThreadMuted(event.thread_ts),
        takeover: db.isTakeover(event.thread_ts),
        pixieSpoke: context.hasSpokenInThread(event.thread_ts),
        ticketOpen: false,
      },
    });
    if (verdict.decision !== elig.REPLY) {
      db.recordMetric("silent", null, `eligibility:${verdict.reason}`, prog.id);
      return;
    }
    if (verdict.clearMute) db.unmuteThread(event.thread_ts);
    if (verdict.clearTakeover) db.clearTakeover(event.thread_ts);
  }

  const eligibility = checkEligibility({
    event,
    prog,
    workspaceId,
    threadTs,
    question: event.text || "",
    isDm: false,
  });
  if (eligibility === "stop") return;
  if (eligibility === "escalate") {
    if (!db.claimMessage(event.ts, event.channel)) return;
    await escalateSensitive({ event, client, prog, workspaceId, threadTs, question, addressed: true });
    return;
  }

  if (await refuseUnauthorizedCommand({ event, client, question: event.text || "", prog, policy })) return;

  if (await handleTeachRequest({ event, client, question, prog, mentionOnly: true, claimFirst: false })) return;

  if (await handleSumRequest({ event, client, question, prog, mentionOnly: true, claimFirst: true })) return;

  const imageFile = findImage(event);
  if (imageFile) {
    if (!db.claimMessage(event.ts, event.channel)) return;
    await handleImage({ event, client, imageFile, program: programs.forChannel(event.channel, workspaceId) });
    return;
  }

  if (!db.claimMessage(event.ts, event.channel)) return;

  await respond.respond({
      workspaceId,
    client,
    channel: event.channel,
    threadTs,
    userId: event.user,
    question,
    messageTs: event.ts,
    mode: respond.ALWAYS,
    seedClient: client,
    addressed: true,
    addressedHow: "mention",
  });
}

async function messageAuthor(client: Legacy, channel: string, ts: string): Promise<string | null> {
  // Reaction payloads may omit item_user, so inspect replies and then history before giving up.
  try {
    const replies = await client.conversations?.replies?.({ channel, ts, limit: 1, inclusive: true });
    if (replies?.messages?.[0]) return replies.messages[0].user || null;
  } catch (e: unknown) {
    log.debug("handlers", `replies lookup failed for ${ts}: ${errorMessage(e)}`);
  }
  try {
    const hist = await client.conversations?.history?.({ channel, latest: ts, limit: 1, inclusive: true });
    return hist?.messages?.[0]?.user || null;
  } catch (e: unknown) {
    log.debug("handlers", `history lookup failed for ${ts}: ${errorMessage(e)}`);
    return null;
  }
}

async function onReactionAdded({ event, client }: Legacy): Promise<void> {
  // Reaction targets carry their channel on item, so never fall back to the event channel when it is present.
  if (event.item && stagingBlocked(event.item.channel)) return;
  const channel = event.item?.channel || event.channel;
  const normReaction = (event.reaction || "").toLowerCase();

  if (DELETE_REACTIONS.has(normReaction)) {
    try {
      const author = event.item_user || (await messageAuthor(client, channel, event.item.ts));

      if (!author) {
        log.warn("handlers", `delete reaction on ${event.item.ts}: could not tell who wrote it`);
        return;
      }
      if (author !== config.slack.botUserId) return;

      await client.chat.delete({ channel, ts: event.item.ts });
      log.info("handlers", `deleted message ${event.item.ts} via reaction`);
  } catch (e: unknown) {
      log.warn("handlers", `could not delete ${event.item.ts}: ${errorData(e)?.error || errorMessage(e)}`);
    }
    return;
  }

  if (normReaction === GUIDE_ADVANCE_REACTION) {
    try {
      const guideState = db.getGuideByMessageTs(event.item.ts) || db.getGuide(event.item.ts);
      if (guideState && (db.isThreadMuted(guideState.thread_ts) || db.isTakeover(guideState.thread_ts))) {
        log.debug("guides", `guide parked in silenced thread ${guideState.thread_ts}`);
        return;
      }
      if (guideState) {
        const nextStepResult = await guides.advanceGuideByReaction({
          messageTs: event.item.ts,
          userId: event.user,
        });
        if (nextStepResult !== null) {
          await respond.postGuideStep({
            client,
            channel,
            threadTs: guideState.thread_ts,
            result: nextStepResult,
            program: programs.forChannel(channel, workspace.workspaceOf(event)),
          });
          log.info("guides", `advanced guide via reaction in thread ${guideState.thread_ts}`);
          return;
        }
      }
  } catch (e: unknown) {
      log.debug("guides", `reaction advance failed: ${errorMessage(e)}`);
    }
  }

  const vote = UP_REACTIONS.has(normReaction) ? 1 : DOWN_REACTIONS.has(normReaction) ? -1 : 0;
  if (vote !== 0) {
    db.recordFeedback(event.item.ts, event.user, vote);
    log.info("feedback", `vote=${vote} ts=${event.item.ts} user=${event.user}`);
  }
}

async function onReactionRemoved({ event }: Legacy): Promise<void> {
  const normReaction = (event.reaction || "").toLowerCase();
  if (UP_REACTIONS.has(normReaction) || DOWN_REACTIONS.has(normReaction)) {
    db.removeFeedback(event.item.ts, event.user);
  }
}

export = {
  onMessage,
  onAppMention,
  onReactionAdded,
  onReactionRemoved,
  shouldConsiderThreadReply,
  mentionsPixieByName,
  mentionsPixieDirectly,
  stripBotMention,
  findImage,
  handleImage,
  handleTeachRequest,
  handleSumRequest,
  teachPattern,
  sumPattern,
  checkDmRateLimit,
};
