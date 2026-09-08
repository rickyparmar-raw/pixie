process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const api = require("./api");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  api.setSlackClient(null);
});

test("internalUserInfo returns display name and avatar, never the raw profile", async () => {
  api.setSlackClient({
    users: {
      info: async ({ user }) => {
        assert.equal(user, "U_TARGET");
        return {
          user: {
            id: "U_TARGET",
            name: "jdoe",
            profile: {
              display_name: "J. Doe",
              real_name: "Jane Doe",
              email: "jane@example.com",
              image_192: "https://avatars.example.com/jane.png",
            },
          },
        };
      },
    },
  });

  const res = await api.internalUserInfo("U_TARGET");
  assert.equal(res.ok, true);
  assert.equal(res.displayName, "J. Doe");
  assert.equal(res.avatarUrl, "https://avatars.example.com/jane.png");
  // The response object must never carry the email or echo the raw id/name.
  assert.equal("email" in res, false);
  assert.equal("id" in res, false);
  assert.equal(JSON.stringify(res).includes("jane@example.com"), false);
});

test("internalUserInfo falls back to real_name then bare name when no display_name is set", async () => {
  api.setSlackClient({ users: { info: async () => ({ user: { name: "bareuser", profile: {} } }) } });
  const res = await api.internalUserInfo("U_BARE");
  assert.equal(res.ok, true);
  assert.equal(res.displayName, "bareuser");
  assert.equal(res.avatarUrl, null);
});

test("internalUserInfo fails soft (ok:false) instead of throwing when Slack errors", async () => {
  api.setSlackClient({
    users: {
      info: async () => {
        throw new Error("user_not_found");
      },
    },
  });
  const res = await api.internalUserInfo("U_GONE");
  assert.equal(res.ok, false);
  assert.equal(typeof res.reason, "string");
});

test("internalUserInfo requires a user id", async () => {
  const res = await api.internalUserInfo(null);
  assert.equal(res.ok, false);
});

test("internalUserInfo caches a resolved identity — a second call doesn't hit Slack again", async () => {
  let calls = 0;
  api.setSlackClient({
    users: {
      info: async () => {
        calls += 1;
        return { user: { name: "cacheduser", profile: { display_name: "Cached User" } } };
      },
    },
  });
  const first = await api.internalUserInfo("U_CACHE_TEST");
  const second = await api.internalUserInfo("U_CACHE_TEST");
  assert.equal(first.displayName, "Cached User");
  assert.equal(second.displayName, "Cached User");
  assert.equal(calls, 1, "the second call should be served from cache, not a fresh Slack request");
});

/* ------------------------------------------------------------------ */
/* STEP 1 characterization pins (INTERNAL API domain): auth matrix,    */
/* tenant re-check, validation, serialization, retention confirm gate. */
/* These pin CURRENT behavior — the rewrite must keep them green.      */
/* ------------------------------------------------------------------ */

function charReq(token) {
  return { headers: { get: (k) => (k === "authorization" ? `Bearer ${token}` : "") } };
}
function charAnon() {
  return { headers: { get: () => "" } };
}

test("char: internalAuth matrix — absent token→404, bad bearer→401, good→ok", () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  try {
    delete process.env.PIXIE_INTERNAL_TOKEN;
    const disabled = api.internalAuth(charAnon());
    assert.equal(disabled.status, 404);
    assert.match(disabled.body.error, /disabled/);

    process.env.PIXIE_INTERNAL_TOKEN = "char-secret-token";
    assert.equal(api.internalAuth(charAnon()).status, 401);
    assert.equal(api.internalAuth(charReq("wrong")).status, 401);
    assert.equal(api.internalAuth(charReq("char-secret-token")).ok, true);
    // Missing Bearer prefix is not accepted.
    assert.equal(api.internalAuth({ headers: { get: () => "char-secret-token" } }).status, 401);
    // Length mismatch fails without timing leak into ok.
    assert.equal(api.internalAuth(charReq("short")).status, 401);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = saved;
  }
});

test("char: ticket mutating paths re-check program + workspace tenant on every call", () => {
  const sync = api.internalProgramSync("char-tenant", {
    name: "Tenant", workspaceId: "TW-CHAR", claimedBy: "U-char-org", programChannels: [],
  });
  assert.equal(sync.ok, true);
  const id = db.createTicket({ programId: "char-tenant", workspaceId: "TW-CHAR", channel: "C1", threadTs: "char-t1", requesterId: "U1", question: "help" });
  // Program mismatch denied on action / reply / note alike.
  assert.match(api.internalTicketAction(id, "claim", { programId: "other-prog", actorId: "U-char-org" }).error, /mismatch/);
  assert.match(api.internalTicketNote(id, { programId: "other-prog", actorId: "U-char-org", body: "x" }).error, /mismatch/);
  // Workspace mismatch denied when the ticket carries a workspace.
  assert.match(api.internalTicketAction(id, "claim", { programId: "char-tenant", workspaceId: "OTHER-WS", actorId: "U-char-org" }).error, /mismatch/);
  // Stranger (non-helper) denied even with the right tenant.
  assert.match(api.internalTicketAction(id, "claim", { programId: "char-tenant", actorId: "U-stranger-x" }).error, /not a helper/);
  assert.match(api.internalTicketNote(id, { programId: "char-tenant", actorId: "U-stranger-x", body: "x" }).error, /not a helper/);
});

test("char: copilot/knowledge/macro/routing/incident/radar mutations all require helper membership", async () => {
  api.internalProgramSync("char-gates", { name: "Gates", workspaceId: "TW-G", claimedBy: "U-gates-org", programChannels: [] });
  const stranger = "U-gates-stranger";
  // Copilot (actor-gated reads with spend).
  const cop = await api.internalCopilot("ask", { programId: "char-gates", actorId: stranger, question: "hi" });
  assert.match(cop.error, /not a helper/);
  // Knowledge propose.
  const tid = db.createTicket({ programId: "char-gates", workspaceId: "TW-G", channel: "C1", threadTs: "char-g1", requesterId: "U1", question: "q" });
  const kp = await api.internalKnowledgePropose("char-gates", { actorId: stranger, ticketId: tid });
  assert.match(kp.error, /not a helper/);
  // Macro create / routing expertise / incident detect / radar evaluate.
  assert.match(api.internalMacroCreate("char-gates", { actorId: stranger, trigger: "?x", name: "x", content: "y" }).error, /not a helper/);
  assert.match(api.internalRoutingExpertise("char-gates", { actorId: stranger, userId: "U1" }).error, /not a helper/);
  assert.match(api.internalIncidentDetect("char-gates", { actorId: stranger }).error, /not a helper/);
  assert.match(api.internalRadarEvaluate("char-gates", { actorId: stranger }).error, /not a helper/);
  // Retention policy (helper-gated write).
  assert.match(api.internalRetentionPolicy("char-gates", { actorId: stranger, policy: {} }).error, /not a helper/);
  // Unknown program stays a plain validation error (not an actor error).
  assert.match((await api.internalCopilot("ask", { programId: "nope-missing", actorId: "U-gates-org", question: "hi" })).error, /unknown program/);
});

test("char: request validation at the boundary — slugs, names, kinds, ids", () => {
  assert.match(api.internalProgramSync("Bad_Slug!", { name: "x" }).error, /invalid program id/);
  assert.match(api.internalProgramSync("ab", { name: "x" }).error, /invalid program id/);
  assert.match(api.internalProgramSync("char-ok", { name: "x".repeat(81) }).error, /max 80/);
  assert.match(api.internalProgramSync("char-ok", { name: "x", programChannels: [{ id: "C1", kind: "evil" }] }).error, /invalid channel kind/);
  assert.match(api.internalTicketSearch({}).error, /programId required/);
  api.internalProgramSync("char-valid", { name: "V", workspaceId: "TW-V", claimedBy: "U-valid-org", programChannels: [] });
  const id = db.createTicket({ programId: "char-valid", workspaceId: "TW-V", channel: "C1", threadTs: "char-v1", requesterId: "U1", question: "q" });
  assert.match(api.internalTicketAction(id, "frobnicate", { programId: "char-valid", actorId: "U-valid-org" }).error, /unknown action/);
  assert.match(api.internalTicketAction(id, "assign", { programId: "char-valid", actorId: "U-valid-org" }).error, /assigneeId required/);
  assert.match(api.internalMacroCreate("char-valid", { actorId: "U-valid-org", trigger: "nope", name: "n", content: "c" }).error, /trigger/);
});

test("char: serialization shapes carry no secrets — programs/health/detail/retention", () => {
  const progs = api.programsList();
  assert.ok(Array.isArray(progs));
  const blob = JSON.stringify(progs);
  assert.equal(/token/i.test(blob) && /PIXIE_INTERNAL_TOKEN/.test(blob), false);
  assert.equal(blob.includes("PIXIE_SESSION_SECRET"), false);
  const health = api.healthCheck();
  assert.ok(health.models && health.channels);
  const hblob = JSON.stringify(health);
  assert.equal(hblob.includes("xoxb-"), false);
  assert.equal(/"token"\s*:/i.test(hblob), false);
  assert.equal(/"secret"\s*:/i.test(hblob), false);
  // Ticket detail shape is ticket + events + notes (no WHAT-echo of internal token).
  api.internalProgramSync("char-shape", { name: "Shape", workspaceId: "TW-S", claimedBy: "U-shape-org", programChannels: [] });
  const tid = db.createTicket({ programId: "char-shape", workspaceId: "TW-S", channel: "C1", threadTs: "char-s1", requesterId: "U1", question: "q" });
  const detail = api.ticketDetail(tid);
  assert.ok(detail.ticket && Array.isArray(detail.events) && Array.isArray(detail.notes));
  assert.equal("token" in detail, false);
  // Retention preview shape is counts + policy, never row contents.
  const prev = api.internalRetentionPreview("char-shape");
  assert.ok(typeof prev.tickets === "number" && typeof prev.ticketEvents === "number");
  assert.ok(prev.policy && typeof prev.policy.ticketsDays === "number");
  assert.equal(JSON.stringify(prev).includes("xoxb-"), false);
});

test("char: retention sweep is organizer/owner + confirm gated (plain helpers denied)", () => {
  api.internalProgramSync("char-ret", { name: "Ret", workspaceId: "TW-R", claimedBy: "U-ret-org", programChannels: [] });
  db.syncHelper({ programId: "char-ret", userId: "U-ret-helper", source: "manual" });
  // Missing confirm fails even for the organizer.
  assert.match(api.internalRetentionSweep("char-ret", { actorId: "U-ret-org" }).error, /confirm required/);
  // Plain helper with confirm still denied.
  assert.match(api.internalRetentionSweep("char-ret", { actorId: "U-ret-helper", confirm: true }).error, /organizer/);
  // Stranger denied.
  assert.match(api.internalRetentionSweep("char-ret", { actorId: "U-nobody", confirm: true }).error, /organizer/);
  // Organizer + confirm passes (dry-run delete on empty set still returns deleted:true shape).
  const ok = api.internalRetentionSweep("char-ret", { actorId: "U-ret-org", confirm: true });
  assert.equal(ok.deleted, true);
});

test("regression: internalHelpersSync fails closed on unknown programs (no orphan membership)", () => {
  // Evidence: every other program-scoped internal write starts with an
  // unknown-program tenant check; helpersSync was the lone exception, so a
  // PUT for a typo'd/deleted program with an admin actor returned ok:true
  // and left orphan helper rows behind. The fix adds the same needProgram
  // gate; the actor check and reconcile behavior for real programs are
  // unchanged (see hosted.test.js helper reconciliation test).
  const res = api.internalHelpersSync("nope-missing-prog", { actorId: "U-any", members: ["U-any"] });
  assert.match(res.error, /unknown program/);
});
