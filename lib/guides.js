// Interactive step-by-step guides for common workflows.
//
// The original version advanced on *any* reply and matched its alternate paths
// with `response.includes("not enough RE")` — literal phrases nobody types, so
// every alternate branch was unreachable and "wait, what?" marched the user to
// the next step. Progression is now model-checked: the reply is classified as
// advancing, stuck (with which alternate), off-topic, or done.
const { config } = require("./config");
// Module object rather than a destructured `complete`, so tests can stub it —
// destructuring binds at load time. Same reason lib/learn.js holds it this way.
const llm = require("./llm");
const { looksLikeHelpRequest } = require("./intent");
const db = require("./db");
const log = require("./log");

const MAX_TOKENS = 20;
const TIMEOUT_MS = 10000;

const ADVANCE = "ADVANCE";
const STUCK = "STUCK";
const OTHER = "OTHER";
const DONE = "DONE";

// Typed anywhere in a guide thread, bails out immediately. Checked before the
// model call so quitting is always free and always works.
const EXIT_PATTERN = /^\s*(?:stop|quit|exit|cancel|nvm|nevermind|never mind|forget it|no thanks|nah im good|nah i'm good)\b/i;

const GUIDES = {
  "next-region": {
    name: "How to unlock the next region",
    steps: [
      {
        message: "alright so to unlock a new region you gotta complete sidequests and earn restoration energy (RE) :yay:",
        checkNext: "Check your current RE on the game dashboard at https://play.pixl.rsvp/ — how much RE do you have rn?",
      },
      {
        message: "nice! each region needs a certain amount of RE to unlock. the game shows you the requirement when you try to enter a locked region.",
        checkNext: "Have you finished all the sidequests in your current region? (yes/no)",
      },
      {
        message: "cool — once you finish all sidequests in a region and have enough RE, the next region auto-unlocks. just head to the map and click the newly available region :3c:",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "not enough restoration energy": "you need more restoration energy! ship more projects to earn RE — each approved sidequest gives you RE based on the time you spent building it",
      "stuck on a specific sidequest": "which sidequest are you stuck on? i can help with specific questions or you can ask a helper in this channel :hii:",
    },
  },

  "git-setup": {
    name: "Setting up Git and GitHub",
    steps: [
      {
        message: "let's get git set up! first, do you have git installed? try running `git --version` in your terminal",
        checkNext: "Does it show a version number or say command not found?",
      },
      {
        message: 'great! now let\'s configure it with your info. run these two commands:\n```\ngit config --global user.name "Your Name"\ngit config --global user.email "your@email.com"\n```\nUse the same email as your GitHub account so commits link to your profile.',
        checkNext: "Done? (yes/no)",
      },
      {
        message: "awesome! now create a new repo on GitHub, then it'll show you commands like:\n```\ngit remote add origin https://github.com/yourusername/yourproject.git\ngit branch -M main\ngit push -u origin main\n```\nRun those in your project folder to push your code up :yesyes:",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "git is not installed / command not found": "you need to install git first! check out https://www.pixl.rsvp/docs#git for install instructions for your OS",
      "permission denied or SSH key error": "looks like an ssh key issue — easiest fix is to use HTTPS instead of SSH when GitHub gives you the remote URL",
    },
  },

  hackatime: {
    name: "Setting up Hackatime for time tracking",
    steps: [
      {
        message: "hackatime tracks your coding time automatically! first, what editor/IDE are you using? (VS Code, Cursor, Zed, something else?)",
        checkNext: null,
      },
      {
        message: "perfect! for VS Code/Cursor, install the WakaTime extension, then plug in your Hackatime API key and URL from your account. save some code and check the dashboard after a few minutes to make sure it's logging :3c:",
        checkNext: "Is it showing up on your Hackatime dashboard? (yes/no)",
      },
      {
        message: "nice! keep working and it'll track automatically. each project folder = one project, so keep different projects in separate folders if you're juggling multiple :yay:",
        checkNext: null,
      },
    ],
    alternateSteps: {
      "time is not being tracked": "try these: 1) make sure you saved your files after editing, 2) check the WakaTime extension status in the bottom bar, 3) verify your API key and URL are correct in settings",
      "time is logged under the wrong project": "hackatime groups by folder name — rename your project folder or check the dashboard settings to merge/split projects",
    },
  },
};

// Guide selection used to be `q.includes("hackatime")`, which meant one typo
// killed it: the live gap log has "pixie help me setup hackatimm" recorded as a
// docs miss, and `active_guides` had never held a row. Detection is now two
// passes — a free fuzzy one that catches the typo, then the model for phrasings
// no keyword list would predict.
//
// `subject` groups are synonyms and every group must match; `hints` say the
// person wants to be walked through it rather than just mentioning the word.
//
// The subject list does double duty: mentionsGuideSubject uses it alone to
// decide whether the model pass is worth a call at all, so a synonym missing
// here means that guide is unreachable for anyone who doesn't name it. Hence
// "hours" — "how do i make my coding hours count" is a hackatime question that
// never says hackatime.
const GUIDE_TRIGGERS = [
  ["next-region", { subject: [["region", "regions"]], hints: ["unlock", "next", "new", "open"] }],
  [
    "git-setup",
    { subject: [["git", "github"]], hints: ["setup", "set", "install", "configure", "config", "start", "push"] },
  ],
  [
    "hackatime",
    {
      subject: [["hackatime", "wakatime", "hours"]],
      hints: ["setup", "set", "install", "track", "tracking", "time", "log"],
    },
  ],
];

// Budget scales with length because a fixed one is wrong at both ends: 2 edits
// on a three-letter word turns "get" into "git", while 1 edit isn't enough slack
// for a word as long as "hackatime".
function editBudget(word) {
  if (word.length <= 4) return 0;
  if (word.length <= 7) return 1;
  return 2;
}

// Damerau-Levenshtein, not plain Levenshtein: a swapped pair of letters is the
// most common typo there is, and plain edit distance scores it 2, which puts
// "regoin" out of reach of a 1-edit budget for "region". Counting a transposition
// as one edit is what makes the budgets below tight enough to be safe and loose
// enough to be useful.
//
// Stops as soon as an entire row exceeds the budget — this runs per token per
// guide on every message, so the early exit matters more than the exact distance
// once we're past the threshold.
function withinEdits(a, b, budget) {
  if (Math.abs(a.length - b.length) > budget) return false;

  let prevPrev = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      row[j] = value;
      if (value < best) best = value;
    }
    if (best > budget) return false;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length] <= budget;
}

function matchesToken(tokens, word) {
  const budget = editBudget(word);
  return tokens.some((t) => (budget === 0 ? t === word : withinEdits(t, word, budget)));
}

// Splitting the question into words once, shared by every pass below.
function tokensOf(question) {
  return (question || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// The free pass. Returns a guide id or null; never makes a network call.
function detectGuideByKeyword(question) {
  const tokens = tokensOf(question);
  if (tokens.length === 0) return null;

  for (const [id, trigger] of GUIDE_TRIGGERS) {
    const hasSubject = trigger.subject.every((group) => group.some((word) => matchesToken(tokens, word)));
    if (hasSubject && trigger.hints.some((word) => matchesToken(tokens, word))) return id;
  }
  return null;
}

function guideChooserPrompt() {
  const catalogue = Object.entries(GUIDES)
    .map(([id, guide]) => `${id}: ${guide.name}`)
    .join("\n");

  return [
    "Pixie can walk someone through a few setup workflows step by step.",
    "",
    "Available walkthroughs:",
    catalogue,
    "",
    "Decide whether this person is asking to be walked through one of them.",
    "Reply with EXACTLY the id, or NONE.",
    "",
    "Pick a walkthrough only when they want to be taken through the process.",
    "Answer NONE for a one-off factual question about the same topic — those are better",
    "answered from the docs than by starting a multi-step walkthrough they didn't ask for.",
  ].join("\n");
}

// Second pass. Only reached when the keyword pass missed AND the message is
// already a help request, so ordinary chat never pays for it. Runs before the
// answer path rather than alongside it — a guide match replaces the answer call
// instead of adding to it.
async function detectGuideByModel(question) {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: guideChooserPrompt() },
          { role: "user", content: question },
        ],
      },
      "guides",
    );

    const label = (text || "").trim().toLowerCase();
    return Object.keys(GUIDES).find((id) => label.startsWith(id)) || null;
  } catch (e) {
    log.debug("guides", `guide selection failed: ${e.message}`);
    return null;
  }
}

// Is there any guide this message could possibly be about? Same fuzzy match as
// the keyword pass, but only on the SUBJECT groups — the hints are dropped, so
// merely naming git or hackatime is enough to qualify.
//
// This exists because the model pass ran on every help-shaped message the
// keyword pass missed, which is nearly all of them: ~1700ms of latency added in
// front of the answer call, to return NONE. A question that never mentions a
// region, git or hackatime — however badly typed — has no guide to choose.
function mentionsGuideSubject(question) {
  const tokens = tokensOf(question);
  if (tokens.length === 0) return false;
  return GUIDE_TRIGGERS.some(([, trigger]) =>
    trigger.subject.every((group) => group.some((word) => matchesToken(tokens, word))),
  );
}

async function detectGuideIntent(question) {
  const byKeyword = detectGuideByKeyword(question);
  if (byKeyword) return byKeyword;
  if (!mentionsGuideSubject(question)) return null;
  if (!looksLikeHelpRequest(question)) return null;
  return detectGuideByModel(question);
}

function isExitRequest(text) {
  return EXIT_PATTERN.test(text || "");
}

function stepPayload(step, guideName = null) {
  return { message: step.message, checkNext: step.checkNext || null, guideName };
}

function startGuide(guideId, threadTs, userId) {
  const guide = GUIDES[guideId];
  if (!guide) return null;

  db.saveGuide(threadTs, guideId, 0, userId);
  return stepPayload(guide.steps[0], guide.name);
}

function isInGuide(threadTs) {
  return !!db.getGuide(threadTs);
}

function cancelGuide(threadTs) {
  db.deleteGuide(threadTs);
}

function classifierPrompt(guide, step, alternateKeys) {
  const alternates = alternateKeys.map((k, i) => `STUCK_${i + 1}: they hit this problem — ${k}`).join("\n");

  return [
    `A user is being walked through: "${guide.name}".`,
    `The step they were just given: "${step.message}"`,
    step.checkNext ? `They were asked: "${step.checkNext}"` : "",
    "",
    "Classify their reply as EXACTLY one of these labels, nothing else:",
    `${ADVANCE}: they did the step / answered it / are ready to move on`,
    alternates,
    `${OTHER}: they asked a different question, or said something unrelated to this step`,
    `${DONE}: they want to stop the walkthrough`,
    "",
    "Answer with just the label.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Classifies the user's reply against the current step. Falls back to ADVANCE
// on failure so an API outage can't strand someone mid-guide.
async function classifyStepReply(guide, step, alternateKeys, userResponse) {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: MAX_TOKENS,
        temperature: 0.2,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: classifierPrompt(guide, step, alternateKeys) },
          { role: "user", content: userResponse },
        ],
      },
      "guides",
    );

    const label = (text || "").trim().toUpperCase();
    if (label.startsWith(DONE)) return { kind: DONE };
    if (label.startsWith(OTHER)) return { kind: OTHER };
    if (label.startsWith("STUCK_")) {
      const index = Number(label.slice("STUCK_".length).match(/^\d+/)?.[0]) - 1;
      if (alternateKeys[index]) return { kind: STUCK, alternateKey: alternateKeys[index] };
    }
    return { kind: ADVANCE };
  } catch (e) {
    log.debug("guides", `step classification failed (${e.message}), advancing`);
    return { kind: ADVANCE };
  }
}

// Returns a payload to post, or null when the caller should handle the message
// normally instead (off-topic question, or no active guide).
//
//   { message, checkNext }            -> next step / alternate advice
//   { message, completed: true }      -> guide finished
//   { message, cancelled: true }      -> user bailed out
//   null                              -> not a guide reply, answer it normally
async function continueGuide(threadTs, userResponse) {
  const state = db.getGuide(threadTs);
  if (!state) return null;

  const guide = GUIDES[state.guide_id];
  if (!guide) {
    db.deleteGuide(threadTs);
    return null;
  }

  if (isExitRequest(userResponse)) {
    db.deleteGuide(threadTs);
    return { message: "no worries, stopping there — ping me if you wanna pick it back up :hii:", cancelled: true };
  }

  const step = guide.steps[state.current_step];
  const alternateKeys = Object.keys(guide.alternateSteps || {});
  const verdict = await classifyStepReply(guide, step, alternateKeys, userResponse);

  if (verdict.kind === DONE) {
    db.deleteGuide(threadTs);
    return { message: "cool, stopping the walkthrough — lmk if you need anything else :hii:", cancelled: true };
  }

  // Off-topic: leave the guide parked and let the normal answer path handle it,
  // so a real question mid-guide still gets a real answer.
  if (verdict.kind === OTHER) return null;

  if (verdict.kind === STUCK) {
    return { message: guide.alternateSteps[verdict.alternateKey], checkNext: null, isAlternate: true };
  }

  const nextIndex = state.current_step + 1;
  if (nextIndex >= guide.steps.length) {
    db.deleteGuide(threadTs);
    return { message: "all set! lmk if you hit any issues :hii:", completed: true };
  }

  db.saveGuide(threadTs, state.guide_id, nextIndex, state.user_id);
  return stepPayload(guide.steps[nextIndex]);
}

module.exports = {
  GUIDES,
  detectGuideIntent,
  detectGuideByKeyword,
  mentionsGuideSubject,
  guideChooserPrompt,
  startGuide,
  continueGuide,
  isInGuide,
  cancelGuide,
  isExitRequest,
  classifierPrompt,
  ADVANCE,
  STUCK,
  OTHER,
  DONE,
};
