process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const llm = require("./llm");
const teachThread = require("./teachThread");
const { readSource } = require("./test-source");

let completeReply = "how do i join :: post in #pixl-help and a helper will add you";
let realComplete: any;
before(() => {
  realComplete = llm.complete;
  llm.complete = async () => ({ text: completeReply, finishReason: "stop" });
});
after(() => {
  llm.complete = realComplete;
});

function stubClient(messages: any[]) {
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

test("summarizeThread skips the model call on a thread with no text", async () => {
  const calls: any[] = [];
  const stub = llm.complete;
  llm.complete = async (...args: any[]) => {
    calls.push(args);
    return stub(...args);
  };

  const parsed = await teachThread.summarizeThread({
    client: stubClient([
      { ts: "1", user: "U1" },
      { ts: "2", bot_id: "B1" },
    ]),
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

test("teachThread is read-only — fetch-only client, no db writes", async () => {
  const fs = require("fs");
  const path = require("path");
  const src = readSource("teachThread.js");
  assert.equal(src.includes("postMessage"), false);
  assert.equal(src.includes("postEphemeral"), false);
  assert.equal(src.includes('require("./db")'), false);
  assert.equal(/INSERT\s+INTO/i.test(src), false);
  assert.equal(/DELETE\s+FROM/i.test(src), false);
  assert.equal(teachThread.THREAD_FETCH_LIMIT, 50);
  const seen: any[] = [];
  const client = {
    conversations: {
      replies: async (args: any) => {
        seen.push(args);
        return { messages: [{ text: "how do i join pixl", user: "U1" }] };
      },
    },
  };
  const parsed = await teachThread.summarizeThread({ client, channel: "C1", threadTs: "char-tt-1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].limit, 50);
  assert.equal(seen[0].channel, "C1");
  assert.ok(parsed && typeof parsed.question === "string" && typeof parsed.answer === "string");
  assert.ok(!("programId" in parsed), "teachThread returns pure Q&A — the caller attaches the program");
});

test("teachThread output feeds program-scoped capture without cross-writing", async () => {
  const learn = require("./learn");
  const db = require("./db");
  const parsed = await teachThread.summarizeThread({
    client: stubClient([
      { text: "char how do i join", user: "U1" },
      { bot_id: "B1", text: "char post in #pixl-help" },
    ]),
    channel: "C1",
    threadTs: "char-tt-scope",
  });
  assert.ok(parsed && parsed.question && parsed.answer);
  const idA = learn.captureFromThread({
    ...parsed,
    authorId: "U1",
    threadTs: "char-tt-scope-a",
    channel: "C1",
    programId: "char-tt-prog-a",
  });
  const idB = learn.captureFromThread({
    ...parsed,
    authorId: "U1",
    threadTs: "char-tt-scope-b",
    channel: "C1",
    programId: "char-tt-prog-b",
  });
  assert.ok(idA && idB && idA !== idB);
  const rowA = db.getLearnedFactById(idA);
  const rowB = db.getLearnedFactById(idB);
  assert.equal(rowA.program_id, "char-tt-prog-a");
  assert.equal(rowB.program_id, "char-tt-prog-b");
  assert.equal(rowA.status, "pending");
  assert.doesNotMatch(
    learn.corpusSection("char-tt-prog-a"),
    new RegExp(parsed.question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(learn.approve(idA), true);
  assert.equal(db.getLearnedFactById(idA).status, "approved");
});

test("buildTranscript is pure and labels senders deterministically", () => {
  assert.equal(teachThread.buildTranscript([]), "");
  assert.equal(teachThread.buildTranscript([{ user: "U1" }, { bot_id: "B1" }]), "");
  assert.equal(teachThread.buildTranscript([{ text: "q", user: "U9" }]), "user: q");
});

test("registry: teach output lands as a program-scoped auditable fact", async () => {
  const learn = require("./learn");
  const db = require("./db");
  const parsed = await teachThread.summarizeThread({
    client: stubClient([
      { text: "registry how do i join", user: "U1" },
      { bot_id: "B1", text: "registry post in #pixl-help" },
    ]),
    channel: "C-REG",
    threadTs: "reg-teach-1",
  });
  assert.ok(parsed && parsed.question && parsed.answer);
  const id = learn.teach({
    ...parsed,
    authorId: "U-HELPER-REG",
    threadTs: "reg-teach-1",
    channel: "C-REG",
    programId: "reg-prog",
  });
  assert.ok(id);
  const row = db.getLearnedFactById(id);
  assert.equal(row.question, parsed.question, "content: question");
  assert.equal(row.answer, parsed.answer, "content: answer");
  assert.equal(row.author_id, "U-HELPER-REG", "author");
  assert.equal(row.status, "approved", "explicit teach enters active memory");
  assert.equal(row.program_id, "reg-prog", "program scope");
  assert.equal(row.source_ts, "reg-teach-1", "optional source thread");
  assert.equal(row.channel, "C-REG", "optional source channel");
  assert.ok(Number.isInteger(row.created_at) && row.created_at > 0, "created_at stamped");
});
export {};
