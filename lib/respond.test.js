process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const answer = require("./answer");
const llm = require("./llm");
const respond = require("./respond");

db.open(":memory:");

// respond() drives the model. Without this it makes a real call to the model API
// per assertion, which made the test slow, network-dependent, and non-hermetic —
// it timed out at node:test's 5s default whenever the API was having a slow
// minute, and a timed-out test also swallows the *next* file's tests under Bun's
// node:test shim ("test() inside another test() is not yet implemented").
// Returning null is the "docs didn't cover it" answer, which is the branch every
// assertion below is about.
answer.getGroundedAnswer = async () => null;
answer.getAnswerOrChat = async () => null;
// respond() also runs guide detection first, which falls back to a model call
// when its keyword pass misses. NONE keeps these tests on the answer path.
llm.complete = async () => ({ text: "NONE", finishReason: "stop" });

/* -------------------------------------------------- isClarifyingQuestion -- */
// Suppresses the reply that started this: an unaddressed message getting
// "sorry, what about ridit? could you clarify what you mean?" back.

test("isClarifyingQuestion catches a short question handed back to the user", () => {
  assert.equal(respond.isClarifyingQuestion("sorry, what about ridit? could you clarify what you mean?"), true);
  assert.equal(respond.isClarifyingQuestion("hmm what do you mean?"), true);
});

test("isClarifyingQuestion ignores replies that are not questions", () => {
  assert.equal(respond.isClarifyingQuestion("yeah just export it as a PNG at native size"), false);
  assert.equal(respond.isClarifyingQuestion(""), false);
  assert.equal(respond.isClarifyingQuestion(undefined), false);
});

// A real answer may still end in a question. Only the short ones — the ones
// that are nothing but the question — count as handing the work back.
test("isClarifyingQuestion ignores a real answer that ends in a question", () => {
  assert.equal(
    respond.isClarifyingQuestion(
      "check your canvas size is small, 32x32 or 16x16, and that you're exporting as PNG at native size" +
        " without scaling it up. the file extension matters too, so make sure that's right. does that sort it?",
    ),
    false,
  );
});

test("gap recording is gated on looksLikeHelpRequest", async () => {
  let escalateAdded = false;
  const mockClient = {
    chat: {
      postMessage: async () => ({ ts: "msg-1" }),
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: {
      add: async () => {
        escalateAdded = true;
      },
    },
  };

  const initialGaps = db.topGaps(100).length;

  // "thanks guys" is small talk -> should NOT record gap
  await respond.respond({
    client: mockClient,
    channel: "C-help",
    threadTs: "t-1",
    userId: "U1",
    question: "thanks guys",
    mode: respond.DOCS_ONLY,
  });

  assert.equal(db.topGaps(100).length, initialGaps);
  assert.equal(escalateAdded, false);

  // Help request miss in DOCS_ONLY -> SHOULD record gap
  await respond.respond({
    client: mockClient,
    channel: "C-help",
    threadTs: "t-2",
    userId: "U2",
    question: "my sprite wont load at all, what should i do?",
    mode: respond.DOCS_ONLY,
  });

  const afterGaps = db.topGaps(100);
  assert.equal(afterGaps.length, initialGaps + 1);
  assert.ok(afterGaps.some((g) => g.question === "my sprite wont load at all, what should i do?"));
});

test("respond refuses blocked local URLs with a friendly explanation", async () => {
  let postedText = "";
  const mockClient = {
    chat: {
      postMessage: async ({ text }) => {
        postedText = text;
        return { ts: "msg-blocked" };
      },
    },
  };

  const handled = await respond.respond({
    client: mockClient,
    channel: "C1",
    threadTs: "t-blocked",
    userId: "U1",
    question: "pixie how does this website look to u? http://localhost:8000",
    mode: respond.ALWAYS,
  });

  assert.equal(handled, true);
  assert.match(postedText, /localhost on your machine isn't reachable from the bot/);
});
