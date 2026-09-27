// @ts-nocheck
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const learn = require("./learn");
const { config } = require("./config");
const { reviewBlocks, reviewAction, coverageBlocks, homeBlocks } = require("./home");

db.open(":memory:");

const ADMIN = "U-admin";
const OUTSIDER = "U-nobody";
config.slack.adminUserIds = [ADMIN];


function seedPending(question, answer) {
  return db.addLearnedFact({ question, answer, authorId: "U2", status: learn.PENDING });
}

test("reviewBlocks renders a button pair per candidate for admins", () => {
  seedPending("how do i export a sprite", "export as PNG at native size, no upscaling");

  const blocks = reviewBlocks(ADMIN);
  const actions = blocks.filter((b) => b.type === "actions");
  assert.ok(actions.length >= 1);
  assert.deepEqual(
    actions[0].elements.map((e) => e.text.text),
    ["Approve", "Drop"],
  );
});

test("reviewBlocks shows nothing to a non-admin", () => {
  assert.deepEqual(reviewBlocks(OUTSIDER), []);
});

test("reviewBlocks attributes an author-less row to drafting, not a broken mention", () => {
  db.addLearnedFact({ question: "how do i unlock the next region", answer: "ship your current region's project", status: learn.PENDING });

  const blocks = reviewBlocks(ADMIN);
  const section = blocks.find((b) => b.text?.text?.includes("unlock the next region"));
  assert.match(section.text.text, /drafted from repeated help-channel questions/);
  assert.doesNotMatch(section.text.text, /<@null>/);
});

test("approve action promotes the fact and republishes the view", async () => {
  const id = seedPending("what port does it run on", "port 4900, override with PORT");

  let publishedFor = null;
  const client = {
    views: {
      publish: async ({ user_id }) => {
        publishedFor = user_id;
      },
    },
  };

  let acked = false;
  await reviewAction(learn.approve, "approved")({
    ack: async () => {
      acked = true;
    },
    body: { user: { id: ADMIN } },
    action: { value: String(id) },
    client,
  });

  assert.equal(acked, true);
  assert.equal(publishedFor, ADMIN);
  assert.match(learn.corpusSection(), /port 4900/);
});

test("drop action deletes the candidate", async () => {
  const id = seedPending("does pixie read links", "yes, it fetches public URLs");

  await reviewAction(learn.forget, "dropped")({
    ack: async () => {},
    body: { user: { id: ADMIN } },
    action: { value: String(id) },
    client: { views: { publish: async () => {} } },
  });

  assert.equal(
    learn.pending(200).some((r) => r.id === id),
    false,
  );
});

test("review action ignores a click from a non-admin", async () => {
  const id = seedPending("secret question", "this must not get approved");

  await reviewAction(learn.approve, "approved")({
    ack: async () => {},
    body: { user: { id: OUTSIDER } },
    action: { value: String(id) },
    client: { views: { publish: async () => {} } },
  });

  assert.doesNotMatch(learn.corpusSection(), /this must not get approved/);
});


function withCounts(counts, fn) {
  const original = db.metricCounts;
  db.metricCounts = () => Object.entries(counts).map(([kind, count]) => ({ kind, count }));
  try {
    return fn();
  } finally {
    db.metricCounts = original;
  }
}

test("coverageBlocks reports the docs share and calls out a low one", () => {
  const [, section] = withCounts({ answer_docs: 3, answer_chat: 7 }, coverageBlocks);

  assert.match(section.text.text, /docs coverage — 30%/);
  assert.match(section.text.text, /3 of 10/);
  assert.match(section.text.text, /general knowledge/);
});

test("coverageBlocks reads healthy when the docs carry most questions", () => {
  const [, section] = withCounts({ answer_docs: 8, answer_chat: 2 }, coverageBlocks);

  assert.match(section.text.text, /docs coverage — 80%/);
  assert.match(section.text.text, /carrying most questions/);
});

test("coverageBlocks renders nothing before any question is answered", () => {
  assert.deepEqual(withCounts({}, coverageBlocks), []);
});

test("homeBlocks renders for a viewer with no history", () => {
  const blocks = homeBlocks(OUTSIDER);
  assert.equal(blocks[0].type, "header");
  assert.ok(blocks.length < 100, "Slack rejects a view over 100 blocks");
  assert.match(JSON.stringify(blocks), /what i can walk you through/);
});


test("char: homeBlocks header names the bot and stays within the block budget", () => {
  const blocks = homeBlocks(OUTSIDER);
  assert.equal(blocks[0].text.text, require("./brand").name());
  assert.ok(blocks.length < 100);
});

test("char: reviewBlocks empty-queue copy renders for admins, nothing for outsiders", () => {
  const db = require("./db");
  const learn = require("./learn");
  db.handle().query("DELETE FROM learned_facts").run();
  const adminBlocks = reviewBlocks(ADMIN);
  assert.ok(adminBlocks.some((b) => b.text?.text?.includes("nothing queued")));
  assert.deepEqual(reviewBlocks(OUTSIDER), []);
});
export {};
