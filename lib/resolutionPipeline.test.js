process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const llm = require("./llm");
const tickets = require("./tickets");
const pipeline = require("./resolutionPipeline");
const api = require("./web/api");

let realComplete;
let realOnResolved;

before(() => {
  db.close();
  db.open(":memory:");
  realComplete = llm.complete;
  realOnResolved = pipeline.onResolved;
});

after(() => {
  llm.complete = realComplete;
  pipeline.onResolved = realOnResolved;
});

function createResolvedTicket(suffix) {
  const id = db.createTicket({
    programId: "resolution-pipeline",
    channel: "C-resolution",
    threadTs: `resolution-thread-${suffix}`,
    requesterId: "U-requester",
    question: "How do I submit my project?",
  });
  db.resolveTicket(id, "Use the submission form and click Submit.", "U-helper");
  return db.getTicket(id);
}

test("summary success uses the full Slack thread and persists the result", async () => {
  const ticket = createResolvedTicket("success");
  let request = null;
  // The learning step also calls the model; capture only the summary request.
  llm.complete = async (options, label) => {
    if (label === "resolution-summary") request = options;
    return { text: "The requester needed submission help; the helper directed them to the form." };
  };
  const client = {
    conversations: {
      replies: async () => ({ messages: [
        { user: "U-requester", text: "I cannot find the form." },
        { user: "U-helper", text: "Use the submission form and click Submit." },
      ] }),
    },
  };

  await pipeline.onResolved({ ticket, client, actorId: "U-helper" });

  const stored = db.getTicket(ticket.id);
  assert.equal(stored.resolution_summary, "The requester needed submission help; the helper directed them to the form.");
  assert.ok(stored.resolution_summary_at > 0);
  assert.match(request.messages[1].content, /I cannot find the form/);
  assert.match(request.messages[1].content, /Use the submission form/);
  assert.match(request.messages[1].content, /How do I submit my project/);
});

test("LLM failure stores the deterministic question-resolution-timeline fallback", async () => {
  const ticket = createResolvedTicket("fallback");
  db.addTicketEvent({ ticketId: ticket.id, programId: ticket.program_id, actorId: "U-helper", eventType: "helper_reply", detail: "gave submission guidance" });
  llm.complete = async () => { throw new Error("provider unavailable"); };

  await pipeline.onResolved({ ticket, actorId: "U-helper" });

  const summary = db.getTicket(ticket.id).resolution_summary;
  assert.match(summary, /Question: How do I submit my project/);
  assert.match(summary, /Resolution: Use the submission form/);
  assert.match(summary, /Timeline:[\s\S]*helper_reply/);
});

test("summary generation is idempotent per ticket", async () => {
  const ticket = createResolvedTicket("idempotent");
  let calls = 0;
  llm.complete = async (_options, label) => {
    if (label === "resolution-summary") calls += 1;
    return { text: "One stable summary." };
  };

  await pipeline.onResolved({ ticket });
  await pipeline.onResolved({ ticket });

  assert.equal(calls, 1);
  assert.equal(db.getTicket(ticket.id).resolution_summary, "One stable summary.");
});

test("resolution succeeds when the pipeline throws", async () => {
  const ticketId = db.createTicket({
    programId: "resolution-safe",
    channel: "C-resolution",
    threadTs: "resolution-thread-safe",
    requesterId: "U-requester",
    question: "Why does this fail?",
  });
  // Run the real scheduled path (off by default under test) with a step that throws.
  const savedSteps = pipeline.steps.splice(0, pipeline.steps.length, { name: "boom", run: async () => { throw new Error("pipeline failed"); } });
  process.env.PIXIE_RESOLUTION_PIPELINE = "true";
  try {
    const result = tickets.resolveTicket({ ticketId, actorId: "U-helper", resolution: "Restart the process." });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result.ok, true);
    assert.equal(db.getTicket(ticketId).status, "resolved");
  } finally {
    process.env.PIXIE_RESOLUTION_PIPELINE = "false";
    pipeline.steps.splice(0, pipeline.steps.length, ...savedSteps);
  }
});

test("ticket detail exposes resolutionSummary", () => {
  const ticket = createResolvedTicket("api");
  db.setResolutionSummary(ticket.id, "The form submission issue was resolved.");

  const detail = api.ticketDetail(ticket.id);

  assert.equal(detail.resolutionSummary, "The form submission issue was resolved.");
  assert.equal(detail.ticket.resolutionSummary, "The form submission issue was resolved.");
});
