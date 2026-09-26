import { describe, expect, test } from "bun:test";
import {
  DEMO_DRAFT,
  EMPTY_DRAFT,
  draftProblems,
  dryRun,
  helperTagRows,
  knowledgeScore,
  markdownOutline,
  parseStoredDraft,
  routeTag,
  sourceFormRows,
  sourceUrlIssue,
  type DraftSource,
  type OnboardingDraft,
} from "./onboardingDraft";

const ready: OnboardingDraft = {
  ...EMPTY_DRAFT,
  programName: "Blueprint",
  helpChannelId: "C0123456789",
  organizerChannelId: "G0123456789",
  sources: [{ id: "a", kind: "notion", label: "Handbook", url: "https://x.notion.site/a", status: "pending", outline: [] }],
};

describe("sourceUrlIssue", () => {
  test("rejects a link on the wrong host for its kind", () => {
    expect(sourceUrlIssue("notion", "https://github.com/org/repo")).toContain("notion");
  });
  test("rejects private hosts", () => {
    expect(sourceUrlIssue("github", "http://localhost:3000/docs")).toContain("private");
  });
  test("accepts a matching public link", () => {
    expect(sourceUrlIssue("gdoc", "https://docs.google.com/document/d/abc")).toBeNull();
  });
  test("asks for a link when empty", () => {
    expect(sourceUrlIssue("github", "  ")).toBe("Paste a link first.");
  });
});

describe("markdownOutline", () => {
  test("returns the first three distinct headings", () => {
    expect(markdownOutline("# Intro\ntext\n## Setup *fast*\n# Intro\n### FAQ\n## Extra")).toEqual(["Intro", "Setup fast", "FAQ"]);
  });
  test("returns nothing for plain text", () => {
    expect(markdownOutline("just words")).toEqual([]);
  });
});

describe("knowledgeScore and form rows", () => {
  const sources: DraftSource[] = [
    { id: "1", kind: "markdown", label: "a.md", content: "# A", status: "pending", outline: ["A"] },
    { id: "2", kind: "github", label: "Repo", url: "https://github.com/o/r", status: "pending", outline: [] },
    { id: "3", kind: "notion", label: "Bad", url: "nope", status: "error", error: "bad", outline: [] },
    { id: "4", kind: "markdown", label: "reading", status: "processing", outline: [] },
  ];
  test("counts only usable sources", () => {
    expect(knowledgeScore(sources).count).toBe(2);
  });
  test("emits rows in the shape parseSources reads", () => {
    expect(sourceFormRows(sources)).toEqual([
      { type: "text", label: "a.md", url: "", content: "# A" },
      { type: "github-dir", label: "Repo", url: "https://github.com/o/r", content: "" },
    ]);
  });
});

describe("draftProblems", () => {
  test("an empty draft blocks launch on every required step", () => {
    const steps = new Set(draftProblems(EMPTY_DRAFT).map((p) => p.step));
    expect([...steps].sort()).toEqual([0, 1, 2]);
  });
  test("a complete draft has no problems", () => {
    expect(draftProblems(ready)).toEqual([]);
  });
  test("the same channel twice is rejected", () => {
    const messages = draftProblems({ ...ready, organizerChannelId: ready.helpChannelId }).map((p) => p.message);
    expect(messages).toContain("The help and helpers channels must be different.");
  });
  test("a failed source blocks launch", () => {
    const draft = { ...ready, sources: [...ready.sources, { id: "e", kind: "gdoc" as const, label: "x", status: "error" as const, outline: [] }] };
    expect(draftProblems(draft).some((p) => p.step === 2)).toBe(true);
  });
});

describe("parseStoredDraft", () => {
  test("round-trips a saved draft", () => {
    const parsed = parseStoredDraft(JSON.stringify({ ...ready, helpers: [{ slackId: "U0123456789", tags: ["Hardware"] }] }));
    expect(parsed?.programName).toBe("Blueprint");
    expect(parsed?.helpers).toEqual([{ slackId: "U0123456789", tags: ["Hardware"] }]);
  });
  test("drops malformed entries instead of trusting storage", () => {
    const parsed = parseStoredDraft(JSON.stringify({
      version: 1,
      step: 99,
      sources: [{ kind: "evil", label: "x" }, { kind: "notion", label: "ok", url: "https://a.notion.site", status: "ready" }],
      helpers: [{ slackId: "nope", tags: [] }, { slackId: "U0123456789", tags: ["Hardware", "<script>"] }],
    }));
    expect(parsed?.step).toBe(0);
    expect(parsed?.sources.map((s) => [s.label, s.status])).toEqual([["ok", "pending"]]);
    expect(parsed?.helpers).toEqual([{ slackId: "U0123456789", tags: ["Hardware"] }]);
  });
  test("returns null for garbage or old versions", () => {
    expect(parseStoredDraft("{")).toBeNull();
    expect(parseStoredDraft(JSON.stringify({ version: 0 }))).toBeNull();
    expect(parseStoredDraft(null)).toBeNull();
  });
});

describe("dry run", () => {
  test("routes a hardware grant question to the tagged helper", () => {
    expect(routeTag("Where's my hardware grant?")).not.toBeNull();
    const result = dryRun("Where's my hardware grant?", { ...ready, helpers: [{ slackId: "U0000000001", tags: ["Software"] }, { slackId: "U0000000002", tags: ["Grants"] }] });
    expect(result).toEqual({ kind: "handoff", tag: "Grants", helperId: "U0000000002", linkSourcesPending: 1 });
  });
  test("answers from uploaded text when it matches", () => {
    const draft = { ...ready, sources: [{ id: "m", kind: "markdown" as const, label: "faq.md", content: "# Shipping\n\nPackages ship within two weeks of approval and tracking arrives by email.", status: "pending" as const, outline: [] }] };
    const result = dryRun("When will my package ship and where is tracking?", draft);
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") expect(result.sourceLabel).toBe("faq.md");
  });
  test("helper tag rows only include tagged helpers", () => {
    expect(helperTagRows([{ slackId: "U1", tags: [] }, { slackId: "U2", tags: ["Grants", "Hardware"] }])).toEqual(["U2:Grants,Hardware"]);
  });
  test("demo fixtures are a complete draft", () => {
    expect(draftProblems(DEMO_DRAFT)).toEqual([]);
  });
});
