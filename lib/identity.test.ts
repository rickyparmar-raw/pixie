type TestAny = any;
const { test } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("./identity");


test("identity covers the questions that actually missed in production", () => {
  const section = identity.corpusSection();
  for (const probe of [/Who are you/i, /Who made you/i, /How are you/i, /What can you do/i]) {
    assert.match(section, probe);
  }
});

test("identity is in the Q/A shape the answer prompt expects", () => {
  const lines = identity.corpusSection().split("\n").filter(Boolean);
  assert.ok(lines.some((l: TestAny) => l.startsWith("Q: ")));
  assert.ok(lines.some((l: TestAny) => l.startsWith("A: ")));
});

test("identity credits Ricky and points at the help channel", () => {
  const section = identity.corpusSection();
  assert.match(section, /Ricky/);
  assert.match(section, /#pixl-help/);
});


test("identity distinguishes pixie from pixorpheus", () => {
  assert.match(identity.corpusSection(), /Pixorpheus/i);
});

test("identity promises to admit an empty memory rather than invent one", () => {
  assert.match(identity.corpusSection(), /make something up|invent/i);
});

test("PIXIE_IDENTITY_OVERRIDE replaces the default, unset falls back to it", () => {
  const saved = process.env.PIXIE_IDENTITY_OVERRIDE;
  delete process.env.PIXIE_IDENTITY_OVERRIDE;
  try {    assert.equal(identity.corpusSection(), identity.IDENTITY);

    process.env.PIXIE_IDENTITY_OVERRIDE = "Q: Who are you?\nA: I'm a trial bot.";
    assert.equal(identity.corpusSection(), "Q: Who are you?\nA: I'm a trial bot.");
    assert.doesNotMatch(identity.corpusSection(), /Ricky/);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_IDENTITY_OVERRIDE;
    else process.env.PIXIE_IDENTITY_OVERRIDE = saved;
  }
});


test("a program's identity names its channel and what questions belong there", () => {
  const text = identity.corpusSection({ id: "pixl", name: "Pixl", helpChannel: "C-help" });
  assert.match(text, /What channel is this\?/);
  assert.match(text, /<#C-help>/);
  assert.match(text, /I read everything asked here as a Pixl question/);
});

test("an unscoped program's identity acknowledges the other programs as separate", () => {
  const text = identity.corpusSection({ id: "pixl", name: "Pixl", helpChannel: "C-help" });
  assert.match(text, /What programs do you cover\?/);
  assert.match(text, /never answer one program's question with another program's numbers/);
});


test("a program-scoped identity names no other program and offers no redirect", () => {
  const text = identity.corpusSection({ id: "back-to-basics", name: "Back to Basics", helpChannel: "C-b2b", scope: "program" });
  assert.match(text, /Here I only do Back to Basics/);
  assert.doesNotMatch(text, /Pixl/);
  assert.doesNotMatch(text, /point you at that program's channel/i);
});

test("a program-scoped identity introduces itself by its support name", () => {
  const text = identity.corpusSection({ id: "back-to-basics", name: "Back to Basics", supportName: "B2B Support", helpChannel: "C-b2b", scope: "program" });
  assert.match(text, /I'm B2B Support,/);
});


test("PIXIE_IDENTITY_OVERRIDE still replaces the whole section", () => {
  const saved = process.env.PIXIE_IDENTITY_OVERRIDE;
  process.env.PIXIE_IDENTITY_OVERRIDE = "Q: who?\nA: a trial bot.";
  try {
    const text = identity.corpusSection({ id: "pixl", name: "Pixl", helpChannel: "C-help" });
    assert.equal(text, "Q: who?\nA: a trial bot.");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_IDENTITY_OVERRIDE;
    else process.env.PIXIE_IDENTITY_OVERRIDE = saved;
  }
});

test("the identity corpus contains no dashes for the model to copy", () => {
  const texts = [identity.IDENTITY, identity.corpusSection({ id: "pixl", name: "Pixl", helpChannel: "C1" })];
  for (const text of texts) assert.doesNotMatch(text, /[—–]|\s--\s/);
});


function withBrand(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a rebranded bot introduces itself by its own name and commands", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const text = identity.corpusSection({ id: "solvable", name: "Solvable", helpChannel: "C-help" });
    assert.match(text, /I'm Sol,/);
    assert.match(text, /\/sol <question>/);
    assert.match(text, /\/sol-sources/);
    assert.doesNotMatch(text, /\/pixie/);
  });
});


test("a rebranded bot doesn't claim pixie's authorship as its own", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const text = identity.corpusSection({ id: "solvable", name: "Solvable", helpChannel: "C-help" });
    assert.match(text, /built on pixie/);
    assert.doesNotMatch(text, /Ricky built me/);
  });
});


test("a rebranded bot drops the Pixorpheus pair entirely", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.doesNotMatch(identity.corpusSection({ id: "solvable", name: "Solvable" }), /Pixorpheus/i);
    assert.doesNotMatch(identity.defaultIdentity(), /Pixorpheus/i);
  });
});

test("a rebranded fallback identity doesn't send people to #pixl-help", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.doesNotMatch(identity.defaultIdentity(), /#pixl-help/);
  });
});


test("with no brand variables the identity is byte-identical to pixie's", () => {
  withBrand({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    const text = identity.defaultIdentity();
    assert.match(text, /I'm pixie,/);
    assert.match(text, /Ricky built me/);
    assert.match(text, /Pixorpheus/);
    assert.match(text, /\/pixie <question>/);
    assert.match(text, /#pixl-help/);
  });
});

test("the rebranded corpus is still dash-free", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const texts = [identity.defaultIdentity(), identity.corpusSection({ id: "solvable", name: "Solvable" })];
    for (const text of texts) assert.doesNotMatch(text, /[—–]|\s--\s/);
  });
});


test("char: fallback identity with no program is pixie and dash-free", () => {
  withBrand({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    const text = identity.corpusSection(null);
    assert.match(text, /I'm pixie,/);
    assert.doesNotMatch(text, /[—–]|\s--\s/);
  });
});

test("char: program identity degrades gracefully without a help channel", () => {
  withBrand({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    const text = identity.corpusSection({ id: "x", name: "Xeno" });
    assert.match(text, /the help channel/);
    assert.doesNotMatch(text, /<#/);
  });
});

test("char: rebranded identity leaks neither pixie commands nor pixl channel", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const text = identity.corpusSection({ id: "solvable", name: "Solvable", helpChannel: "C1" });
    assert.doesNotMatch(text, /\/pixie/);
    assert.doesNotMatch(text, /#pixl-help/);
    assert.doesNotMatch(text, /Ricky built me/);
  });
});


test("regression: fallback identity interpolates the bot name, never ships ${botName}", () => {
  withBrand({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    assert.doesNotMatch(identity.defaultIdentity(), /\$\{botName\}/);
    assert.match(identity.defaultIdentity(), /Who created pixie\?/);
  });
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.doesNotMatch(identity.defaultIdentity(), /\$\{botName\}/);
    assert.match(identity.defaultIdentity(), /Who created Sol\?/);
  });
});
export {};
