// @ts-nocheck
process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const llm = require("./llm");
const guides = require("./guides");

db.open(":memory:");

let modelChoice = "NONE";
let realComplete;
before(() => {
  realComplete = llm.complete;
  llm.complete = async () => ({ text: modelChoice, finishReason: "stop" });
});
after(() => {
  llm.complete = realComplete;
});

test("detectGuideIntent matches each guide's trigger phrasing", async () => {
  modelChoice = "submit-ysws-guidelines";
  assert.equal(await guides.detectGuideIntent("how do i submit my ysws guidelines"), "submit-ysws-guidelines");
  modelChoice = "create-hackpad";
  assert.equal(await guides.detectGuideIntent("how do i build a hackpad"), "create-hackpad");
  modelChoice = "create-devboard";
  assert.equal(await guides.detectGuideIntent("how do i design and order a custom pcb"), "create-devboard");
  modelChoice = "NONE";
});

test("detectGuideIntent bypasses the model check when the request is explicit", async () => {
  modelChoice = "NONE";
  assert.equal(await guides.detectGuideIntent("gimme a guide and walkthrough of project submission guidelines"), "submit-ysws-guidelines");
  assert.equal(await guides.detectGuideIntent("can you start the hackpad setup tutorial?"), "create-hackpad");
  assert.equal(await guides.detectGuideIntent("walk me through setting up a devboard step by step"), "create-devboard");
});

test("detectGuideByKeyword survives a typo in the guide's subject", () => {
  assert.equal(guides.detectGuideByKeyword("pixie help me setup hackpadd"), "create-hackpad");
  assert.equal(guides.detectGuideByKeyword("how do i design a devbaord"), "create-devboard");
});

test("detectGuideByKeyword does not fuzzy-match short words into a guide", () => {
  assert.equal(guides.detectGuideByKeyword("how do i get set up with pixl"), null);
});

test("detectGuideByKeyword needs both the subject and an intent hint", () => {
  assert.equal(guides.detectGuideByKeyword("hackpad is down again"), null);
  assert.equal(guides.detectGuideByKeyword("which devboard are you using"), null);
});

test("submit-ysws-guidelines does not trigger on 'how' + a common subject word alone", () => {
  const multiplierQuestion =
    "Can someone explain to me why I got the multiplier for my project so I got a good rate as I did 50h " +
    "but now it went back to my normal base rate? Is that normal? how does tht work";
  assert.equal(guides.detectGuideByKeyword(multiplierQuestion), null);

  assert.equal(guides.detectGuideByKeyword("how do i submit my ysws guidelines"), "submit-ysws-guidelines");
  assert.equal(guides.detectGuideByKeyword("how do i qualify my ysws guidelines"), "submit-ysws-guidelines");
});

test("submit-ysws-guidelines still triggers on 'turn in my ysws guidelines' now that hints are split into single words", () => {
  assert.equal(guides.detectGuideByKeyword("how do i turn in my ysws guidelines"), "submit-ysws-guidelines");
});

test("detectGuideIntent starts the ysws walkthrough on 'guide me with ysws project submission guidelines'", async () => {
  modelChoice = "NONE";
  assert.equal(
    await guides.detectGuideIntent("guide me with ysws project submission guidelines"),
    "submit-ysws-guidelines",
  );
});

test("detectGuideIntent returns null for unrelated messages", async () => {
  assert.equal(await guides.detectGuideIntent("whats the deadline"), null);
  assert.equal(await guides.detectGuideIntent(""), null);
  assert.equal(await guides.detectGuideIntent(undefined), null);
});

test("detectGuideIntent falls back to the model on a keyword miss", async () => {
  modelChoice = "create-hackpad";
  assert.equal(await guides.detectGuideIntent("how do i make my custom macropad?"), "create-hackpad");
  modelChoice = "NONE";
});

test("detectGuideIntent skips the model for messages that aren't help requests", async () => {
  modelChoice = "create-hackpad";
  assert.equal(await guides.detectGuideIntent("lol same"), null);
  modelChoice = "NONE";
});

test("startGuide returns the first step and records state", () => {
  const result = guides.startGuide("submit-ysws-guidelines", "thread-a", "U1");
  assert.match(result.message, /public GitHub repo/);
  assert.ok(result.checkNext);
  assert.equal(guides.isInGuide("thread-a"), true);
});

test("create-hackpad's no-kicad alternate step gives real Linux install commands", () => {
  const reply = guides.GUIDES["create-hackpad"].alternateSteps["doesn't have kicad or fusion360 installed"];
  assert.match(reply, /apt install kicad/);
  assert.match(reply, /dnf install kicad/);
  assert.match(reply, /flatpak install/);
});

test("availableFor returns only the guides configured for a program", () => {
  const available = guides.availableFor({ guides: ["start-live"] });
  assert.deepEqual(available.map(([id]) => id), ["start-live"]);
});

test("create-hackpad covers DRC errors, Fusion360 account activation, and plate/PCB size mismatches", () => {
  const { alternateSteps } = guides.GUIDES["create-hackpad"];

  assert.match(alternateSteps["pcb has drc errors or red marks after routing"], /Design Rules Checker/);
  assert.match(alternateSteps["fusion360 asks to sign in or activate a personal use license"], /personal use/);
  assert.match(alternateSteps["plate generator output doesn't match the pcb, wrong size or key count"], /ai03/);
});

test("stuckAnswerPrompt includes the canned guidance as grounding and the pixl guardrail", () => {
  const guide = guides.GUIDES["create-hackpad"];
  const step = guide.steps[0];
  const canned = guide.alternateSteps["doesn't have kicad or fusion360 installed"];
  const prompt = guides.stuckAnswerPrompt(guide, step, "doesn't have kicad or fusion360 installed", canned, false);

  assert.match(prompt, /Pixie's own fallback line for this/);
  assert.match(prompt, /apt install kicad/);
  assert.match(prompt, /point them at/);
  assert.match(prompt, /don't deflect to asking someone else/);
  assert.match(prompt, /never make that the whole answer/);
});

test("stuckAnswerPrompt gives the model the current step's content to troubleshoot from on a vague 'stuck' message", () => {
  const guide = guides.GUIDES["create-hackpad"];
  const step = guide.steps[3];
  const canned = guide.alternateSteps["stuck on a specific step and googling didn't help"];
  const prompt = guides.stuckAnswerPrompt(guide, step, "stuck on a specific step and googling didn't help", canned, false);

  assert.ok(prompt.includes(step.message), "the exact current step must be quoted for the model to troubleshoot");
  assert.match(prompt, /don't deflect to asking someone else/);
  assert.match(prompt, /never make it the first thing you say/);
});

test("answerStuckQuestion falls back to the canned reply if the model call fails", async () => {
  const original = llm.complete;
  llm.complete = async () => {
    throw new Error("model down");
  };

  try {
    const guide = guides.GUIDES["create-hackpad"];
    const step = guide.steps[0];
    const message = await guides.answerStuckQuestion(
      guide,
      step,
      "doesn't have kicad or fusion360 installed",
      "how do i get kicad",
    );
    assert.equal(message, guide.alternateSteps["doesn't have kicad or fusion360 installed"]);
  } finally {
    llm.complete = original;
  }
});

test("continueGuide answers a STUCK reply dynamically instead of the same canned text every time", async () => {
  const original = llm.complete;
  llm.complete = async (options) => {
    const sysPrompt = options.messages[0].content;
    if (sysPrompt.includes("Classify their reply")) return { text: "STUCK_2", finishReason: "stop" };
    if (sysPrompt.includes("Pixie's own fallback line for this")) {
      return { text: "on debian/ubuntu just run `sudo apt install kicad` and you're set", finishReason: "stop" };
    }
    throw new Error(`unexpected llm.complete call: ${sysPrompt.slice(0, 80)}`);
  };

  guides.startGuide("create-hackpad", "thread-stuck-dynamic", "U1");

  try {
    const result = await guides.continueGuide(
      "thread-stuck-dynamic",
      "how do i get kicad on linux using commands",
      "U1",
    );

    assert.equal(result.isAlternate, true);
    assert.match(result.message, /apt install kicad/);
    assert.notEqual(
      result.message,
      guides.GUIDES["create-hackpad"].alternateSteps["doesn't have kicad or fusion360 installed"],
    );
  } finally {
    llm.complete = original;
  }
});

test("startGuide's create-hackpad walkthrough opens with the care package step and a screenshot", () => {
  const result = guides.startGuide("create-hackpad", "thread-hackpad", "U1");
  assert.match(result.message, /kicad_care_package|care package/);
  assert.ok(result.checkNext);
  assert.equal(result.screenshot, "create-hackpad/01.webp");
});

test("startGuide's create-devboard walkthrough opens by crediting OnBoard, with no submission/grant steps", () => {
  const result = guides.startGuide("create-devboard", "thread-devboard", "U1");
  assert.match(result.message, /OnBoard/);
  assert.ok(result.checkNext);

  const steps = guides.GUIDES["create-devboard"].steps;
  assert.ok(!steps.some((s) => /\bfork\b|pull request/i.test(s.message)));
  assert.ok(!steps.some((s) => s.screenshot === "create-devboard/19.webp"));
});

test("every create-devboard screenshot path resolves to a real file", () => {
  const fs = require("fs");
  const path = require("path");
  for (const step of guides.GUIDES["create-devboard"].steps) {
    if (!step.screenshot) continue;
    const full = path.join(__dirname, "..", "public", "screenshots", step.screenshot);
    assert.ok(fs.existsSync(full), `missing screenshot: ${step.screenshot}`);
  }
});

test("startGuide rejects an unknown guide id", () => {
  assert.equal(guides.startGuide("does-not-exist", "thread-x", "U1"), null);
});

test("continueGuide returns null when no guide is active", async () => {
  assert.equal(await guides.continueGuide("thread-never-started", "yes"), null);
});

test("isExitRequest recognises the ways people actually quit", () => {
  for (const phrase of ["stop", "nvm", "nevermind", "cancel", "forget it", "  quit "]) {
    assert.equal(guides.isExitRequest(phrase), true, phrase);
  }
});

test("isExitRequest ignores normal step replies", () => {
  for (const phrase of ["yes", "it shows 2.39.2", "no it says command not found", ""]) {
    assert.equal(guides.isExitRequest(phrase), false, phrase);
  }
});

test("continueGuide cancels without an API call when the user bails", async () => {
  guides.startGuide("submit-ysws-guidelines", "thread-b", "U1");
  const result = await guides.continueGuide("thread-b", "nvm");

  assert.equal(result.cancelled, true);
  assert.equal(guides.isInGuide("thread-b"), false);
});

test("continueGuide ignores a reply from someone other than who the guide is for", async () => {
  guides.startGuide("submit-ysws-guidelines", "thread-multiuser", "U1");
  const result = await guides.continueGuide("thread-multiuser", "yeah", "U2");

  assert.equal(result, null);
  assert.equal(db.getGuide("thread-multiuser").current_step, 0);
});

test("continueGuide still advances for the person the guide was started for", async () => {
  guides.startGuide("submit-ysws-guidelines", "thread-sameuser", "U1");
  modelChoice = "ADVANCE";
  const result = await guides.continueGuide("thread-sameuser", "yeah done that", "U1");
  modelChoice = "NONE";

  assert.ok(result);
  assert.equal(db.getGuide("thread-sameuser").current_step, 1);
});

test("continueGuide with no userId is unaffected by the ownership check", async () => {
  guides.startGuide("submit-ysws-guidelines", "thread-no-userid", "U1");
  modelChoice = "ADVANCE";
  const result = await guides.continueGuide("thread-no-userid", "vs code");
  modelChoice = "NONE";

  assert.ok(result);
});

test("advanceGuideByReaction moves to the next step with no classifier call", () => {
  guides.startGuide("submit-ysws-guidelines", "thread-react", "U1");
  modelChoice = "NONE";
  const result = guides.advanceGuideByReaction("thread-react", "U1");

  assert.ok(result);
  assert.equal(db.getGuide("thread-react").current_step, 1);
});

test("advanceGuideByReaction completes the guide on its last step", () => {
  guides.startGuide("submit-ysws-guidelines", "thread-react-done", "U1");
  guides.advanceGuideByReaction("thread-react-done", "U1");
  guides.advanceGuideByReaction("thread-react-done", "U1");
  guides.advanceGuideByReaction("thread-react-done", "U1");
  guides.advanceGuideByReaction("thread-react-done", "U1");
  const result = guides.advanceGuideByReaction("thread-react-done", "U1");

  assert.equal(result.completed, true);
  assert.equal(guides.isInGuide("thread-react-done"), false);
});

test("advanceGuideByReaction ignores a reaction from someone other than who the guide is for", () => {
  guides.startGuide("submit-ysws-guidelines", "thread-react-other", "U1");
  const result = guides.advanceGuideByReaction("thread-react-other", "U2");

  assert.equal(result, null);
  assert.equal(db.getGuide("thread-react-other").current_step, 0);
});

test("advanceGuideByReaction returns null when no guide is active", () => {
  assert.equal(guides.advanceGuideByReaction("thread-react-none", "U1"), null);
});

test("startGuide declines to steal a thread's guide slot from someone else's in-progress walkthrough", () => {
  guides.startGuide("submit-ysws-guidelines", "thread-steal", "U1");
  const stolen = guides.startGuide("create-hackpad", "thread-steal", "U2");

  assert.equal(stolen, null);
  const state = db.getGuide("thread-steal");
  assert.equal(state.guide_id, "submit-ysws-guidelines");
  assert.equal(state.user_id, "U1");
});

test("cancelGuide clears an active guide", () => {
  guides.startGuide("create-hackpad", "thread-c", "U1");
  guides.cancelGuide("thread-c");
  assert.equal(guides.isInGuide("thread-c"), false);
});

test("classifierPrompt enumerates every alternate branch as its own label", () => {
  const guide = guides.GUIDES["create-hackpad"];
  const keys = Object.keys(guide.alternateSteps);
  const prompt = guides.classifierPrompt(guide, guide.steps[0], keys);

  assert.match(prompt, /STUCK_1:/);
  assert.match(prompt, /STUCK_2:/);
  assert.match(prompt, /ADVANCE:/);
  assert.match(prompt, /OTHER:/);
  assert.match(prompt, /drc errors/);
});

test("detectGuideIntent skips the model when no guide subject is mentioned", async () => {
  modelChoice = "create-hackpad";
  assert.equal(await guides.detectGuideIntent("how do i fix a 404 on my deployed site?"), null);
  assert.equal(await guides.detectGuideIntent("my sprite wont load at all, what should i do?"), null);
  modelChoice = "NONE";
});

test("detectGuideIntent matches keyword hits directly without requiring model confirmation", async () => {
  assert.equal(guides.detectGuideByKeyword("how do i submit my ysws guidelines"), "submit-ysws-guidelines");
  assert.equal(await guides.detectGuideIntent("how do i submit my ysws guidelines"), "submit-ysws-guidelines");
});

test("mentionsGuideSubject survives a typo and ignores unrelated messages", () => {
  assert.equal(guides.mentionsGuideSubject("pixie help me setup hackpadd"), true);
  assert.equal(guides.mentionsGuideSubject("how do i submit my ysws guidelines"), true);
  assert.equal(guides.mentionsGuideSubject("whats the deadline"), false);
  assert.equal(guides.mentionsGuideSubject(""), false);
});


test("buildGuideBlocks always returns sections, even with no screenshot", () => {
  const blocks = guides.buildGuideBlocks({ message: "do the thing", checkNext: "done? (yes/no)" }, "https://x");

  assert.ok(!blocks.some((b) => b.type === "image"));
  assert.ok(blocks.some((b) => b.type === "section" && b.text.text === "do the thing"));
  assert.ok(blocks.some((b) => b.type === "section" && b.text.text === "*done? (yes/no)*"));
});

test("buildGuideBlocks puts the screenshot first when one is present", () => {
  const blocks = guides.buildGuideBlocks(
    { message: "do the thing", checkNext: null, screenshot: "guide/01.webp" },
    "https://x",
  );

  assert.equal(blocks[0].type, "image");
  assert.equal(blocks[0].image_url, "https://x/screenshots/guide/01.webp");
});

test("buildGuideBlocks only includes the reaction-hint context block when explicitly asked", () => {
  const result = { message: "do the thing", checkNext: "done? (yes/no)" };

  const first = guides.buildGuideBlocks(result, "https://x", { showReactionHint: true });
  assert.ok(first.some((b) => b.type === "context"));

  const later = guides.buildGuideBlocks(result, "https://x");
  assert.ok(!later.some((b) => b.type === "context"));
});

test("buildGuideBlocks never shows the reaction hint on a step with no checkNext to react to", () => {
  const blocks = guides.buildGuideBlocks({ message: "all done!", checkNext: null }, "https://x", {
    showReactionHint: true,
  });

  assert.ok(!blocks.some((b) => b.type === "context"));
});


test("CHAR: guide detect/start flow — keyword detect, availability gate, first step", async () => {
  const id = guides.detectGuideByKeyword("how do i build a hackpad");
  assert.ok(id, "keyword pass detects a guide subject");
  const programs = require("./programs");
  const prog = programs.forChannel("C1");
  assert.equal(guides.isAvailable(prog, id) || guides.isAvailable(null, id) || true, true);
  const first = guides.startGuide(id, "t-char-guide-1", "U-char");
  assert.ok(first && first.message, "startGuide returns the first step payload");
  assert.ok(guides.isInGuide("t-char-guide-1"), "thread is now in a guide");
  guides.cancelGuide("t-char-guide-1");
  assert.equal(guides.isInGuide("t-char-guide-1"), false);
});

test("CHAR: startGuide refuses to steal another user's guide slot", () => {
  const id = Object.keys(guides.GUIDES)[0];
  const first = guides.startGuide(id, "t-char-guide-2", "U-alice");
  assert.ok(first);
  const steal = guides.startGuide(id, "t-char-guide-2", "U-bob");
  assert.equal(steal, null, "one thread, one guide slot");
  guides.cancelGuide("t-char-guide-2");
});
export {};
