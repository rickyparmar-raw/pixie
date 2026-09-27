
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const answer = require("./answer");
const identity = require("./identity");
const llm = require("./llm");

const B2B_HELP = "C0BMHSDL597";
const B2B_ORG = "C0BNAHC0GSD";
const B2B_MAIN = "C0BBY3B43EJ";
const PIXL_HELP = "C0B6STY9G5N";

const FLEET = JSON.stringify([
  {
    id: "back-to-basics",
    name: "Back to Basics",
    supportName: "B2B Support",
    scope: "program",
    posture: "active",
    sharedSources: false,
    helpChannel: B2B_HELP,
    channels: [B2B_HELP],
    organizerChannel: B2B_ORG,
    sources: [
      {
        name: "Back to Basics Docs",
        type: "text",
        siteUrl: "https://back-to-basics-cyan.vercel.app/docs",
        content: [
          "## How it works",
          "Back to Basics is a Hack Club YSWS where you code something you would normally vibe-code, learn from it, ship it, and get rewards. Time is tracked with Hackatime plus an agent hook that watches AI usage. Aim for low AI usage; high AI usage gets your project deflated. Projects are not rejected unless there is clearly no human input.",
          "",
          "## Devlog requirements",
          "Every devlog needs five things: a specific broadly-applicable topic, a detailed explanation of what you learned, your own code implementation, an optional Lapse section, and citations. All code shown in a journal must be written by you, never AI generated.",
          "",
          "## Demo requirements",
          "Drop in the deployed link so a reviewer can click it and play with your project in the browser. If it genuinely is not deployable, link a downloadable build a reviewer can run. A bare source repo is not a playable link.",
          "",
          "## GitHub repo requirements",
          "All project source code must be on GitHub: the source itself not a compiled version, any dependency files, and a .gitignore where needed. Keep the repo clean.",
          "",
          "## AI policy",
          "AI is not prohibited, but AI-generating the parts you are meant to be learning is a problem. There is no percentage cap; the agent hook measures usage and heavy usage leads to deflation.",
          "",
          "## Rewards",
          "You earn coins from a mix of tracked hours and graded journal quality: roughly 0.3 coins per hour at the base, more as journal quality goes up. You need both hours and journals; one without the other earns almost nothing.",
          "",
          "## Where to get help",
          "Ask questions in #back-to-basics-support.",
        ].join("\n"),
      },
    ],
    guides: ["submit-ysws-guidelines"],
    links: { docs: "https://back-to-basics-cyan.vercel.app/docs" },
  },
  {
    id: "pixl",
    name: "Pixl",
    supportName: "Pixie",
    scope: "program",
    posture: "passive",
    helpChannel: PIXL_HELP,
    channels: [PIXL_HELP],
    pinnedRules: [
      "- 30% AI POLICY: Software and firmware code is capped at a hard ceiling of <=30% AI code.",
      "- REFERRAL CODES: Referral codes expire in 48 hours (2 days) after being generated.",
    ],
    sources: [
      {
        name: "Pixl Docs",
        type: "text",
        siteUrl: "https://pixl.hackclub.com/docs",
        content: [
          "## AI usage",
          "Pixl caps AI-written software code at 30 percent. Hardware CAD, PCB designs and 3D models must be 100% original with 0% AI.",
          "",
          "## Referrals",
          "Pixl referral codes expire 48 hours after they are generated.",
          "",
          "## Shop",
          "The Pixl shop sells items priced in px. A macropad kit is 700 px.",
          "",
          "## Restoration energy",
          "Restoration energy refills once per day and is spent to keep a submission alive.",
          "",
          "## Where to get help",
          "Ask in #pixl-help.",
        ].join("\n"),
      },
    ],
    guides: ["submit-ysws-guidelines"],
    links: { docs: "https://pixl.hackclub.com/docs" },
  },
  {
    id: "ysws-global",
    name: "YSWS Global",
    sources: [
      {
        name: "YSWS Submission Guidelines",
        type: "text",
        content: "## AI policy\nAcross YSWS, AI-written code is capped at a hard ceiling of 30% of the total. Your README must be written by you, not AI.",
      },
    ],
  },
]);

let savedBlob: string | undefined;
const realComplete = llm.complete;

before(() => {
  db.close();
  db.open(":memory:");
  savedBlob = process.env.PIXIE_PROGRAMS_JSON;
});

beforeEach(async () => {
  process.env.PIXIE_PROGRAMS_JSON = FLEET;
  programs.invalidate();
  knowledge.invalidate();
  const axios = require("axios");
  const realGet = axios.get;
  axios.get = async () => {
    throw new Error("network disabled in test");
  };
  try {
    await knowledge.refreshCorpus();
  } finally {
    axios.get = realGet;
  }
});

after(() => {
  llm.complete = realComplete;
  if (savedBlob === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedBlob;
  programs.invalidate();
  knowledge.invalidate();
});

afterEach(() => {
  llm.complete = realComplete;
});


test("the B2B help channel routes to B2B; a channel Pixie isn't in does not", () => {
  assert.equal(programs.forChannel(B2B_HELP).id, "back-to-basics");
  assert.equal(programs.forChannel(PIXL_HELP).id, "pixl");
  assert.equal(programs.isHelpChannel(B2B_HELP), true);
  assert.notEqual(programs.forChannel(B2B_MAIN).id, "back-to-basics");
});

test("B2B is program-scoped, active, and tickets route to its private organizer channel", () => {
  assert.equal(programs.scope("back-to-basics"), "program");
  assert.equal(programs.isProgramScoped("back-to-basics"), true);
  assert.equal(programs.posture("back-to-basics"), "active");
  assert.equal(programs.ticketsEnabled("back-to-basics"), true);
  const tickets = require("./tickets");
  assert.equal(tickets.getOrganizerChannel(programs.get("back-to-basics")), B2B_ORG);
});

test("Pixl stays passive with no organizer channel — it does not open tickets", () => {
  assert.equal(programs.posture("pixl"), "passive");
  const tickets = require("./tickets");
  assert.equal(tickets.getOrganizerChannel(programs.get("pixl")), null);
});


test("B2B identity uses its own support name and never says Pixl or offers a redirect", () => {
  const text = identity.corpusSection(programs.get("back-to-basics"));
  assert.match(text, /I'm B2B Support,/);
  assert.match(text, /Back to Basics/);
  assert.doesNotMatch(text, /\bPixl\b/);
  assert.doesNotMatch(text, /Pixorpheus/);
  assert.doesNotMatch(text, /point you at that program's channel/i);
  assert.match(text, /Here I only do Back to Basics/);
});


test("B2B prompt names B2B, uses the B2B help channel, and carries none of Pixl's pinned policy", () => {
  const b2b = programs.get("back-to-basics");
  for (const prompt of [
    answer.systemPrompt("corpus", "", b2b, B2B_HELP),
    answer.answerOrChatPrompt("corpus", "", true, b2b, B2B_HELP),
  ]) {
    assert.match(prompt, /Back to Basics/);
    assert.match(prompt, new RegExp(`<#${B2B_HELP}>`));
    assert.doesNotMatch(prompt, /30% AI POLICY/);
    assert.doesNotMatch(prompt, /REFERRAL CODES/);
    assert.doesNotMatch(prompt, /100% original CAD/i);
    assert.doesNotMatch(prompt, /#pixl-help/);
    assert.doesNotMatch(prompt, /\bPixl\b/);
  }
});

test("in a B2B channel the prompt forbids naming or redirecting to another program", () => {
  const prompt = answer.systemPrompt("corpus", "", programs.get("back-to-basics"), B2B_HELP);
  assert.match(prompt, /This is a Back to Basics channel only/);
  assert.match(prompt, /sounds like another program's name is still a Back to Basics question/);
});


test("the B2B retrieval namespace contains B2B docs and none of Pixl's", () => {
  const ctx = knowledge.getContext("how does back to basics work", "back-to-basics");
  assert.match(ctx, /vibe-code|Hackatime|agent hook/i);
  assert.doesNotMatch(ctx, /restoration energy/i);
  assert.doesNotMatch(ctx, /macropad kit is 700 px/i);
  assert.doesNotMatch(ctx, /referral codes expire/i);
});

test("Pixl's namespace is unchanged and does not see B2B docs", () => {
  const ctx = knowledge.getContext("how do referrals work", "pixl");
  assert.match(ctx, /referral codes expire 48 hours/i);
  assert.doesNotMatch(ctx, /vibe-code/i);
});

test("B2B does not inherit the shared YSWS submission guidelines", () => {
  const b2bAi = knowledge.getContext("can i use ai on my project", "back-to-basics");
  assert.doesNotMatch(b2bAi, /hard ceiling of 30%/i);
  assert.doesNotMatch(b2bAi, /README must be written by you, not AI/i);
  assert.match(b2bAi, /no percentage cap|agent hook/i);
  const pixlAi = knowledge.getContext("can i use ai on my project", "pixl");
  assert.match(pixlAi, /30 percent|30%/i);
  assert.doesNotMatch(pixlAi, /hard ceiling of 30% of the total/i);
});


const SHARED_VOCAB_CASES = [
  ["can i use ai on my project", /no percentage cap|agent hook|deflation/i, /30 percent|<=30%/i],
  ["how do coins work", /0\.3 coins per hour|graded journal quality/i, /priced in px|700 px/i],
  ["do i need a github repo", /source code must be on GitHub/i, /100% original/i],
  ["what are the demo requirements", /deployed link|downloadable build/i, /px\b/i],
  ["how are journals reviewed", /five things|topic|explanation|citations/i, /restoration energy/i],
];

for (const [q, wantB2B, mustNotLeak] of SHARED_VOCAB_CASES) {
  test(`B2B question "${q}" retrieves B2B facts, not Pixl's`, () => {
    const ctx = knowledge.getContext(q, "back-to-basics");
    assert.match(ctx, wantB2B, `expected B2B fact for "${q}"`);
    assert.doesNotMatch(ctx, mustNotLeak, `Pixl leak for "${q}"`);
  });
}


test("the B2B corpus retrieved for a real question carries B2B facts into the prompt and nothing of Pixl's", () => {
  for (const q of [
    "how does back to basics work",
    "what are the demo requirements",
    "do journals give more coins",
    "can i use ai",
  ]) {
    const corpus = knowledge.getContext(q, "back-to-basics");
    assert.ok(corpus && corpus.trim(), `non-empty corpus for "${q}"`);
    const prompt = answer.systemPrompt(corpus, "", programs.get("back-to-basics"), B2B_HELP);
    assert.match(prompt, /Back to Basics/);
    assert.doesNotMatch(prompt, /restoration energy/i);
    assert.doesNotMatch(prompt, /referral codes expire/i);
    assert.doesNotMatch(prompt, /macropad kit is 700 px/i);
    assert.doesNotMatch(prompt, /30% AI POLICY/);
    assert.doesNotMatch(prompt, /\bPixl\b/);
  }
});

test("a grounded B2B reply is parsed and its help-channel reference points at B2B", () => {
  const parsed = answer.parseAnswerOrChat(
    "SOURCE: Where to get help\nANSWER: ask in #pixl-help if you get stuck",
    programs.get("back-to-basics"),
  );
  assert.equal(parsed.source, "Where to get help");
  assert.doesNotMatch(parsed.answer, /pixl/i);
  assert.match(parsed.answer, new RegExp(`<#${B2B_HELP}>`));
});

test("when B2B docs do not cover a question the model is told to decline, not invent or redirect", async () => {
  const prompt = answer.answerOrChatPrompt("### Back to Basics Docs\n(nothing about prize money)", "", true, programs.get("back-to-basics"), B2B_HELP);
  assert.match(prompt, new RegExp(answer.NONE_MARKER));
  assert.match(prompt, /Never invent a Back to Basics fact/i);
  assert.match(prompt, /a helper in this channel will pick it up/i);
  assert.doesNotMatch(prompt, /#pixl/i);
});


test("a url source crawls recursively within its path scope and canonicalises urls", async () => {
  const guard = require("./sourceGuard");
  const firecrawl = require("./firecrawl");
  const realGuard = guard.fetchSourceUrl;
  const realKey = firecrawl.getApiKey;
  firecrawl.getApiKey = () => null;
  const fetched: string[] = [];
  const pages: Record<string, string> = {
    "https://ex.test/docs": '<a href="/docs/a">a</a><a href="/docs/b/">b</a><a href="/other">out of scope</a><p>root</p>',
    "https://ex.test/docs/a": '<a href="/docs/c#frag">c</a><a href="/docs/a?x=1">self</a><p>page a xyz</p>',
    "https://ex.test/docs/b": "<p>page b qrs</p>",
    "https://ex.test/docs/c": "<p>page c tuv</p>",
    "https://ex.test/other": "<p>OUT_OF_SCOPE_MARKER</p>",
  };
  guard.fetchSourceUrl = async (url: string) => {
    fetched.push(url);
    if (pages[url] !== undefined) return { data: pages[url] };
    throw new Error(`404 ${url}`);
  };
  try {
    const text = await knowledge.fetchSourceText({ name: "Rec", type: "url", url: "https://ex.test/docs" }, true);
    assert.match(text, /page a xyz/);
    assert.match(text, /page b qrs/);
    assert.match(text, /page c tuv/);
    assert.doesNotMatch(text, /OUT_OF_SCOPE_MARKER/);
    assert.ok(!fetched.includes("https://ex.test/other"), "/other was never fetched");
    assert.equal(fetched.filter((u: string) => u === "https://ex.test/docs/a").length, 1, "/docs/a fetched once (query-string dupe collapsed)");
  } finally {
    guard.fetchSourceUrl = realGuard;
    firecrawl.getApiKey = realKey;
  }
});
export {};
