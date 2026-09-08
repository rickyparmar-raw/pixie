process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const llm = require("./llm");
const teachThread = require("./teachThread");

// Stubbed as a namespace call (llm.complete), not destructured, so these tests
// never touch the network — same convention as lib/learn.test.js.
let completeReply = "how do i join :: post in #pixl-help and a helper will add you";
// llm is a shared, cached module — every test file `require("./llm")`s the
// same exports object. Stubbing at require time (module top level) poisons it
// during Bun's collection phase, before any file's tests have run at all, so
// before()/after() bracket the stub around this file's own execution window
// instead — anything outside that window sees the real llm.complete.
let realComplete;
before(() => {
  realComplete = llm.complete;
  llm.complete = async () => ({ text: completeReply, finishReason: "stop" });
});
after(() => {
  llm.complete = realComplete;
});

function stubClient(messages) {
  return { conversations: { replies: async () => ({ messages }) } };
}

test("buildTranscript labels bot messages as assistant and drops empty text", () => {
  const transcript = teachThread.buildTranscript([
    { text: "how do i join", user: "U1" },
    { text: "" },
    { bot_id: "B1", text: "post in #pixl-help" },
  ]);
  assert.equal(transcript, "user: how do i join\nassistant: post in #pixl-help");
});

test("summarizeThread parses the model's question :: answer reply", async () => {
  const parsed = await teachThread.summarizeThread({
    client: stubClient([
      { text: "how do i join pixl", user: "U1" },
      { bot_id: "B1", text: "post in #pixl-help and a helper will add you" },
    ]),
    channel: "C1",
    threadTs: "1.1",
  });

  assert.deepEqual(parsed, {
    question: "how do i join",
    answer: "post in #pixl-help and a helper will add you",
  });
});

test("summarizeThread declines when the model finds nothing worth teaching", async () => {
  completeReply = "NONE";
  const parsed = await teachThread.summarizeThread({
    client: stubClient([{ text: "lol same", user: "U1" }]),
    channel: "C1",
    threadTs: "2.1",
  });
  completeReply = "how do i join :: post in #pixl-help and a helper will add you";

  assert.equal(parsed, null);
});

test("summarizeThread declines when the model's reply doesn't parse", async () => {
  completeReply = "just some prose with no separator";
  const parsed = await teachThread.summarizeThread({
    client: stubClient([{ text: "how do i join", user: "U1" }]),
    channel: "C1",
    threadTs: "3.1",
  });
  completeReply = "how do i join :: post in #pixl-help and a helper will add you";

  assert.equal(parsed, null);
});

// An empty or text-free thread must not spend a model call at all.
test("summarizeThread skips the model call on a thread with no text", async () => {
  const calls = [];
  const stub = llm.complete;
  llm.complete = async (...args) => {
    calls.push(args);
    return stub(...args);
  };

  const parsed = await teachThread.summarizeThread({
    client: stubClient([{ ts: "1", user: "U1" }, { ts: "2", bot_id: "B1" }]),
    channel: "C1",
    threadTs: "4.1",
  });
  llm.complete = stub;

  assert.equal(parsed, null);
  assert.equal(calls.length, 0);
});

test("summarizeThread declines when model only outputs thinking process", async () => {
  completeReply = `Here's a thinking process:

1. **Analyze User Input:**
- user asked something
Format: "question :: answer"

2. **Identify Core Topic:**
- show and tell`;
  const parsed = await teachThread.summarizeThread({
    client: stubClient([{ text: "wait whats the show and tell", user: "U1" }]),
    channel: "C1",
    threadTs: "5.1",
  });
  completeReply = "how do i join :: post in #pixl-help and a helper will add you";

  assert.equal(parsed, null);
});

test("summarizeThread ignores thinking process preamble and extracts the final Q&A line", async () => {
  completeReply = `Here's a thinking process:

1. **Analyze User Input:**
- notes
Format: "question :: answer"

2. **Core Topic:**
- show and tell

What is show and tell? :: Participants showcase their projects in a huddle, and winner gets pixels.`;
  const parsed = await teachThread.summarizeThread({
    client: stubClient([{ text: "wait whats the show and tell", user: "U1" }]),
    channel: "C1",
    threadTs: "6.1",
  });
  completeReply = "how do i join :: post in #pixl-help and a helper will add you";

  assert.deepEqual(parsed, {
    question: "What is show and tell?",
    answer: "Participants showcase their projects in a huddle, and winner gets pixels.",
  });
});

/* ------------------------------------------------------------------ */
/* STEP 1 characterization pins (SUPPORT teachThread): capture/        */
/* approval + program scoping. Append-only.                            */
/* ------------------------------------------------------------------ */

test("char: teachThread is read-only — fetch-only client, no db writes", async () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "teachThread.js"), "utf8");
  assert.equal(src.includes("postMessage"), false);
  assert.equal(src.includes("postEphemeral"), false);
  assert.equal(src.includes('require("./db")'), false);
  assert.equal(/INSERT\s+INTO/i.test(src), false);
  assert.equal(/DELETE\s+FROM/i.test(src), false);
  assert.equal(teachThread.THREAD_FETCH_LIMIT, 50);
  // summarizeThread only ever calls conversations.replies (read) + llm.
  const seen = [];
  const client = { conversations: { replies: async (args) => { seen.push(args); return { messages: [{ text: "how do i join pixl", user: "U1" }] }; } } };
  const parsed = await teachThread.summarizeThread({ client, channel: "C1", threadTs: "char-tt-1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].limit, 50);
  assert.equal(seen[0].channel, "C1");
  assert.ok(parsed && typeof parsed.question === "string" && typeof parsed.answer === "string");
  assert.ok(!("programId" in parsed), "teachThread returns pure Q&A — the caller attaches the program");
});

test("char: teachThread output feeds program-scoped capture without cross-writing", async () => {
  const learn = require("./learn");
  const db = require("./db");
  const parsed = await teachThread.summarizeThread({
    client: stubClient([{ text: "char how do i join", user: "U1" }, { bot_id: "B1", text: "char post in #pixl-help" }]),
    channel: "C1",
    threadTs: "char-tt-scope",
  });
  assert.ok(parsed && parsed.question && parsed.answer);
  const idA = learn.captureFromThread({ ...parsed, authorId: "U1", threadTs: "char-tt-scope-a", channel: "C1", programId: "char-tt-prog-a" });
  const idB = learn.captureFromThread({ ...parsed, authorId: "U1", threadTs: "char-tt-scope-b", channel: "C1", programId: "char-tt-prog-b" });
  assert.ok(idA && idB && idA !== idB);
  const rowA = db.getLearnedFactById(idA);
  const rowB = db.getLearnedFactById(idB);
  assert.equal(rowA.program_id, "char-tt-prog-a");
  assert.equal(rowB.program_id, "char-tt-prog-b");
  assert.equal(rowA.status, "pending");
  // Approval is explicit — capture never lands straight in the corpus.
  assert.doesNotMatch(learn.corpusSection("char-tt-prog-a"), new RegExp(parsed.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(learn.approve(idA), true);
  assert.equal(db.getLearnedFactById(idA).status, "approved");
});

test("char: buildTranscript is pure and labels senders deterministically", () => {
  assert.equal(teachThread.buildTranscript([]), "");
  assert.equal(teachThread.buildTranscript([{ user: "U1" }, { bot_id: "B1" }]), "");
  assert.equal(teachThread.buildTranscript([{ text: "q", user: "U9" }]), "user: q");
});

