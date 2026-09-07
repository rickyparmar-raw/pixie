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
