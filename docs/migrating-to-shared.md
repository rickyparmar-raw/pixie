# Dedicated → Shared Migration

Move a legacy isolated Pixie (own container, own Slack app, own `pixie.db`)
onto shared hosted Pixie without losing history and without double-replies.

## Principle

Shared Pixie evaluates in **shadow mode** while the legacy bot still owns the
channel: routing, retrieval, AI decisions, and silent ticket rows all run, but
nothing public sends (no answers, cards, acks, reactions, or dashboard
replies). Cutover is one flag flip, after you stop the legacy bot. Rollback is
a file copy.

## Procedure

1. **Inspect** the legacy database:
   `bun scripts/migrate-to-shared.js inspect --source /path/legacy.db`
2. **Validate** against the live Core database:
   `bun scripts/migrate-to-shared.js validate --source legacy.db --target $PIXIE_DB_PATH --workspace T012345`
   Fix reported channel conflicts first (a channel has exactly one owner).
3. **Import** (lands in shadow mode; target is backed up automatically):
   `bun scripts/migrate-to-shared.js import --source legacy.db --target $PIXIE_DB_PATH --workspace T012345`
   Re-running is safe — tickets dedupe on `(workspace, thread)`, facts/gaps on
   normalized question.
4. **Verify**: `... verify --target $PIXIE_DB_PATH` (integrity + counts).
   Compare a few threads: shared ticket rows should mirror legacy behavior.
5. Invite `@Pixie` to the program channels; confirm membership in Wizard.
6. **Cutover**: stop the legacy bot, then
   `bun scripts/migrate-to-shared.js cutover --target $PIXIE_DB_PATH --program sol`
7. **Rollback** (Core stopped):
   `bun scripts/migrate-to-shared.js rollback --target $PIXIE_DB_PATH --backup $PIXIE_DB_PATH.bak-<ts>`
   then restart the legacy bot.

## What migrates

Program metadata, sources, milestones, approved learned facts, pending facts,
doc gaps, tickets with timeline events and internal notes, channel claims.
Skipped by design: answer caches, thread transcripts, rate-limit rows,
short-term user memory.

## Wizard trial rows

Existing `pixie_trials` stay valid and keep the dedicated lifecycle. New
hosted programs do not create trials, Railway projects, or Slack apps.
