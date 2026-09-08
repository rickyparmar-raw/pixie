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

/* ------------------------------------------------------------------ */
/* STEP 1 characterization pins (SUPPORT macros): scoping + expansion  */
/* + transition effects. Append-only.                                  */
/* ------------------------------------------------------------------ */

test("char: macros are per-program — triggers/names/lists never leak", () => {
  db.saveProgram({ id: "char-mc-a", name: "A", helpChannel: "C-A", channels: ["C-A"] });
  db.saveProgram({ id: "char-mc-b", name: "B", helpChannel: "C-B", channels: ["C-B"] });
  programs.invalidate();
  const a = macros.create({ programId: "char-mc-a", trigger: "?char-scope", name: "Scope", content: "a {program}" });
  const b = macros.create({ programId: "char-mc-b", trigger: "?char-scope", name: "Scope", content: "b {program}" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const la = macros.list("char-mc-a").map((m) => m.trigger);
  const lb = macros.list("char-mc-b").map((m) => m.trigger);
  assert.ok(la.includes("?char-scope"));
  assert.ok(lb.includes("?char-scope"));
  assert.equal(macros.list("char-mc-a").find((m) => m.trigger === "?char-scope").content, "a {program}");
  assert.equal(macros.list("char-mc-b").find((m) => m.trigger === "?char-scope").content, "b {program}");
  // Enabled-only filter and search stay inside the program.
  macros.create({ programId: "char-mc-a", trigger: "?char-off", name: "Off", content: "off", enabled: false });
  assert.ok(!macros.list("char-mc-a", { enabledOnly: true }).some((m) => m.trigger === "?char-off"));
  assert.ok(macros.list("char-mc-a", { q: "scope" }).some((m) => m.trigger === "?char-scope"));
  assert.equal(macros.list("char-mc-b", { q: "scope" }).length, 1);
});

test("char: interpolate expands only SAFE_KEYS — unknown/missing stay literal", () => {
  assert.equal(macros.normalizeTrigger("?SHIPPING"), "?shipping");
  assert.equal(macros.normalizeTrigger("nosigil"), null);
  assert.equal(macros.normalizeTrigger("?"), null);
  const vals = macros.valuesFor({ ticket: { id: 42, requester_id: "U1", status: "open" }, program: { name: "Highway" }, actorId: "U9" });
  assert.deepEqual(vals, { requester: "<@U1>", ticket_id: "42", program: "Highway", status: "open", helper: "<@U9>" });
  assert.equal(macros.interpolate("Hi {requester} {ticket_id} {program} {status} {helper}", vals), "Hi <@U1> 42 Highway open <@U9>");
  assert.equal(macros.interpolate("keep {evil} and {requester}", vals), "keep {evil} and <@U1>");
  // Empty-string values interpolate to empty (known keys); null/undefined and
  // unknown keys stay literal instead of printing null/undefined.
  assert.equal(macros.interpolate("t {ticket_id} p {program}", macros.valuesFor({})), "t  p ");
  assert.equal(macros.interpolate("x {ticket_id} y {evil}", { ticket_id: null }), "x {ticket_id} y {evil}");
  assert.equal(macros.interpolate(null, vals), "");
});

test("char: macro send gates + transitions go through canonical db states", async () => {
  db.saveProgram({ id: "char-mc-t", name: "T", helpChannel: "C-T", channels: ["C-T"] });
  db.saveProgram({ id: "char-mc-u", name: "U", helpChannel: "C-U", channels: ["C-U"] });
  programs.invalidate();
  db.syncHelper({ programId: "char-mc-t", userId: "U-char-helper", source: "manual" });
  const noop = [];
  const client = { chat: { postMessage: async (p) => { noop.push(p); return { ts: "1.0" }; } } };

  const dis = macros.create({ programId: "char-mc-t", trigger: "?char-dis", name: "Dis", content: "x {ticket_id}", enabled: false });
  const tDis = db.createTicket({ programId: "char-mc-t", workspaceId: "T1", channel: "C-T", threadTs: "char-mc-dis", requesterId: "U1", question: "q" });
  assert.match((await macros.send({ id: dis.macro.id, ticketId: tDis, actorId: "U-char-helper", client })).error, /disabled/);
  assert.equal(noop.length, 0);

  // Cross-program ticket/macro pair is rejected before any post.
  const foreign = macros.create({ programId: "char-mc-t", trigger: "?char-foreign", name: "F", content: "hi" });
  const otherTicket = db.createTicket({ programId: "char-mc-u", workspaceId: "T1", channel: "C-U", threadTs: "char-mc-other", requesterId: "U1", question: "q" });
  assert.match((await macros.send({ id: foreign.macro.id, ticketId: otherTicket, actorId: "U-char-helper", client })).error, /program mismatch/);
  assert.equal(noop.length, 0);

  // Each on-send transition lands the canonical db status.
  for (const [trigger, want] of [["?char-res", "resolved"], ["?char-clo", "closed"], ["?char-sno", "snoozed"]]) {
    const created = macros.create({ programId: "char-mc-t", trigger, name: want, content: "done {ticket_id}", onSendTransition: want === "snoozed" ? "snoozed" : want });
    assert.equal(created.ok, true);
    const tid = db.createTicket({ programId: "char-mc-t", workspaceId: "T1", channel: "C-T", threadTs: `char-mc-${want}`, requesterId: "U1", question: "q" });
    const sent = await macros.send({ id: created.macro.id, ticketId: tid, actorId: "U-char-helper", client });
    assert.equal(sent.ok, true);
    assert.equal(db.getTicket(tid).status, want);
  }
  // No transition leaves the ticket open.
  const plain = macros.create({ programId: "char-mc-t", trigger: "?char-plain", name: "Plain", content: "hi {ticket_id}" });
  const tPlain = db.createTicket({ programId: "char-mc-t", workspaceId: "T1", channel: "C-T", threadTs: "char-mc-plain", requesterId: "U1", question: "q" });
  assert.equal((await macros.send({ id: plain.macro.id, ticketId: tPlain, actorId: "U-char-helper", client })).ok, true);
  assert.equal(db.getTicket(tPlain).status, "open");

  // Invalid transition rejected at create; role gate enforced at send.
  assert.match(macros.create({ programId: "char-mc-t", trigger: "?char-bad", name: "Bad", content: "x", onSendTransition: "escalated" }).error, /transition/);
  const roleGated = macros.create({ programId: "char-mc-t", trigger: "?char-admin", name: "Adm", content: "x", allowedRoles: ["admin"] });
  const tRole = db.createTicket({ programId: "char-mc-t", workspaceId: "T1", channel: "C-T", threadTs: "char-mc-role", requesterId: "U1", question: "q" });
  assert.match((await macros.send({ id: roleGated.macro.id, ticketId: tRole, actorId: "U-char-helper", client })).error, /requires role/);
});
