import { test, expect } from "bun:test";
import { identityLabel, resolveIdentities, labelFor } from "./identity";

// These run against the real module. The wizard test env has no
// PIXIE_CORE_BASE_URL, so coreConfigured() is false and resolveIdentities
// takes its degradation path — which is exactly the safety property that
// matters: an identity lookup that cannot run must still return usable
// id-only labels and never throw.

test("identityLabel walks display name -> real name -> username -> @id", () => {
  expect(identityLabel({ displayName: "Nick", realName: "Real", username: "handle" }, "U1")).toBe("Nick");
  expect(identityLabel({ displayName: null, realName: "Real Name", username: "handle" }, "U1")).toBe("Real Name");
  expect(identityLabel({ displayName: "  ", realName: null, username: "handle" }, "U1")).toBe("handle");
  expect(identityLabel({ displayName: null, realName: null, username: null }, "U1")).toBe("@U1");
  expect(identityLabel(null, "U1")).toBe("@U1");
  expect(identityLabel(undefined, "U1")).toBe("@U1");
});

test("identityLabel never renders blank and never invents a name", () => {
  expect(identityLabel({ displayName: "", realName: "", username: "" }, "U0ABC")).toBe("@U0ABC");
  expect(identityLabel(null, null)).toBe("—");
  expect(identityLabel(null, undefined)).toBe("—");
});

test("resolveIdentities returns an entry for every real id, deduped, and never throws", async () => {
  const map = await resolveIdentities(["U_A", "U_A", "U_B", "", null, undefined]);
  expect([...map.keys()].sort()).toEqual(["U_A", "U_B"]);
  expect(map.get("U_A")).toEqual({
    slackId: "U_A",
    displayName: null,
    realName: null,
    username: null,
    avatarUrl: null,
    label: "@U_A",
  });
});

test("resolveIdentities degrades to id-only labels when Core cannot be reached — a page still renders", async () => {
  const map = await resolveIdentities(["U1", "U2"]);
  expect(map.get("U1")?.label).toBe("@U1");
  expect(map.get("U2")?.label).toBe("@U2");
});

test("resolveIdentities on an empty id list does no work", async () => {
  expect((await resolveIdentities([])).size).toBe(0);
  expect((await resolveIdentities([null, undefined, ""])).size).toBe(0);
});

test("labelFor reads a resolved map and falls back for anything not in it", () => {
  const map = new Map([
    ["U_KNOWN", { slackId: "U_KNOWN", displayName: "Known", realName: null, username: null, avatarUrl: null, label: "Known" }],
  ]);
  expect(labelFor(map, "U_KNOWN")).toBe("Known");
  expect(labelFor(map, "U_MISSING")).toBe("@U_MISSING");
  expect(labelFor(map, null)).toBe("—");
});
