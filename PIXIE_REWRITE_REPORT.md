# Pixie Internal Rewrite

Status: baseline and characterization phase.

This branch is an isolated rewrite worktree. The original checkout and its
uncommitted changes remain untouched.

## Backup

Backup directory:

```text
/tmp/opencode/pixie-backup-20260913T010152Z
```

Artifacts:

- `repository.bundle`
- `worktree.tar.gz`
- `SHA256SUMS`
- `status.txt`
- `recent-log.txt`

## Worktree

```text
/tmp/opencode/pixie-rewrite
branch: pixie-internal-rewrite
base: 37964de
```

## Existing Architecture

### Pixie Core

- Bun/CommonJS Slack service rooted at `index.js`.
- Socket Mode Slack Bolt transport.
- SQLite runtime state through `lib/db.js` and `lib/schema.js`.
- Answer pipeline through `lib/handlers.js`, `lib/respond.js`, `lib/intent.js`,
  `lib/lookup.js`, `lib/answer.js`, and `lib/llm.js`.
- Retrieval/knowledge through `lib/knowledge.js`, `lib/retrieve.js`, and
  `lib/sourceGuard.js`.
- Tickets, helper routing, incidents, radar, retention, commands, guides, and
  learning are separate domain areas with shared DB/runtime seams.
- Core web and Wizard bridge are served by `lib/web/serve.js` and assembled by
  `lib/web/api.js`.

### Pixie Wizard

- Next.js App Router application under `pixie-wizard/`.
- Signed HMAC session cookie in `lib/session.ts`.
- Program authorization in `lib/programAccess.ts`.
- PostgreSQL control-plane access in `lib/db.ts` and `lib/hostedPrograms.ts`.
- Server-only Core bridge in `lib/pixieCore.ts`.
- Server Actions in `app/wizard/hostedActions.ts`.
- Existing dashboard shell and visual primitives in
  `app/_components/DashboardShell.tsx`.
- Program pages are individually membership-gated; the program layout is not
  the authorization boundary.

## Frozen Contracts

- Slack event routing, commands, reactions, action IDs, message wording,
  threading, silence, escalation, and helper routing.
- Core `/internal/v1/*` paths, methods, payloads, response shapes, status codes,
  auth, and error semantics.
- SQLite table/column semantics, migration order, timestamps, dedupe atomicity,
  retention, and restart behavior.
- PostgreSQL hosted-program IDs, workspace/channel ownership, helper roles,
  audit semantics, sync states, and entitlements.
- All Wizard routes, navigation, page copy, components, colors, spacing,
  typography, responsive behavior, theme behavior, loading/error/empty states,
  and visual geometry.

## Baseline Evidence

The repository baseline is not green before rewrite work.

### Core

- `bun test`: 1,273 passing, 10 failing, 7 errors in the isolated baseline.
- Existing failures include cache/model-state coupling and baseline test-runner
  errors. They must be classified, not silently changed.

### Wizard

- `bun test`: 23 passing, 7 failing, 7 errors in the isolated baseline.
- Existing failures include process-wide Bun module-loading/mock behavior.
- `npm run typecheck` and `npm run build` require installed dependencies and are
  separate gates.

### Visual

- No formal Wizard browser or screenshot regression suite exists.
- The landing prototype is untracked in the original checkout and is preserved
  in the backup rather than copied into this Git worktree.
- Visual parity cannot be claimed until a controlled baseline is restored and a
  browser screenshot harness exists.

## Characterization Matrix

Before replacing a subsystem, capture current behavior for:

- configuration normalization and provider key selection;
- program/workspace/channel routing and isolation;
- intent, eligibility, silence, grounding, and escalation;
- retrieval ranking, source freshness, cache, warming, and dynamic shop rules;
- model request/retry/fallback behavior;
- Slack placeholders, edits, final messages, blocks, reactions, and commands;
- ticket creation, idempotence, transitions, permissions, routing, and audit;
- helper expertise/ranking and assignment lifecycle;
- incidents, radar, SLA, analytics, retention, and reports;
- SQLite migration/restart/WAL/dedupe behavior;
- Wizard sessions, relationships, server actions, Core bridge, and page states;
- PostgreSQL program/channel/helper/audit/entitlement behavior;
- browser route redirects, forms, empty states, errors, and screenshots.

## Rewrite Order

1. Freeze baseline fixtures and classify existing failures.
2. Extract pure Core contracts behind adapters.
3. Normalize Slack transport to application events/effects.
4. Introduce typed program/runtime configuration projections.
5. Add persistence repositories over the existing SQLite implementation.
6. Separate knowledge ownership, retrieval, answer planning, model transport,
   and public rendering.
7. Formalize the existing Core internal API without changing its wire contract.
8. Rewrite Wizard control-plane services behind the current PostgreSQL schema.
9. Add browser/screenshot parity coverage without changing UI composition.
10. Remove old implementations only after dual-path parity verification.

## Required Gates

- Characterization tests pass against the current implementation.
- New implementation matches behavior/output/API/data fixtures.
- Existing SQLite and PostgreSQL data remain readable and writable.
- Program/workspace isolation is unchanged.
- Slack sends remain deterministic and at-most-once.
- Wizard screenshots and accessibility trees match controlled baselines.
- Core and Wizard typecheck/build pass.
- Full Core and Wizard tests pass, or every pre-existing failure is explicitly
  proven unrelated and preserved in the report.
- Code-quality, Gauntlet, conformity, and completion gates pass.

## Rewrite Checkpoints

### `f530d86` — typed Core parity contracts

Added additive, side-effect-free Core contracts for normalized Slack events,
answer dispositions, runtime configuration shape, ticket transitions, and
declarative Slack effects. Added 5 characterization tests with 23 assertions.

### `5a81cdc` — legacy Core contract adapters

Added adapters for current Bolt event shapes, eligibility/intent results, and
SQLite ticket rows. Added 3 adapter parity tests; the original runtime remains
the production oracle.

### `4909b44` — SQLite persistence boundary

Added a CommonJS persistence factory and legacy SQLite adapter. Added restart,
atomic dedupe, program/channel ownership, and tenant-boundary characterization
coverage. Existing schema and migration code remain authoritative.

### `d620834` — answer-cache migration

Migrated the cache module behind the persistence boundary without changing cache
keys, counters, freshness, stale handling, tenant scope, or restart behavior.
Focused cache/warm/tenancy tests pass: 35 tests.

### `0a245b5` — runtime configuration projection

Added an additive runtime-config projection over the existing `programs.js`
resolver. Existing precedence and workspace/channel routing remain authoritative.
Focused runtime/program/routing/workspace/tenancy tests pass: 55 tests.

### Current answer-planner stage — additive

Added a pure typed answer planner under `core/application/` with no Slack,
database, model, or environment imports. It emits declarative answer effects
and preserves explicit dispositions for silence, reply, escalation, and human
defer. Planner tests pass independently; the existing `lib/respond.js` path is
still the only production path.

### `9062b06` — answer differential bridge

Added legacy observation adaptation, normalized effect traces, capture/no-op
effect sinks, and pure differential comparison helpers. No Slack, model, or
database side effects are duplicated; `respond.js` remains the production
owner.

### `21587bf` — Wizard Core sync contract

Added typed validation for partial Wizard-to-Core program sync payloads behind
the existing `syncProgramToCore()` façade. Existing Core endpoint paths,
payload keys, status handling, routes, actions, and UI remain unchanged.
Focused Wizard validation/Core/reconciliation tests pass: 14 tests, 44
assertions. Wizard typecheck and production build pass.

### Current regression snapshot

- Core: 1,383 passing, 5 failing, 2 errors.
- Wizard: 96 passing, 2 failing, 2 errors.
- Wizard typecheck: passing.
- Wizard production build: passing.

The remaining Wizard errors are the pre-existing Bun module-loader conflict
around the current `coreUsage` export and process-wide module mocks. The new
`coreUsage.ts` façade is additive and does not change the existing bridge or
page imports. These failures remain a baseline/tooling issue until the test
loader is repaired without changing runtime contracts.

### `7734bd5` — ticket/repository seams and Core usage contract restoration

Added the typed-by-contract Core ticket repository and transition tests. Restored
the existing metadata-only Core usage exports/routes that the current usage
tests assert. The ticket repository remains an additive production candidate;
authorization, Slack card projection, and lifecycle side effects remain in the
legacy ticket service until differential coverage is complete.

### `972147c` — visual harness and Core contract restoration

Added a Playwright visual-harness skeleton covering the Wizard route matrix and
desktop/mobile light/dark projects. Added the `@playwright/test` dependency in
the isolated branch. Baseline snapshots, real PostgreSQL fixtures, and a
deterministic Core HTTP fixture are still required before the visual gate can
pass.

### `990f814` and `1c016df` — Wizard read authority switches

The program layout now loads its program row through the repository-backed
context loader. The repository directly owns parameterized program reads,
active-program listing, and the literal public-profile projection queries.
Existing relationship/redirect semantics and rendered UI remain unchanged.
Focused repository/access tests, typecheck, and build pass.

### `cc2b8fd` — checkpoint quality repairs

Replaced the remaining silent catches surfaced by the checkpoint quality scan
in the affected Core web/API files with observable debug/warn logging. No
external response or product behavior was intentionally changed.

## Current Production Authority Status

### Switched or partially switched

- Core cache callers use the persistence port; the default adapter remains the
  existing SQLite implementation until the storage replacement is proven.
- Wizard program-layout reads use the repository-backed program context loader.
- Wizard hosted-program repository directly owns program reads, active lists,
  and public-profile projection queries while preserving the existing SQL
  allowlist and row shapes.
- Core typed sync validation is active behind the existing Core bridge façade.

### Still legacy-authoritative

- Slack transport and event handlers.
- Full answer/responder orchestration and effect execution.
- Retrieval, knowledge, source freshness, grounding, deterministic tools, and
  model transport.
- Ticket Slack projections, authorization, helper routing, assignment lifecycle,
  and all ticket mutations outside the additive repository.
- Core SQLite implementation and schema lifecycle.
- Core web/API implementation beyond the restored usage contract.
- Wizard server actions, most repository reads/writes, authentication/RBAC
  façades, Core synchronization orchestration, and all UI page implementations.
- Wizard UI visual baselines have not yet been captured because the harness
  still needs deterministic real PostgreSQL and Core HTTP fixtures.

The rewrite is therefore **not complete**. The legacy implementation remains
production-authoritative in multiple required subsystems, as intentionally
recorded here instead of being hidden behind additive wrappers.

## Pixl support regression repair — 2026-09-14

- Root cause and first divergent stage: compact thread context correctly held
  the parent question, but `lookup.retrievalQuery()` selected the virtual
  current follow-up as the latest user turn and omitted the parent from the
  retrieval query. `how long?` therefore became `how long? Pixl` rather than
  retaining the parent duration/end-date referent.
- Exact fix: query construction now selects the newest distinct preceding user
  turn; support tracing accepts a bounded supplied thread fixture through the
  same compact-context selector used in production.
- Program-context fix: for a resolved program with exactly one timeline
  milestone, a timing question now uses that program identity rather than
  requiring an exact program-name spelling. This answers `when did pixel
  start?` from Pixl's configured timeline without a text replacement.
- Authorization/fallback audit: an authorized candidate from a fresh approved
  source reaches the final Slack renderer as its own text; the fallback is not
  emitted after that success. Unsupported, malformed, stale-dynamic, and
  cross-program evidence remain fail-closed under the existing grounding and
  authorization tests.
- Source truth: the configured Pixl corpus loader produced the approved
  `Program timeline` section containing the official Pixl release date,
  August 18, 2026. The random Slack reply was not ingested or used.
- Fallback semantics: the existing mention fallback remains for genuine
  ungrounded ALWAYS-mode requests. It is not used after an authorized reply;
  grounded-required paths still stay silent when authorization fails.
- Added regression coverage: parent/current compact context and retrieval
  query, thread-fixture trace parity, typo-independent single-program timeline
  resolution, and final Slack text after authorization.
- Focused verification: 222 tests across context, trace, retrieval, grounding,
  authorization, timeline, and responder suites passed.
- Full Core verification: `bun test core lib` completed with 1,533 passing and
  1 pre-existing unrelated failure (`isBlockedHost allows public domain names`);
  this repair's focused suites are green. No Wizard contract changed, so the
  Wizard suite was not rerun for this Core-only repair.

## Gate Snapshot

Focused current checkpoints:

- Core ticket/usage/API route selection: 31 passing.
- Wizard repository/access selection: 4 passing.
- Wizard Core sync/usage selection: 14 passing.
- Wizard typecheck: passing.
- Wizard production build: passing.

Full-suite baseline/tooling blockers remain:

- Core full suite has existing failures/errors around baseline usage/test-loader
  state and pre-existing behavior fixtures.
- Wizard full suite has the process-wide Bun module-loader conflict around the
  `coreUsage` named export tests.
- Visual baseline capture requires a disposable real PostgreSQL instance,
  deterministic seed data, a local Core HTTP fixture, and baseline/rewrite
  server orchestration.

No completion claim is valid until those blockers are resolved and each
remaining legacy-authoritative subsystem has passed characterization,
differential, integration, and (where applicable) visual parity gates.

### `38617b6` — ticket hardening, Wizard read expansion, visual fixtures

- Core ticket repository now covers notes, helpers, audit packing with differential parity vs db.js/audit.js (14 tests in ticket-repository.test.js). Production ticket mutations remain legacy-owned; no switch yet.
- Wizard repository directly owns owner/active/channels/helpers/pending-sync reads with parity tests; overview and programs pages read through the repository with identical props/markup.
- Visual harness now has deterministic seed.sql, dependency-free core-stub.mjs, and runbook README.md; snapshots still require disposable Postgres + stub + Wizard orchestration.
- Focused verification: Core ticket/persistence/cache 36 pass; Wizard repository/access/contracts 8 pass; typecheck pass; Playwright lists 72 tests; stub smoke passes.

### Current repair cycle — critic BLOCKER/HIGH resolution

- Ticket repository now matches legacy `markDuplicateTicket` (unconditional
  overwrite) and adds the missing `reopenResolved` guarded variant; `waiting`
  keeps the legacy `open/reopened/escalated` predicate. Added `cardTs`,
  `ackTs`, `triage`, `firstResponse`, `search`, and `ticketsForProgram` ports
  with tenant verification, clamped limits, and audit-failure logging; removed
  the dead `update()` helper.
- `addEvent` now rejects cross-tenant writes instead of inserting orphan rows;
  `getByThreadTs`/`list`/`create` mirror the legacy workspace fallback chain so
  program-only callers keep legacy visibility.
- Wizard `updateHostedProgram({})` is a no-op read; directory listing is capped
  at 200 rows; public profiles tolerate null/malformed sources; pending-sync
  queries include never-synced rows. None of these change legitimate behavior.
- Visual harness now has auth setup with storage state, an explicit per-project
  theme, a frozen clock, loud auth-redirect failure, and full-shape ticket
  details for every fixture. Snapshot capture still requires disposable
  Postgres + stub + Wizard orchestration.
- Focused verification: Core ticket 15 pass; Core ticket/persistence/cache/API
  63 pass; Wizard repository/access/contracts 8 pass; typecheck pass;
  Playwright lists 73 tests.

### Current repair cycle — critic BLOCKER/HIGH resolution

- Ticket repository now matches legacy `markDuplicateTicket` (unconditional
  overwrite) and adds the missing `reopenResolved` guarded variant plus
  `cardTs`, `ackTs`, `triage`, `firstResponse`, `search`, and
  `ticketsForProgram` ports. Transitions write both event and audit rows like
  legacy `recordTransition`; `addEvent` rejects cross-tenant writes;
  `get`/`getByThreadTs`/`list`/`create` mirror the legacy workspace fallback
  chain; limits are clamped; dead code removed.
- Pre-existing product quirks intentionally preserved and documented:
  unconditional `reopen`/`close`/`snooze`/`escalate`/`unclaim` transitions,
  reopened-claim mismatch between card UI and DB guard, and terminal states
  outside `CLOSED` keeping open affordances. Program-only `search` keeps the
  legacy dashboard contract.
- Wizard `updateHostedProgram({})` is a no-op read; directory listing capped at
  200; helper identity keys require an active program; pending-sync includes
  never-synced rows; public profiles tolerate malformed sources.
- Visual harness asserts seeded content on program routes, freezes the browser
  clock, pins themes per project, and returns full-shape ticket details for
  every fixture. Snapshot capture still requires disposable Postgres + stub +
  Wizard orchestration.
- Focused verification: Core ticket/persistence/cache/API 64 pass; Wizard
  repository/access/contracts 8 pass; typecheck pass; Playwright lists 73.

### Current repair cycle — critic BLOCKER/HIGH resolution (continued)

- Fixed the Bun/Playwright collision the harness introduced: visual specs are
  now `screenshots.visual.ts`/`auth.setup.ts` with an explicit Playwright
  `testMatch`, so `bun test` ignores them. Full suite improved from 3 fail /
  3 errors to 2 fail / 2 errors; the remainder is the single pre-existing Bun
  loader conflict around the `coreUsage` named export (both files pass in
  isolation, 6/6).
- Pre-existing quirks intentionally preserved and documented: unconditional
  legacy transitions, reopened-claim UI/DB mismatch, terminal states outside
  `CLOSED`, program-only search scope, and `listWizardPeople` full-directory
  semantics (now bounded at 200 rows as a DoS guard).

### Support-pipeline slice gates (this checkpoint)

- Quality, L1 contract, L2 boundaries, full `npm test`, and conformity pass
  for the slice (intent boundary, context builder, matrix, trace, store
  reunification).
- L3 residual findings triaged as pre-existing/out-of-slice: the floating
  async in `respond.js` is the long-standing placeholder/ticket-ready pattern
  (untouched by this slice — changing its timing would alter Slack behavior);
  `JSON.parse` sites in `db.js` row mapping predate the slice and parse
  internally-written JSON; thread transcripts are intentionally non-durable
  (privacy architecture — file reopen is proven for dedupe/cache in
  `persistence.test.js`, and the reunification is covered by round-trip tests).
- Next stages per plan: retrieval/knowledge/grounding/model-transport
  migration behind the trace harness, then ticket projections, helper
  routing, incidents/radar/SLA/retention, remaining Wizard
  repositories/actions, and visual snapshot capture.

### Support-pipeline parity and first authority switches

- Contextual-question parity matrix (`lib/contextualSupport.test.js`, 11
  tests): Hardwire tier questions, Pixl submission questions, hardware-then-
  software follow-ups, and negatives (unrelated channel, chatter, unsupported,
  cross-program fact) pinned at retrieval, corpus-scoping, and disposition
  levels with fixture inline sources and a protocol-correct scripted model.
- Differential trace (`lib/supportTrace.js`, 5 tests): program resolution,
  channel classification, eligibility, thread context, retrieval query/results,
  source freshness, intent, grounding, disposition, and effects recorded per
  stage through current production functions; rewrites must reproduce entries.
- `lib/supportIntent.js` owns the HELP_ONLY gate (respond.js delegates);
  forceVerdict plus an override registry give the future program-level
  proactive-intent toggle its plug-in point with zero behavior change today.
- `lib/supportContext.js` owns context prompts, recall gating, and referential
  resolution (respond.js delegates, exports preserved).
- Real regression fixed: the transient-context migration had split thread
  storage into two maps (`context.js` transientThreads vs `db.js`
  ephemeralThreadMessages) with no production writer left on the db side, so
  bare referential follow-ups, copilot transcripts, and resolution-memory
  extraction silently read empty history. Reunited on the single store at the
  pre-rewrite durable bound; TTL and `{role, content, user_id}` shapes kept.
- Focused verification: matrix/trace/intent/context/respond suites 161 pass,
  context/db/copilot suites 78 pass, broader pipeline suites 280 pass.

### Knowledge/freshness and model-boundary migration checkpoint

- Retrieval remains the existing production behavior, now composed from the
  previously-characterized tokenize, chunk, score, and select stages. Its
  differential suite pins ranking order, exact scores, source exclusion, and
  selection behavior; this checkpoint intentionally makes no retrieval or
  grounding policy change.
- `lib/sourcePolicy.js` now owns pure source-cache identity, dynamic-source,
  freshness, eligibility, and shop-source exclusion decisions. `knowledge.js`
  remains the I/O owner for source refresh and cache rows, delegating only the
  decision logic. Fresh/stale/unavailable behavior and exact-claim eligibility
  are pinned against the former behavior.
- `lib/modelTelemetry.js` now owns model usage normalization, provider/cost
  attribution, and usage recording. `llm.js` remains the model transport and
  retains its retry, fallback, streaming, and wire behavior. Differential
  transport tests cover 429, 5xx, timeout, empty-completion, 401, and streaming
  recovery paths.
- Prompt text is frozen by a named/unnamed, help/non-help, grounded/ungrounded
  parity matrix. Terminal intent/UNCLEAR interpretation lives in the pure
  `lib/disposition.js` boundary while responder I/O, ticket behavior, metrics,
  and streaming sequencing remain legacy-authoritative.
- Grounded answer authorization is isolated in `lib/answerAuthorization.js`.
  It delegates to the existing grounding validator and freshness view rather
  than introducing a second retrieval, evidence, or source-authority path.
- Store ownership is explicitly tested: one transient thread store seen through
  both context and db compatibility views; one program-isolated answer-cache
  read/write/invalidation path; one source-cache key scheme; one memoized corpus
  and retrieval index per program; and one telemetry writer. These checks are
  the anti-split-brain gate for this checkpoint.

### Verification snapshot — knowledge/model checkpoint

- Focused migration, parity, and ownership suites: 87 passing, 0 failing.
- Wizard suite: 1529 passing, 0 failing.
- Wizard typecheck and production build: passing.
- Root suite: 1529 passing, 1 environmental failure. The isolated failure is
  `lib/link.test.js`'s public-domain DNS assertion: this environment returns
  `EAI_AGAIN` resolving `github.com`, and the SSRF guard correctly fails closed.
  The migrated files do not touch `lib/link.js` or its test.
- Static migration gate: `git diff --check` passes. The offline Railway
  migration-diff verification passes. No deployment, merge, main checkout, or
  original worktree was modified.

### Test-isolation repair — full suites green

- Root cause of the remaining full-suite failures: Bun `mock.module` patches
  are process-wide and `mock.restore()` does not clear them for subsequently
  loaded test files (proven with a minimal two-file reproduction), so one
  file's `@/lib/pixieCore` mock leaked into `pixieCoreUsage`/`quota` tests.
  Unrelated Playwright visual specs were also being loaded by `bun test`.
- Fix is runner-level only, no product or test-semantics change:
  `pixie-wizard` runs one Bun process per test file, and the root runner is
  scoped to `core lib` (the Wizard suite has its own runner; nothing is
  skipped).
- Results: root `npm test` 1414 pass / 0 fail (exit 0); Wizard `npm test`
  passes across all 16 test files (exit 0); typecheck and production build
  pass. The visual specs were renamed to `screenshots.visual.ts` with an
  explicit Playwright `testMatch` so `bun test` ignores them.

## Known Risks

- The current checkout contains extensive unrelated dirty work.
- Several shared files combine feature work with unrelated edits.
- Core and Wizard duplicate program/API contracts.
- Tenant isolation is application-enforced rather than database RLS-enforced.
- SQLite migration ordering and dedupe atomicity are behavior-critical.
- Existing baseline tests are not fully green.
- No formal Wizard visual regression infrastructure exists.
- The tracked Core database/WAL and local source files may contain sensitive
  operational data and must never become rewrite fixtures or commits.

## Rewrite Decision

The rewrite must proceed as a strangler migration behind frozen contracts.
Greenfield replacement of the whole repository in one pass is prohibited by
the parity requirement because it would make behavior differences impossible to
attribute or roll back.
