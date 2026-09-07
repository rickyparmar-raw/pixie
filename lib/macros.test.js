process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const macros = require("./macros");
const api = require("./web/api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

test("macros validate triggers and interpolate only safe values", () => {
  db.saveProgram({ id: "mc-hwy", name: "Highway", helpChannel: "C-HWY", channels: ["C-HWY"] });
  programs.invalidate();

  assert.match(macros.create({ programId: "mc-hwy", trigger: "nosigil", name: "x", content: "y" }).error, /trigger/);
  assert.match(macros.create({ programId: "mc-hwy", trigger: "?ship", name: "x", content: "" }).error, /content/);

  const created = macros.create({
    programId: "mc-hwy", trigger: "?shipping", name: "Shipping", content: "Hi {requester}, ticket {ticket_id} ({program}) is {status}. From {helper}. {evil} stays.",
  });
  assert.equal(created.ok, true);
  const dup = macros.create({ programId: "mc-hwy", trigger: "?SHIPPING", name: "dup", content: "z" });
  assert.match(dup.error, /already exists/);

  const ticket = { id: 7, requester_id: "U1", status: "open" };
  const text = macros.interpolate(created.macro.content, macros.valuesFor({ ticket, program: { name: "Highway" }, actorId: "U9" }));
  assert.match(text, /<@U1>/);
  assert.match(text, /ticket 7/);
  assert.match(text, /\(Highway\)/);
  assert.match(text, /From <@U9>/);
  assert.match(text, /\{evil\} stays/);
});

test("macro send is permission-gated, program-scoped, and audited", async () => {
  db.syncHelper({ programId: "mc-hwy", userId: "U-helper", source: "manual" });
  const t = db.createTicket({ programId: "mc-hwy", workspaceId: "T1", channel: "C-HWY", threadTs: "mc-t1", requesterId: "U1", question: "where is my pcb" });
  const created = macros.create({ programId: "mc-hwy", trigger: "?where", name: "Where", content: "checking {ticket_id}", onSendTransition: "resolved" });
  const posted = [];
  const client = { chat: { postMessage: async (p) => { posted.push(p); return { ts: "9.0" }; } } };

  const denied = await macros.send({ id: created.macro.id, ticketId: t, actorId: "U-stranger", client });
  assert.match(denied.error, /not a helper/);
  assert.equal(posted.length, 0);

  const sent = await macros.send({ id: created.macro.id, ticketId: t, actorId: "U-helper", client });
  assert.equal(sent.ok, true);
  assert.match(posted[0].text, /checking 7|checking/);
  assert.equal(db.getTicket(t).status, "resolved");
  const events = db.listTicketEvents(t);
  assert.ok(events.some((e) => e.event_type === "macro_sent"));
});

test("macro API gates cross-program access", () => {
  const listed = api.internalMacrosList("mc-hwy", {});
  assert.ok(Array.isArray(listed));
  assert.match(api.internalMacroCreate("mc-hwy", { actorId: "U-stranger", trigger: "?x", name: "x", content: "y" }).error, /not a helper/);
  const made = api.internalMacroCreate("mc-hwy", { actorId: "U-helper", trigger: "?eta", name: "Eta", content: "ships in {program}" });
  assert.equal(made.ok, true);
  const suggestions = api.internalMacroSuggest("mc-hwy", { q: "when does shipping arrive" });
  assert.ok(suggestions.some((s) => s.trigger === "?shipping"));
  assert.equal(api.internalMacroSuggest("mc-hwy", { q: "quantum chromodynamics" }).length, 0);
});
