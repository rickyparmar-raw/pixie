process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "test-internal-token";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const api = require("./web/api");
const programs = require("./programs");
const tickets = require("./tickets");

before(() => {
  db.close();
  db.open(":memory:");
});

function authed() {
  return { headers: { get: (k) => (k === "authorization" ? "Bearer test-internal-token" : "") } };
}

function anon() {
  return { headers: { get: () => "" } };
}

test("internal API is disabled without a token and rejects bad bearers", () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  delete process.env.PIXIE_INTERNAL_TOKEN;
  assert.equal(api.internalAuth(anon()).status, 404);
  process.env.PIXIE_INTERNAL_TOKEN = saved;
  assert.equal(api.internalAuth(anon()).status, 401);
  assert.equal(api.internalAuth(authed()).ok, true);
});

test("program sync claims channels atomically and bootstraps the creator", () => {
  programs.invalidate();
  const res = api.internalProgramSync("hwy", {
    name: "Highway",
    workspaceId: "TW",
    claimedBy: "U-org",
    programChannels: [{ id: "C-hwy-help", kind: "help" }],
  });
  assert.equal(res.error, undefined);
  assert.equal(res.program.deploymentMode, "hosted_shared");
  assert.equal(db.isHelper("hwy", "U-org"), true);

  const conflict = api.internalProgramSync("pixl", {
    name: "Pixl",
    workspaceId: "TW",
    claimedBy: "U-other",
    programChannels: [{ id: "C-hwy-help", kind: "help" }],
  });
  assert.match(conflict.error, /already owned by program hwy/);
});

test("ticket search is tenant-scoped and paginated", () => {
  db.createTicket({ programId: "hwy", workspaceId: "TW", channel: "C1", threadTs: "t-h1", requesterId: "U1", question: "deadline?" });
  db.createTicket({ programId: "pixl", workspaceId: "TW", channel: "C2", threadTs: "t-p1", requesterId: "U2", question: "deadline?" });
  const res = api.internalTicketSearch({ programId: "hwy" });
  assert.equal(res.total, 1);
  assert.equal(res.rows[0].program_id, "hwy");
});

test("ticket actions enforce actor membership and tenant match", () => {
  const id = db.createTicket({ programId: "hwy", workspaceId: "TW", channel: "C1", threadTs: "t-h2", requesterId: "U1", question: "help" });
  const outsider = api.internalTicketAction(id, "claim", { programId: "hwy", actorId: "U-stranger" });
  assert.match(outsider.error, /not a helper/);
  const crossTenant = api.internalTicketAction(id, "claim", { programId: "pixl", actorId: "U-org" });
  assert.match(crossTenant.error, /mismatch/);
  const ok = api.internalTicketAction(id, "claim", { programId: "hwy", actorId: "U-org" });
  assert.equal(ok.ok, true);
  assert.equal(ok.ticket.ticket.status, "claimed");
  // Claim race: second claim loses.
  db.syncHelper({ programId: "hwy", userId: "U-org2", source: "manual" });
  const race = api.internalTicketAction(id, "claim", { programId: "hwy", actorId: "U-org2" });
  assert.match(race.error, /not open/);
});

test("dashboard reply posts as program identity and lands in the timeline", async () => {
  const posted = [];
  const client = { chat: { postMessage: async (p) => { posted.push(p); return { ts: "2.0" }; } } };
  const id = db.createTicket({ programId: "hwy", workspaceId: "TW", channel: "C1", threadTs: "t-h3", requesterId: "U1", question: "help" });
  const res = await tickets.replyToTicket({ ticketId: id, authorId: "U-org", text: "try rebooting", client });
  assert.equal(res.ok, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].thread_ts, "t-h3");
  const events = db.listTicketEvents(id);
  assert.ok(events.some((e) => e.event_type === "helper_reply"));
});

test("internal notes never touch Slack and require membership", () => {
  const id = db.createTicket({ programId: "hwy", workspaceId: "TW", channel: "C1", threadTs: "t-h4", requesterId: "U1", question: "help" });
  const denied = api.internalTicketNote(id, { programId: "hwy", actorId: "U-stranger", body: "secret" });
  assert.match(denied.error, /not a helper/);
  const note = api.internalTicketNote(id, { programId: "hwy", actorId: "U-org", body: "customer is on v2" });
  assert.equal(note.ok, true);
  const notes = db.listTicketNotes(id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, "customer is on v2");
});

test("helper reconciliation removes stale membership instead of going stale", () => {
  db.syncHelper({ programId: "hwy", userId: "U-gone", source: "organizer_channel" });
  const res = api.internalHelpersSync("hwy", { actorId: "U-org", source: "organizer_channel", members: ["U-org"], reconcile: true });
  assert.equal(res.ok, true);
  assert.equal(db.isHelper("hwy", "U-gone"), false);
  assert.equal(db.isHelper("hwy", "U-org"), true);
});
