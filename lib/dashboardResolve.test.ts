process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as typeof import("./db");
interface UserInfo {
  displayName: string;
  realName?: string;
  username: string;
  slackId: string;
}
interface DashboardApi {
  setSlackClient(client: unknown): void;
  internalUserInfoBatch(ids: Array<string | null>): Promise<{ users: Record<string, UserInfo | null> }>;
  internalUserInfo(id: string): Promise<UserInfo | null>;
  internalTicketAction(id: number, action: string, options: { programId: string; actorId: string }): { ok?: boolean; error?: string };
}
const api = require("./web/api") as unknown as DashboardApi;

before(() => {
  db.close();
  db.open(":memory:");
});
after(() => {
  api.setSlackClient(null);
});

function program(id: string, helpers: string[] = []): void {
  db.saveProgram({ id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`] });
  for (const h of helpers) db.syncHelper({ programId: id, userId: h, source: "manual" });
}
function ticket(programId: string, status = "waiting_for_helper"): number {
  const id = db.createTicket({ programId, workspaceId: "WS" as unknown as null, channel: `C-${programId}`, threadTs: `t-${programId}-${Math.random()}`, requesterId: "U-req", question: "q" });
  db.handle().query("UPDATE tickets SET status = ? WHERE id = ?").run(status, id);
  return id;
}


test("internalUserInfoBatch dedupes, resolves the name variants, and never throws", async () => {
  api.setSlackClient({
    users: {
      info: async ({ user }: { user: string }) => {
        if (user === "U-DELETED") { throw new Error("user_not_found"); }
        return { user: { name: "handle", real_name: "Real Name", profile: { display_name: user === "U-NONICK" ? "" : "Nick", real_name: user === "U-NONICK" ? "" : "Real Name", image_192: "https://x/i.png" } } };
      },
    },
  });
  const res = await api.internalUserInfoBatch(["U-A", "U-A", "U-NONICK", "U-DELETED", "", null]);
  assert.deepEqual(Object.keys(res.users).sort(), ["U-A", "U-DELETED", "U-NONICK"]);
  assert.equal(res.users["U-A"]!.displayName, "Nick");
  assert.equal(res.users["U-A"]!.realName, "Real Name");
  assert.equal(res.users["U-A"]!.username, "handle");
  assert.equal(res.users["U-A"]!.slackId, "U-A");
  assert.equal(res.users["U-NONICK"]!.displayName, "handle");
  assert.equal(res.users["U-NONICK"]!.username, "handle");
  assert.equal(res.users["U-DELETED"], null); // deleted/unknown user resolves to null, not an error
});

test("internalUserInfoBatch degrades to all-null when Slack is not connected", async () => {
  api.setSlackClient(null);
  const res = await api.internalUserInfoBatch(["U-X", "U-Y"]);
  assert.deepEqual(res.users, { "U-X": null, "U-Y": null });
});

test("internalUserInfo caches a lookup so a page full of one user's rows costs one call", async () => {
  let calls = 0;
  api.setSlackClient({ users: { info: async ({ user }: { user: string }) => { calls += 1; return { user: { name: "u", profile: { display_name: "D" } } }; } } });
  await api.internalUserInfoBatch(["U-CACHE", "U-CACHE"]);
  await api.internalUserInfo("U-CACHE");
  assert.equal(calls, 1);
});


test("an authorized program helper resolves a ticket from the dashboard, recorded with source", async () => {
  program("dr-ok", ["U-helper"]);
  const id = ticket("dr-ok");
  const before = db.listAuditEvents({ programId: "dr-ok" } as unknown as null).length;
  const res = api.internalTicketAction(id, "resolve", { programId: "dr-ok", actorId: "U-helper" });
  assert.equal(res.ok, true);
  const t = db.getTicket(id);
  assert.equal(t.status, "resolved");
  assert.equal(t.resolved_by, "U-helper");
  assert.ok(t.resolved_at > 0);
  const events = db.listTicketEvents(id);
  const resolved = events.find((e: { event_type: string }) => e.event_type === "resolved");
  assert.ok(resolved);
  assert.equal(resolved.actor_id, "U-helper");
  assert.equal(JSON.parse(resolved.detail).source, "dashboard");
  assert.ok(db.listAuditEvents({ programId: "dr-ok" } as unknown as null).length > before);
});

test("a Slack-side resolve is identical in domain state, only the source metadata differs", () => {
  const tickets = require("./tickets");
  program("dr-slack", ["U-h"]);
  const id = ticket("dr-slack");
  const res = tickets.resolveTicket({ ticketId: id, actorId: "U-h" }); // no source → Slack
  assert.equal(res.ok, true);
  const resolved = db.listTicketEvents(id).find((e: { event_type: string }) => e.event_type === "resolved");
  assert.equal(resolved.detail, null); // Slack path carries no source
  assert.equal(db.getTicket(id).status, "resolved");
});

test("a user who is not a helper of the program cannot resolve its ticket", () => {
  program("dr-auth", ["U-member"]);
  const id = ticket("dr-auth");
  const res = api.internalTicketAction(id, "resolve", { programId: "dr-auth", actorId: "U-stranger" });
  assert.match(res.error, /not a helper/);
  assert.equal(db.getTicket(id).status, "waiting_for_helper");
});

test("a helper of another program cannot resolve across the boundary", () => {
  program("dr-a", ["U-a"]);
  program("dr-b", ["U-b"]);
  const id = ticket("dr-b");
  const wrongProgram = api.internalTicketAction(id, "resolve", { programId: "dr-a", actorId: "U-a" });
  assert.match(wrongProgram.error, /program mismatch/);
  const foreignActor = api.internalTicketAction(id, "resolve", { programId: "dr-b", actorId: "U-a" });
  assert.match(foreignActor.error, /not a helper/);
});

test("an inactive helper cannot resolve", () => {
  program("dr-inactive", ["U-active", "U-gone"]);
  db.removeHelper({ programId: "dr-inactive", userId: "U-gone" });
  const id = ticket("dr-inactive");
  const res = api.internalTicketAction(id, "resolve", { programId: "dr-inactive", actorId: "U-gone" });
  assert.match(res.error, /not a helper/);
});

test("resolving an already-resolved ticket follows the existing idempotency rule", () => {
  program("dr-idem", ["U-h"]);
  const id = ticket("dr-idem");
  assert.equal(api.internalTicketAction(id, "resolve", { programId: "dr-idem", actorId: "U-h" }).ok, true);
  const second = api.internalTicketAction(id, "resolve", { programId: "dr-idem", actorId: "U-h" });
  assert.ok(second.error); // db.resolveTicket's guard rejects a second transition
  assert.equal(db.listTicketEvents(id).filter((e: { event_type: string }) => e.event_type === "resolved").length, 1);
});

test("resolving a nonexistent ticket is rejected", () => {
  program("dr-missing", ["U-h"]);
  const res = api.internalTicketAction(999999, "resolve", { programId: "dr-missing", actorId: "U-h" });
  assert.match(res.error, /ticket not found/);
});

test("reopen from the dashboard also carries the dashboard source", () => {
  program("dr-reopen", ["U-h"]);
  const id = ticket("dr-reopen");
  api.internalTicketAction(id, "resolve", { programId: "dr-reopen", actorId: "U-h" });
  const res = api.internalTicketAction(id, "reopen", { programId: "dr-reopen", actorId: "U-h" });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "reopened");
  const reopened = db.listTicketEvents(id).find((e: { event_type: string }) => e.event_type === "reopened");
  assert.equal(JSON.parse(reopened.detail).source, "dashboard");
});
export {};
