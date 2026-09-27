// Preloaded before every test file (see bunfig.toml).
//
// The whole suite shares one process, and lib/db.js opens lazily on first use —
// so whichever file touches the database first decides where the entire run
// writes. That was fine while only the files that set PIXIE_DB_PATH themselves
// ever reached db.js. It stopped being fine the moment prompt building started
// consulting the program registry, which reads the database: a test file that
// had never heard of db.js could now open the real pixie.db, and every later
// file inherited the handle no matter what it set.
//
// Pinning it here means no test can write to the real database, whatever the
// require graph does next.
process.env.PIXIE_DB_PATH = ":memory:";

// The Jev decision gate must never fire live gateway calls from unit tests —
// a local .env with JEV_ENABLED=true would otherwise turn every respond()
// test into a network-dependent, rate-limit-burning integration test. Pinned
// off here; files that exercise the gate (lib/jevGate.test.js) opt back in
// explicitly in their own before() hooks with a stubbed evaluator.
process.env.JEV_ENABLED = "false";

// Resolving a ticket schedules summary + learning work that calls the model.
// Pinned off so any test that resolves a ticket stays offline and isolated;
// lib/resolutionPipeline.test.js and lib/resolutionFlow.test.js drive
// onResolved() directly.
process.env.PIXIE_RESOLUTION_PIPELINE = "false";

export = {};
