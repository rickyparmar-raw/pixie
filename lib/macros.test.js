process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const macros = require("./macros");
const waitTime = require("./waitTime");
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

test("dashboard-shaped transitions survive macro create and update", async () => {
  const programId = "macro-api-transitions";
  const helperId = "U-macro-api-helper";
  db.saveProgram({ id: programId, name: "API transitions", helpChannel: "C-MAT", channels: ["C-MAT"] });
  programs.invalidate();
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  const client = { chat: { postMessage: async () => ({ ts: "2.0" }) } };
  api.setSlackClient(client);

  for (const [index, transition] of ["resolved", "closed", "snoozed"].entries()) {
    const created = api.internalMacroCreate(programId, {
      actorId: helperId,
      trigger: `?api-transition-${index}`,
      name: `${transition} transition`,
      content: `transition {ticket_id}`,
      on_send_transition: transition,
    });
    assert.equal(created.ok, true);
    assert.equal(created.macro.on_send_transition, transition);
    const ticketId = db.createTicket({ programId, workspaceId: "T1", channel: "C-MAT", threadTs: `macro-api-${transition}`, requesterId: "U-requester", question: "q" });
    const sent = await api.internalMacroSend(created.macro.id, { actorId: helperId, ticketId });
    assert.equal(sent.ok, true);
    assert.equal(db.getTicket(ticketId).status, transition);
  }

  const updateTarget = api.internalMacroCreate(programId, {
    actorId: helperId, trigger: "?api-update", name: "Update", content: "update",
  });
  const updated = api.internalMacroUpdate(updateTarget.macro.id, { actorId: helperId, on_send_transition: "resolved" });
  assert.equal(updated.ok, true);
  assert.equal(updated.macro.on_send_transition, "resolved");
  api.setSlackClient(null);
});

test("macro context expands bounded live queue tokens and admits missing history", async () => {
  const programId = "macro-live-context";
  const helperId = "U-macro-context-helper";
  db.saveProgram({ id: programId, name: "Live context", helpChannel: "C-MLC", channels: ["C-MLC"] });
  programs.invalidate();
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  for (let i = 0; i < 3; i += 1) {
    const historyId = db.createTicket({ programId, workspaceId: "T1", channel: "C-MLC", threadTs: `macro-history-${i}`, requesterId: "U1", question: "history", category: "reviews" });
    const createdAt = Date.now() - (100000 + i * 1000);
    db.handle().query("UPDATE tickets SET created_at = ?, first_human_response_at = ?, status = 'resolved' WHERE id = ?").run(createdAt, createdAt + 120000, historyId);
  }
  const aheadOne = db.createTicket({ programId, workspaceId: "T1", channel: "C-MLC", threadTs: "macro-ahead-1", requesterId: "U1", question: "q", category: "reviews" });
  const aheadTwo = db.createTicket({ programId, workspaceId: "T1", channel: "C-MLC", threadTs: "macro-ahead-2", requesterId: "U1", question: "q", category: "reviews" });
  const otherCategory = db.createTicket({ programId, workspaceId: "T1", channel: "C-MLC", threadTs: "macro-other", requesterId: "U1", question: "q", category: "shipping" });
  const target = db.createTicket({ programId, workspaceId: "T1", channel: "C-MLC", threadTs: "macro-target", requesterId: "U1", question: "q", category: "reviews" });
  const now = Date.now();
  db.handle().query("UPDATE tickets SET status = 'waiting_for_helper', created_at = ? WHERE id = ?").run(now - 3000, aheadOne);
  db.handle().query("UPDATE tickets SET status = 'waiting_for_helper', created_at = ? WHERE id = ?").run(now - 2000, aheadTwo);
  db.handle().query("UPDATE tickets SET status = 'waiting_for_helper', created_at = ? WHERE id = ?").run(now - 1000, otherCategory);
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(now, target);
  const created = macros.create({ programId, trigger: "?live-context", name: "Live context", content: "{queue_depth}|{typical_wait}|{position}|{unknown}" });
  const posted = [];
  const client = { chat: { postMessage: async (payload) => { posted.push(payload); return { ts: "3.0" }; } } };
  const sent = await macros.send({ id: created.macro.id, ticketId: target, actorId: helperId, client });
  assert.equal(sent.ok, true);
  assert.match(posted[0].text, /^3\|usually around 2 minutes\|3\|\{unknown\}$/);
  assert.equal(waitTime.queueDepth(programId, "reviews"), 3);
  assert.deepEqual(macros.waitingTicketIds({ programId, category: "reviews" }), [aheadTwo, aheadOne]);

  const emptyProgram = "macro-live-context-empty";
  db.saveProgram({ id: emptyProgram, name: "Empty context", helpChannel: "C-MLE", channels: ["C-MLE"] });
  programs.invalidate();
  db.syncHelper({ programId: emptyProgram, userId: helperId, source: "manual" });
  const emptyMacro = macros.create({ programId: emptyProgram, trigger: "?empty-context", name: "Empty", content: "{typical_wait}" });
  const emptyTicket = db.createTicket({ programId: emptyProgram, workspaceId: "T1", channel: "C-MLE", threadTs: "macro-empty", requesterId: "U1", question: "q" });
  const emptyPosted = [];
  await macros.send({ id: emptyMacro.macro.id, ticketId: emptyTicket, actorId: helperId, client: { chat: { postMessage: async (payload) => { emptyPosted.push(payload); return { ts: "4.0" }; } } } });
  assert.equal(emptyPosted[0].text, "a little while");
});

test("bulk macro send is bounded, scoped, audited, and available over its internal route", async () => {
  const programId = "macro-bulk";
  const otherProgramId = "macro-bulk-other";
  const helperId = "U-macro-bulk-helper";
  db.saveProgram({ id: programId, name: "Bulk", helpChannel: "C-MB", channels: ["C-MB"] });
  db.saveProgram({ id: otherProgramId, name: "Other bulk", helpChannel: "C-MBO", channels: ["C-MBO"] });
  programs.invalidate();
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  const created = api.internalMacroCreate(programId, { actorId: helperId, trigger: "?bulk", name: "Bulk", content: "bulk {ticket_id}" });
  const waiting = [];
  for (let i = 0; i < 2; i += 1) waiting.push(db.createTicket({ programId, workspaceId: "T1", channel: "C-MB", threadTs: `macro-bulk-${i}`, requesterId: "U1", question: "q", category: "reviews" }));
  waiting.forEach((id) => db.markTicketWaitingForHelper(id));
  const resolved = db.createTicket({ programId, workspaceId: "T1", channel: "C-MB", threadTs: "macro-bulk-resolved", requesterId: "U1", question: "q" });
  db.resolveTicket(resolved, "done");
  const foreign = db.createTicket({ programId: otherProgramId, workspaceId: "T1", channel: "C-MBO", threadTs: "macro-bulk-foreign", requesterId: "U1", question: "q" });
  db.markTicketWaitingForHelper(foreign);
  const posted = [];
  api.setSlackClient({ chat: { postMessage: async (payload) => { posted.push(payload); return { ts: "5.0" }; } } });
  const tooMany = await macros.sendBulk({ macroId: created.macro.id, ticketIds: Array.from({ length: 51 }, (_, i) => i + 1), actorId: helperId, client: null, delayMs: 0 });
  assert.match(tooMany.error, /at most 50/);
  const routeToken = "macro-bulk-token";
  const previousToken = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = routeToken;
  try {
    const serve = require("./web/serve");
    const response = await serve.handleRequest(new Request(`http://localhost/internal/v1/macros/${created.macro.id}/bulk`, {
      method: "POST",
      headers: { Authorization: `Bearer ${routeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: helperId, ticketIds: [...waiting, resolved, foreign] }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.sent, waiting);
    assert.deepEqual(body.skipped.map((item) => item.reason), ["ticket is not open", "program mismatch"]);
    const selectorResponse = await serve.handleRequest(new Request(`http://localhost/internal/v1/programs/${programId}/macros/waiting?actorId=${helperId}&category=reviews`, { headers: { Authorization: `Bearer ${routeToken}` } }));
    assert.equal(selectorResponse.status, 200);
    assert.deepEqual((await selectorResponse.json()).ticketIds.slice().sort(), waiting.slice().sort());
  } finally {
    if (previousToken === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = previousToken;
    api.setSlackClient(null);
  }
  assert.equal(posted.length, 2);
  assert.equal(db.listTicketEvents(waiting[0]).filter((event) => event.event_type === "macro_sent").length, 1);
  assert.equal(db.listTicketEvents(waiting[1]).filter((event) => event.event_type === "macro_sent").length, 1);
  assert.equal(db.listAuditEvents({ programId, limit: 50 }).filter((row) => row.action === "macro.sent").length, 2);
  const templates = api.internalMacroTemplates(programId, { actorId: helperId });
  assert.equal(templates.templates.length, 4);
  assert.equal(templates.placeholders.length, 3);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM program_macros WHERE program_id = ?").get(programId).n, 1);
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

test("char: a sent macro never enters learned_facts or the answer corpus", async () => {
  const knowledge = require("./knowledge");
  db.saveProgram({ id: "char-mc-iso", name: "Iso", helpChannel: "C-ISO", channels: ["C-ISO"] });
  programs.invalidate();
  db.syncHelper({ programId: "char-mc-iso", userId: "U-iso-helper", source: "manual" });
  const token = "zzmacroisolation9x";
  const created = macros.create({ programId: "char-mc-iso", trigger: "?char-iso", name: "Iso", content: `canned answer ${token} {ticket_id}` });
  assert.equal(created.ok, true);
  const tid = db.createTicket({ programId: "char-mc-iso", workspaceId: "T1", channel: "C-ISO", threadTs: "char-mc-iso-1", requesterId: "U1", question: "q" });
  const posted = [];
  const client = { chat: { postMessage: async (p) => { posted.push(p); return { ts: "1.0" }; } } };
  const sent = await macros.send({ id: created.macro.id, ticketId: tid, actorId: "U-iso-helper", client });
  assert.equal(sent.ok, true);
  assert.ok(posted.some((p) => (p.text || "").includes(token)), "the macro text did go out to Slack");

  // ...but it was learned nowhere: no learned_fact in any status may carry it,
  // and the answer corpus must not surface it.
  for (const status of ["candidate", "pending", "approved"]) {
    const rows = db.handle().query(
      "SELECT id FROM learned_facts WHERE status = ? AND (question LIKE ? OR answer LIKE ?)",
    ).all(status, `%${token}%`, `%${token}%`);
    assert.equal(rows.length, 0, `no ${status} learned fact may contain macro text`);
  }
  assert.ok(!String(knowledge.getContext(`what is ${token}`, "char-mc-iso")).includes(token));
  // It lives in exactly one place: the macro table.
  const owners = db.handle().query("SELECT id FROM program_macros WHERE content LIKE ?").all(`%${token}%`);
  assert.equal(owners.length, 1);
});
