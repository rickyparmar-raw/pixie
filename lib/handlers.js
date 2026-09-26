// Slack event routing. Decides *whether* pixie should speak; lib/respond.js
// decides what it says.
const { config, isAdmin } = require("./config");
const vision = require("./vision");
const { worthClassifying } = require("./intent");
const context = require("./context");
const respond = require("./respond");
// Named replyText because `reply` is already the local for a vision answer.
const replyText = require("./reply");
const guides = require("./guides");
const learn = require("./learn");
const teachThread = require("./teachThread");
const sumThread = require("./sumThread");
const db = require("./db");
const rateLimit = require("./rateLimit");
const log = require("./log");
const programs = require("./programs");
const macros = require("./macros");
const channelPolicy = require("./channelPolicy");
const workspace = require("./workspace");
const brand = require("./brand");

const DELETE_REACTIONS = new Set(["pixl-delete", "x", "heavy_multiplication_x"]);
const UP_REACTIONS = new Set(["yay", "thumbs-up", "+1", "yesyes", "white_check_mark", "heavy_check_mark", "upvote", "sparkling_heart", "heart", "heart_eyes"]);
const DOWN_REACTIONS = new Set(["nono", "-1", "thumbsdown", "sad-pf"]);
const GUIDE_ADVANCE_REACTION = "upvote";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsPixieByName(text) {
  const customNames = (process.env.PIXIE_BOT_ALIASES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // WHY: canonical pattern lives in eligibility — same escaping, no drift.
  const names = [...new Set([brand.name(), brand.slug(), ...customNames])];
  const pattern = require("./eligibility").botNamePattern(names);
  return new RegExp(`\\b(?:${pattern})\\w*\\b`, "i").test(text || "");
}

function teachPattern(mentionOnly = false) {
  const slug = escapeRegex(brand.slug());
  const base = mentionOnly ? `teach|learn|remember|memorize|!teach|/${slug}-teach` : `!teach|${slug}-teach|/${slug}-teach|teach\\s+this|teach\\s+thread`;
  return new RegExp(`^\\s*(?:${base})\\b`, "i");
}

function stripTeachCommand(text, mentionOnly = false) {
  return String(text || "").replace(teachPattern(mentionOnly), "").trim();
}

// Bot-management commands (!teach, !sum) are for the people who run a program.
// A global admin qualifies everywhere; a program's own roster helper qualifies
// for that program only.
function actorRunsCommands(userId, prog) {
  return isAdmin(userId) || (!!prog && db.isHelper(prog.id, userId));
}

function sumPattern(mentionOnly = false) {
  const slug = escapeRegex(brand.slug());
  const base = mentionOnly
    ? `sum|summary|summarize|summarise|!sum|!summary|!summarize|!summarise|/${slug}-sum`
    : `!sum|!summary|!summarize|!summarise|${slug}-sum|/${slug}-sum|sum\\s+this|sum\\s+thread|summarize\\s+thread|summarise\\s+thread`;
  return new RegExp(`^\\s*(?:${base})\\b`, "i");
}

function mentionsPixieDirectly(text) {
  // WHY: canonical direct check lives in eligibility — same includes, no drift.
  return require("./eligibility").directMention(text, config.slack.botUserId);
}

function stripBotMention(text) {
  // WHY: canonical strip lives in eligibility — same trim, escaped id.
  return require("./eligibility").stripBotMention(text, config.slack.botUserId);
}

function isDirectMessage(event) {
  return event.channel_type === "im";
}

const DM_RATE_LIMIT_NOTICE = "woah slow down a sec — gimme a minute to catch up :sob-pray:";

// DM reservations belong here for entry points that do not pass through
// respond(). The scope is explicit so a user's DM budget cannot be shared with
// channel traffic, and a missing Slack identity fails closed.
async function checkDmRateLimit({ event, client, program = null, threadTs = null }) {
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

/* ---------------------------------------------------------------- images -- */

function findImage(event) {
  if (!event.files?.length) return null;
  return event.files.find((f) => f.mimetype?.startsWith("image/") && f.url_private) || null;
}

async function handleImage({ event, client, imageFile, program = null }) {
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
  } catch (e) {
    log.error("vision", "analysis failed:", e.message);
    if (!program || !program.shadowMode) {
      await require("./slackMessages").sendProgramMessage({ client, program, channel: event.channel, threadTs, text: replyText.plainDashes(respond.ERROR_FALLBACK) });
    }
  }
}

/* --------------------------------------------------------------- routing -- */

// An untagged thread message. While the thread is just Pixie and this person,
// they are talking to her: it is addressed, like a mention. Once anyone else
// has posted, the humans are talking to each other and Pixie stays out until
// someone tags or names her (those take the named/app_mention paths).
// Returns "addressed", "humans_talking", or "ambient".
async function untaggedThreadTurn({ event, client }) {
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

function stayOutOfHumanThread({ event, threadTs, question, prog }) {
  log.debug("intent", "skipping thread reply — other people are talking and nobody called pixie");
  context.addToThread(threadTs, "user", question, event.user, event.channel);
  db.recordMetric("silent", null, "thread_humans_talking", prog.id);
}

// A sensitive message goes to humans, never the model. Where no ticket can
// carry it (tickets off, or a main channel) the helper ping still can, and a
// message addressed to Pixie always gets a reply instead of silence.
const HUMAN_ONLY_REPLY = "That one needs a person to decide, so I won't guess. A helper or organizer can sort it out :hii:";
const HUMAN_ONLY_PINGED_REPLY = "That one needs a person to decide, so I won't guess. I've asked a helper to take a look :hii:";

async function escalateSensitive({ event, client, prog, workspaceId, threadTs, question, addressed }) {
  const tickets = require("./tickets");
  db.recordGap(question, event.user, event.channel, threadTs, prog.id);
  let ticket = null;
  try {
    ticket = await tickets.escalateTicket({ program: prog, channel: event.channel, threadTs, requesterId: event.user, question, client, workspaceId });
  } catch (e) {
    log.warn("handlers", `sensitive escalation ticket failed: ${e.message}`);
  }
  if (ticket) {
    db.recordMetric("silent", null, "eligibility:sensitive_escalation", prog.id);
    return;
  }
  let helper = null;
  try {
    helper = await tickets.handOffToHelper({ client, program: prog, channel: event.channel, threadTs, question, requesterId: event.user, workspaceId });
  } catch (e) {
    log.warn("handlers", `sensitive escalation helper ping failed: ${e.message}`);
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

function threadRequiresMention(prog) {
  return process.env.PIXIE_THREAD_REQUIRE_MENTION === "1" || Boolean(prog?.threadRequireMention);
}

function shouldConsiderThreadReply(event, prog = null) {
  if (!event.thread_ts || event.thread_ts === event.ts) return true;
  if (db.isThreadMuted(event.thread_ts)) {
    return mentionsPixieDirectly(event.text);
  }
  if (mentionsPixieByName(event.text) || mentionsPixieDirectly(event.text)) return true;
  if (db.getGuide(event.thread_ts)) return true;
  if (threadRequiresMention(prog)) return false;
  return context.hasSpokenInThread(event.thread_ts);
}

// Returns true to continue routing, false when eligibility consumed the event.
// Thread state is read here (I/O) so lib/eligibility.js itself stays pure.
function checkEligibility({ event, prog, workspaceId, threadTs, question, isDm }) {
  const elig = require("./eligibility");
  const isTopLevel = !event.thread_ts || event.thread_ts === event.ts;
  let ticketOpen = false;
  try {
    const ticket = event.thread_ts ? db.getTicketByThreadTs(event.thread_ts, workspaceId) : null;
    ticketOpen = !!ticket && !["resolved", "closed"].includes(ticket.status);
  } catch (e) {
    log.debug("handlers", `ticket lookup in eligibility: ${e.message}`);
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
    } catch (e) {
      log.debug("handlers", `takeover audit failed: ${e.message}`);
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

// Commands are recognized before any conversational handling: one registry
// (lib/commandRegistry.js) decides what a command is and who may run it in
// this channel role. Returns true when the event was consumed by a refusal;
// allowed commands fall through to their existing handlers below.
async function refuseUnauthorizedCommand({ event, client, question, prog, policy }) {
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

// WHY: one teach flow, not two pasted blocks. onMessage (channel text) and
// onAppMention (@-mention) differ only in the pattern flag and in who already
// claimed the message: the mention path claims once up front, the message path
// claims here. claimFirst preserves exactly that. Returns true when the event
// is consumed (including claim contention — the loser stops routing).
async function handleTeachRequest({ event, client, question, prog, mentionOnly, claimFirst }) {
  if (!event.thread_ts || !teachPattern(mentionOnly).test(question)) return false;
  if (!actorRunsCommands(event.user, prog)) {
    await client.chat.postEphemeral({ channel: event.channel, user: event.user, text: "that one's helpers-only :nono:" });
    return true;
  }
  if (!(await checkDmRateLimit({ event, client, program: prog, threadTs: event.thread_ts }))) return true;
  if (claimFirst && !db.claimMessage(event.ts, event.channel)) return true;

  // Check if custom Q :: A was passed e.g. "!teach <question> :: <answer>"
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
  } catch (e) {
    log.error("handlers", mentionOnly ? `teach thread on mention failed: ${e.message}` : `!teach failed: ${e.message}`);
    return false;
  }
}

// WHY: same single-flow reasoning as handleTeachRequest — the !sum handler is
// also pasted across onMessage and onAppMention with only the pattern flag
// and claim ownership differing.
async function handleSumRequest({ event, client, question, prog, mentionOnly, claimFirst }) {
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
  } catch (e) {
    log.error("handlers", mentionOnly ? `sum on mention failed: ${e.message}` : `!sum failed: ${e.message}`);
    await client.chat.postEphemeral({
      channel: event.channel,
      user: event.user,
      thread_ts: event.thread_ts,
      text: "failed to summarize the thread, check logs",
    });
    return true;
  }
}

// Staging guardrail: with PIXIE_STAGING_ONLY_CHANNELS set, events outside
// the allowlist are dropped before any processing — no answers, tickets,
// reactions, or state changes. Default (unset) is production behavior.
function stagingBlocked(channel) {
  const allow = config.slack.stagingOnlyChannels;
  if (!allow || allow.length === 0) return false;
  return !allow.includes(channel);
}

const MACRO_NOTE_MAX_LENGTH = 280;

function parseMacroTrigger(text) {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(String(text || "").trim());
  if (!match) return null;
  const trigger = macros.normalizeTrigger(match[1]);
  if (!trigger || (match[2] && match[2].trim().length > MACRO_NOTE_MAX_LENGTH)) return null;
  return { trigger };
}

async function reactToMacroMessage(client, event, name) {
  if (!client?.reactions?.add) return;
  try {
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name });
  } catch (e) {
    log.debug("macros", `reaction failed for ${event.ts}: ${e.message}`);
  }
}

// "!" is the documented sigil, but a macro saved as "?need-info" still
// answers to "!need-info" (and the reverse), so older macros keep working.
function findMacro(programId, trigger) {
  const bare = trigger.slice(1);
  const candidates = macros.list(programId).filter((row) => String(row.trigger || "").slice(1) === bare);
  return candidates.find((row) => row.trigger === trigger && row.enabled)
    || candidates.find((row) => row.enabled)
    || candidates[0]
    || null;
}

async function postMacroEphemeral(client, event, text) {
  try {
    await client?.chat?.postEphemeral?.({ channel: event.channel, user: event.user, thread_ts: event.thread_ts, text });
  } catch (e) {
    log.debug("macros", `ephemeral failed for ${event.ts}: ${e.message}`);
  }
}

function macroTargetFor(event, workspaceId) {
  let ticket = db.getTicketByThreadTs(event.thread_ts, workspaceId);
  if (!ticket && workspaceId) ticket = db.getTicketByThreadTs(event.thread_ts);
  const foreign = ticket && (ticket.channel !== event.channel || (ticket.workspace_id && workspaceId && ticket.workspace_id !== workspaceId));
  if (ticket && !foreign) return { ticket, program: programs.get(ticket.program_id) };
  const program = programs.forChannel(event.channel, workspaceId);
  // The shared fallback serves channels no program claimed; macros belong to
  // a program, so an unclaimed channel has none to send.
  if (!program || program.id === programs.shared().id) return { ticket: null, program: null };
  return { ticket: null, program };
}

// Works like !sum: any thread in a program's channels. In a ticket thread
// the macro goes out as a ticket reply (events, transitions, audit); in any
// other thread Pixie posts it straight into the thread.
async function handleMacroTrigger({ event, client, workspaceId }) {
  if (!event.thread_ts || event.thread_ts === event.ts || !event.user) return false;
  if (teachPattern(false).test(event.text) || sumPattern(false).test(event.text)) return false;
  const parsed = parseMacroTrigger(event.text);
  if (!parsed) return false;
  const { ticket, program } = macroTargetFor(event, workspaceId);
  if (!program) return false;
  const macro = findMacro(program.id, parsed.trigger);

  if (!actorRunsCommands(event.user, program)) {
    // Only a real macro trigger is claimed; a requester's "!important ..."
    // or "?why is it down" stays a normal message.
    if (!macro || !macro.enabled) return false;
    if (!db.claimMessage(event.ts, event.channel)) return true;
    await postMacroEphemeral(client, event, "that one's helpers-only :nono:");
    return true;
  }

  if (!db.claimMessage(event.ts, event.channel)) return true;
  if (!macro || !macro.enabled) {
    await reactToMacroMessage(client, event, "question");
    const enabled = macros.list(program.id, { enabledOnly: true }).slice(0, 5).map((row) => row.trigger);
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

async function onMessage({ event, client }) {
  if (event.bot_id || event.subtype === "bot_message") return;
  if (stagingBlocked(event.channel)) return;

  // thread_broadcast replies are visible in-channel AND in-thread: handle them
  // exactly once as thread replies. Ticket creation dedupes on thread_ts, so
  // a broadcast can never become a second ticket. Everything else with a
  // subtype (edits, deletes, joins) stays ignored — an edit must not file a
  // new ticket, and a delete needs no reply.
  const allowedSubtypes = ["file_share", "thread_broadcast"];
  if (event.subtype && !allowedSubtypes.includes(event.subtype)) return;

  const threadTs = event.thread_ts || event.ts;
  const question = (event.text || "").trim();
  const isDm = isDirectMessage(event);
  const named = mentionsPixieByName(question);
  const pinged = mentionsPixieDirectly(question);

  const workspaceId = workspace.workspaceOf(event);
  if (await handleMacroTrigger({ event, client, workspaceId })) return;
  // Sandbox routing: production claim first, draft binding only when no
  // production program owns the channel. Drafts never appear in
  // programs.forChannel() and never create production claims.
  let productionProgramMatch = null;
  try {
    const candidate = programs.forChannel(event.channel, workspaceId);
    if (candidate && candidate.id && candidate.id !== "ysws-global") productionProgramMatch = candidate.id;
  } catch (error) {
    log.debug("draft", `production channel lookup failed: ${error.message}`);
  }
  if (!productionProgramMatch) {
    let draftBinding = null;
    try {
      draftBinding = require("./draftSandbox").getForChannel(event.channel, workspaceId);
    } catch (e) {
      log.warn("draft", `channel_id=${event.channel} message_ts=${event.ts} production_program_match=null draft_binding_match=error draft_safety_pass=false suppression_reason=binding_lookup_failed`);
    }
    if (draftBinding && draftBinding.enabled) {
      const draftProgramId = draftBinding.draftProgramId;
      const baseLog = `channel_id=${event.channel} message_ts=${event.ts} production_program_match=null draft_binding_match=${draftBinding.role} draft_program_id=${draftProgramId}`;
      // Ticket-sink bindings never answer; help bindings answer top-level and threads.
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
      // NOTE: Wizard draft posture=muted and tickets_enabled=false are
      // production flags and MUST NOT suppress this explicitly-authorized
      // sandbox path; sandbox posture is governed by the binding itself.
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
      } catch (e) {
        log.warn("draft", `${baseLog} draft_safety_pass=true suppression_reason=sandbox_ticket_failed`);
      }
      let corpus = "";
      try {
        corpus = require("./knowledge").getDraftContext(draftProgramId, question);
      } catch (e) {
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
      } catch (e) {
        log.warn("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=error suppression_reason=generation_failed`);
        return;
      }
      if (!answer?.answer) {
        // Fail closed but visibly: the sandbox is scoped to draft knowledge
        // only, so an unanswerable question gets a scoped fallback rather
        // than silence (silence is indistinguishable from a dead bot).
        const draftName = draftProgram?.name || draftProgramId;
        const fallback = `I don't have that in the ${draftName} draft knowledge yet — I'm scoped to ${draftName} sources only in this sandbox.`;
        try {
          await require("./slackMessages").sendProgramMessage({ client, program: draftProgram, channel: event.channel, threadTs, text: fallback });
          log.info("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=fallback slack_post_result=sent suppression_reason=no_grounded_answer`);
        } catch (e) {
          log.warn("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=fallback slack_post_result=failed suppression_reason=slack_post_failed`);
        }
        return;
      }
      try {
        await require("./slackMessages").sendProgramMessage({ client, program: draftProgram, channel: event.channel, threadTs, text: answer.answer });
        log.info("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=answered slack_post_result=sent`);
      } catch (e) {
        log.warn("draft", `${baseLog} draft_safety_pass=true classification=support retrieval_count=${retrievalCount} generation_result=answered slack_post_result=failed suppression_reason=slack_post_failed`);
      }
      return;
    }
  }
  // Requester writing back in their resolved thread reopens it. One indexed
  // lookup; helper chatter and unresolved threads pass through untouched.
  if (event.thread_ts && event.thread_ts !== event.ts && !event.bot_id) {
    try {
      await require("./tickets").noteThreadActivity({ channel: event.channel, threadTs: event.thread_ts, userId: event.user, text: event.text || null, workspaceId, client, parentUserId: event.parent_user_id || null });
    } catch (e) {
      log.debug("handlers", `thread activity tracking: ${e.message}`);
    }
  }
  // One resolver decides program and channel role (lib/channelPolicy.js).
  const policy = channelPolicy.resolve(event.channel, workspaceId, { isDm });
  const prog = policy.program;
  const inHelpChannel = policy.role === "help";
  const isProgChannel = policy.role === "main" || policy.role === "organizer";

  // Hard scope gate: a channel nobody claimed as a help/program/FAQ channel
  // gets total silence — no reply, no escalation, no teach, no image
  // handling. Being a member of a channel (Slack lets any admin invite the
  // bot anywhere) must never imply scope on its own; only an explicit claim
  // does. DMs are exempt — there's no "channel scope" concept for a 1:1.
  if (!isDm && !inHelpChannel && !isProgChannel) return;
  // Program switched Pixie off for this channel role: nothing at all.
  if (!isDm && policy.settings && policy.settings.enabled === false) return;

  // Recorded for every human message, including the ones pixie says nothing
  // about — the gate judges a message against what this person said just
  // before it, and most of that is in messages pixie never replied to.
  if (question) {
    db.recordUserMessage({ userId: event.user, channel: event.channel, threadTs, text: question });
  }

  log.debug(
    "message",
    `channel=${event.channel} dm=${isDm} thread=${event.thread_ts || "none"} ts=${event.ts} named=${named} pinged=${pinged} prog=${prog.id} posture=${prog.posture}`,
  );

  // Central reply-eligibility: mute, takeover, human-directed, referential,
  // sensitive, and noise decisions happen here, once, before any handler —
  // including vision and teach flows — so no path can bypass thread state.
  if (!event.bot_id && event.subtype !== "bot_message") {
    const elig = checkEligibility({ event, prog, workspaceId, threadTs, question, isDm });
    if (elig === "stop") {
      // WHY: ping fires twice (message + app_mention); claim silent pings
      // once so the mention pass skips already-counted work (B4 single).
      if (pinged) db.claimMessage(event.ts, event.channel);
      return;
    }
    if (elig === "escalate") {
      if (!db.claimMessage(event.ts, event.channel)) return;
      // Sensitive categories skip generation: straight to humans.
      await escalateSensitive({ event, client, prog, workspaceId, threadTs: event.thread_ts || event.ts, question, addressed: pinged || named || isDm });
      return;
    }
  }

  // Passive thread auto-capture disabled to prevent misinfo.
  // Learning is strictly restricted to explicit /pixie-teach commands or thread teach triggers.

  if (await refuseUnauthorizedCommand({ event, client, question, prog, policy })) return;

  // Handle !teach (and other teach triggers) in threads — helpers only
  if (await handleTeachRequest({ event, client, question, prog, mentionOnly: false, claimFirst: true })) return;

  // Handle !sum (and other summary triggers) — helpers only
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
    // respond() owns the normal text reservation. Keep the missing-identity
    // check here because its legacy non-DM contract permits anonymous calls.
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

  // The top-of-function scope gate already returned for any channel that is
  // neither inHelpChannel nor isProgChannel, so a bare-name mention outside
  // scope can no longer reach here — it used to get a DOCS_ONLY reply from
  // any channel the bot happened to be a member of, which is exactly the
  // "answers/escalates in channels nobody added it to" bug that gate fixes.

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
        // They said her name. What that allows (general chat, program facts
        // only) is the program's main-channel setting — see
        // lib/pipeline/messagePolicy.js.
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

  // Same cheap noise filter as threads: an emoji-only post costs no
  // classifier call and can never become a ticket.
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

async function onAppMention({ event, client }) {
  if (event.bot_id || event.subtype === "bot_message" || event.user === config.slack.botUserId) return;
  if (stagingBlocked(event.channel)) return;
  const workspaceId = workspace.workspaceOf(event);
  const question = stripBotMention(event.text);
  const threadTs = event.thread_ts || event.ts;

  // Hard scope gate, same as onMessage: an @-mention in a channel nobody
  // claimed as help/program/FAQ gets total silence. Being @-mentionable in a
  // channel (anyone can invite the bot) must never imply scope on its own —
  // this was previously unconditional here, meaning literally any channel
  // the bot was a member of got a full answer (and could escalate a ticket)
  // just from someone saying its name.
  const policy = channelPolicy.resolve(event.channel, workspaceId);
  const prog = policy.program;
  if (!["help", "main", "organizer"].includes(policy.role)) return;
  if (policy.settings && policy.settings.enabled === false) return;

  // The message event owns silent decisions and ordinary duplicate delivery.
  // When it already claimed this timestamp, app_mention must not record a
  // second metric or run eligibility again.
  if (db.wasAnswered(event.ts)) return;

  // Muted/takeover threads stay that way unless this mention reactivates
  // them ("come back", "help") — a bare mention earns at most one direct
  // answer further down, never a silent unmute.
  if (event.thread_ts && (db.isThreadMuted(event.thread_ts) || db.isTakeover(event.thread_ts))) {
    // WHY: onMessage already counted this ping; second pass skips work (B4).
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

  // app_mention is an addressed event, not an eligibility bypass. Keep the
  // same sensitive escalation, human deferral, and thread-state decisions as
  // the message event; only the positive reply is forced by the mention.
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

  // If a helper tags Pixie in a thread asking to teach / memorize the thread
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

// Only reached when a reaction event arrives without item_user. Thread replies
// are invisible to conversations.history, so try the thread first.
async function messageAuthor(client, channel, ts) {
  try {
    const replies = await client.conversations?.replies?.({ channel, ts, limit: 1, inclusive: true });
    if (replies?.messages?.[0]) return replies.messages[0].user || null;
  } catch (e) {
    log.debug("handlers", `replies lookup failed for ${ts}: ${e.message}`);
  }
  try {
    const hist = await client.conversations?.history?.({ channel, latest: ts, limit: 1, inclusive: true });
    return hist?.messages?.[0]?.user || null;
  } catch (e) {
    log.debug("handlers", `history lookup failed for ${ts}: ${e.message}`);
    return null;
  }
}

async function onReactionAdded({ event, client }) {
  if (event.item && stagingBlocked(event.item.channel)) return;
  // A reaction_added event carries the channel on event.item, not on the event
  // itself. Reading event.channel made every call below run with an undefined
  // channel; Slack's error was caught and logged at debug, so delete reactions
  // failed silently and the guide step was posted into nowhere.
  const channel = event.item?.channel || event.channel;
  const normReaction = (event.reaction || "").toLowerCase();

  if (DELETE_REACTIONS.has(normReaction)) {
    try {
      // item_user is the author of the message that was reacted to, which is
      // exactly the ownership check needed. The previous conversations.history
      // lookup could not answer it: history returns top-level messages only,
      // never thread replies, and pixie answers in threads — so the message was
      // never found and the delete never fired. It also required channel
      // membership pixie does not have everywhere (#pixl-help, for one).
      const author = event.item_user || (await messageAuthor(client, channel, event.item.ts));

      if (!author) {
        log.warn("handlers", `delete reaction on ${event.item.ts}: could not tell who wrote it`);
        return;
      }
      if (author !== config.slack.botUserId) return;

      await client.chat.delete({ channel, ts: event.item.ts });
      log.info("handlers", `deleted message ${event.item.ts} via reaction`);
    } catch (e) {
      // Deliberately louder than debug: a failed delete looks to whoever
      // reacted exactly like a bot that is ignoring them.
      log.warn("handlers", `could not delete ${event.item.ts}: ${e.data?.error || e.message}`);
    }
    return;
  }

  if (normReaction === GUIDE_ADVANCE_REACTION) {
    try {
      const guideState = db.getGuideByMessageTs(event.item.ts) || db.getGuide(event.item.ts);
      // A muted or taken-over thread parks its guide: advancing state without
      // posting would desync the walkthrough, so neither happens.
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
    } catch (e) {
      log.debug("guides", `reaction advance failed: ${e.message}`);
    }
  }

  const vote = UP_REACTIONS.has(normReaction) ? 1 : DOWN_REACTIONS.has(normReaction) ? -1 : 0;
  if (vote !== 0) {
    db.recordFeedback(event.item.ts, event.user, vote);
    log.info("feedback", `vote=${vote} ts=${event.item.ts} user=${event.user}`);
  }
}

async function onReactionRemoved({ event }) {
  const normReaction = (event.reaction || "").toLowerCase();
  if (UP_REACTIONS.has(normReaction) || DOWN_REACTIONS.has(normReaction)) {
    db.removeFeedback(event.item.ts, event.user);
  }
}

module.exports = {
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
