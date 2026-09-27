const { test } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("./identity");

// These are the exact questions that filled the live gap log — pixie had no
// grounded answer for any of them, so they fell through to the ungrounded chat
// path where it could invent its own backstory.
test("identity covers the questions that actually missed in production", () => {
  const section = identity.corpusSection();
  for (const probe of [/Who are you/i, /Who made you/i, /How are you/i, /What can you do/i]) {
    assert.match(section, probe);
  }
});

test("identity is in the Q/A shape the answer prompt expects", () => {
  const lines = identity.corpusSection().split("\n").filter(Boolean);
  assert.ok(lines.some((l: any) => l.startsWith("Q: ")));
  assert.ok(lines.some((l: any) => l.startsWith("A: ")));
});

test("identity credits Ricky and points at the help channel", () => {
  const section = identity.corpusSection();
  assert.match(section, /Ricky/);
  assert.match(section, /#pixl-help/);
});

// Pixorpheus runs in the same channels; conflating the two confuses people
// about which bot handles tickets.
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

/* ---------------------------------------------------- program awareness -- */
// Pixie runs one deployment across every YSWS channel, so "what is this
// channel" and "do you cover other programs" are questions she should be able
// to answer about herself rather than guess at.

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

// A program scoped to its own questions is walled: its identity must not name
// another program or offer to send anyone to a different channel — that's the
// cross-program redirect this whole change exists to make impossible.
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

// The wizard writes this for single-program trial instances and it has to keep
// winning outright — a trial bot must not start describing a registry it isn't
// part of.
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

/* ------------------------------------------------------ fleet rebranding -- */
// One engine image serves every bot, so the identity has to name whichever bot
// this deployment is. Otherwise Solvable's bot introduces itself as pixie and
// tells people to run /pixie.

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

// "Ricky built me" is true of pixie. For another program's bot it's a fabricated
// fact about its own origin, which is exactly what the identity block exists to
// prevent.
test("a rebranded bot doesn't claim pixie's authorship as its own", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    const text = identity.corpusSection({ id: "solvable", name: "Solvable", helpChannel: "C-help" });
    assert.match(text, /built on pixie/);
    assert.doesNotMatch(text, /Ricky built me/);
  });
});

// Pixorpheus is a Pixl-specific sibling. Another program's bot has no such
// sibling, so it must not answer as though it knows one.
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

// The whole rebranding change has to be invisible to the live Pixl deployment,
// which sets neither variable.
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

/* ------------------------------------------------ STEP 1 char pins -- */
// Identity fallback + anti-leak: no-program and rebranded shapes stay
// dash-free, pixie-scoped facts never leak into another bot.

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

/* -------------------------------------------------- bugfix regression -- */
// defaultIdentity's "Who made you" line used a plain double-quoted string with
// a ${...} placeholder in it, so the corpus shipped the literal text
// "Who created ${botName}?" to the model. The program-scoped branch next to it
// already interpolated correctly — this pins the fallback to match.
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
