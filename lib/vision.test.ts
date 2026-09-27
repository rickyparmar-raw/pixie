// STEP 1 characterization pins for lib/vision.js (PLATFORM FOUNDATION).
// Image handling: Slack files fetched with the bot token, public URLs passed
// through, fetch failures surfaced as a friendly error, empty replies as null.
//
// NOTE: vision.js destructures `complete` from ./llm at require time, so the
// model leg is stubbed at the axios.post transport it rides on — same reason
// firecrawl.test.js brackets axios.post in before()/after().
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const vision = require("./vision");

let realPost: any;
let realGet: any;
before(() => {
  realPost = axios.post;
  realGet = axios.get;
});
after(() => {
  axios.post = realPost;
  axios.get = realGet;
});

test("char: system prompt embeds context and states the ground rules", () => {
  const withCtx = vision.visionSystemPrompt("order #12 stuck");
  assert.match(withCtx, /order #12 stuck/);
  assert.match(withCtx, /Only describe what you can actually see/i);
  const bare = vision.visionSystemPrompt("");
  assert.doesNotMatch(bare, /Context:/);
});

test("char: Slack fetch failure surfaces a friendly error, never the raw axios error", async () => {
  axios.get = async () => { throw new Error("403 forbidden"); };
  axios.post = async () => { throw new Error("must not reach the model"); };
  try {
    await assert.rejects(
      () => vision.analyzeImage("https://files.slack.com/files-pri/T1-F1/blob.png", "what is this?", "", "xoxb-test"),
      /couldn't grab that image from Slack/,
    );
  } finally {
    axios.get = realGet;
    axios.post = realPost;
  }
});

test("char: public URLs skip the Slack fetch entirely", async () => {
  let fetched = false;
  axios.get = async () => { fetched = true; throw new Error("must not fetch"); };
  axios.post = async () => ({ data: { choices: [{ message: { content: "a cat diagram  " } }] } });
  try {
    const reply = await vision.analyzeImage("https://example.com/cat.png", "what is this?");
    assert.equal(reply, "a cat diagram");
    assert.equal(fetched, false);
  } finally {
    axios.get = realGet;
    axios.post = realPost;
  }
});

test("char: empty model replies resolve to null, not empty strings", async () => {
  axios.post = async () => ({ data: { choices: [{ message: { content: "   " } }] } });
  try {
    assert.equal(await vision.analyzeImage("https://example.com/x.png", "q?"), null);
  } finally {
    axios.post = realPost;
  }
});

test("char: Slack files inline as data URIs with the bot token", async () => {
  let sawAuth: any = null;
  let sawBody: any = null;
  axios.get = async (url: any, opts: any) => {
    sawAuth = opts?.headers?.Authorization;
    return { data: Buffer.from("bytes"), headers: { "content-type": "image/png" } };
  };
  axios.post = async (url: any, body: any) => {
    sawBody = body;
    return { data: { choices: [{ message: { content: "ok" } }] } };
  };
  try {
    await vision.analyzeImage("https://files.slack.com/files-pri/T1-F1/x.png", "q?", "", "xoxb-tok");
    assert.equal(sawAuth, "Bearer xoxb-tok");
    const imgUrl = sawBody.messages[1].content[1].image_url.url;
    assert.match(imgUrl, /^data:image\/png;base64,/);
  } finally {
    axios.get = realGet;
    axios.post = realPost;
  }
});
export {};
