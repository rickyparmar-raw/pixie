# Visual regression fixtures

Deterministic Postgres seed + local Core stub behind
`tests/visual/wizard.visual.spec.ts`. App UI files are **not** touched by
this setup — only `tests/visual/*`, `playwright.config.ts`, and (already
present) `@playwright/test` are in scope.

## Files

| File | Purpose |
|---|---|
| `wizard.visual.spec.ts` | Screenshot spec: 18 routes × 4 projects. Do not add clock or data mocking here; determinism comes from the seed + stub below. |
| `seed.sql` | One fixture program (`visual-program`, owner `dev-local`, `status=active`) with channels, helpers, people, audit, and entitlement rows. Fixed IDs/timestamps; idempotent (deletes before inserting). |
| `core-stub.mjs` | Local HTTP stub for Core `/internal/v1/*` reads. Fixed JSON, `Authorization: Bearer` check, zero external calls (pure `node:http`, no deps). Read-only: mutations → `501`, unknown paths → `404`. |

## 0. Prerequisites

- A disposable Postgres (local `postgres:16` container or `createdb`). No
  snapshots are captured against shared databases.
- Node 20+, `npm install` already run (`@playwright/test` is in devDeps;
  do **not** add anything else).
- Nobody runs browsers until steps 1–6 are green. Snapshot capture is a
  separate, explicitly-gated step (see “Blocker” below).

## 1. Create the disposable database

```sh
# option A — docker (preferred, throwaway)
docker run --name pixie-visual-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pixie_wizard_visual -p 5433:5432 -d postgres:16
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/pixie_wizard_visual

# option B — local cluster
createdb pixie_wizard_visual
export DATABASE_URL=postgres://$USER@127.0.0.1:5432/pixie_wizard_visual
```

## 2. Migrate

`db/schema.sql` is the consolidated, idempotent schema; `npm run migrate`
applies `db/migrations/*` (no-op on a fresh DB, keeps drift parity):

```sh
psql "$DATABASE_URL" -f db/schema.sql
DATABASE_URL="$DATABASE_URL" npm run migrate
```

## 3. Seed

```sh
psql "$DATABASE_URL" -f tests/visual/seed.sql
```

This inserts: `wizard_people` (`dev-local`, `visual-helper-hca`),
`hosted_programs` (`visual-program`, owner `dev-local`, `synced`),
two `hosted_program_channels`, two `hosted_program_helpers`, three
`hosted_audit_events` (fixed UUIDs), one `wizard_entitlements` row, and a
`wizard_global_access` superadmin grant so `/overview` and `/programs`
render for `dev-local` instead of redirecting. Rerunning is safe.

## 4. Start the Core stub

```sh
PIXIE_INTERNAL_TOKEN=visual-stub-token CORE_STUB_PORT=4902 \
  node tests/visual/core-stub.mjs
# → [core-stub] listening on http://127.0.0.1:4902 (program=visual-program)
```

Health check (no auth): `curl 127.0.0.1:4902/healthz` → `{"ok":true}`.
Every other path requires `Authorization: Bearer visual-stub-token` or it
returns `401`. The stub covers the reads the pages issue: analytics,
tickets (+ single-ticket detail), knowledge candidates, gap clusters,
macros, helpers, helper stats, routing recommendations, usage (echoes the
requested `from`/`until` window so `lib/pixieCore.ts` validation passes),
incidents (+ detail/affected), radar, health, retention, audit, Slack
channels/membership, and Slack user info (single + batch).

## 5. Start the Wizard with fixed env

```sh
SESSION_SECRET=visual-test-secret \
BASE_URL=http://127.0.0.1:4901 \
DATABASE_URL="$DATABASE_URL" \
PIXIE_CORE_BASE_URL=http://127.0.0.1:4902 \
PIXIE_INTERNAL_TOKEN=visual-stub-token \
PIXIE_WIZARD_ALLOWLIST=dev@localhost \
npm run dev -- -p 4901
```

Notes:

- `SESSION_SECRET` must be set (`lib/session.ts` throws without it); the
  value only needs to be stable within one capture run.
- `BASE_URL` must match the serving origin — `/api/auth/dev-login`
  redirects to `${BASE_URL}/wizard`.
- `NODE_ENV` must **not** be `production`: the dev-login route is
  hard-gated to non-production builds.
- `PIXIE_WIZARD_ALLOWLIST` / `PIXIE_WIZARD_CREATOR_ALLOWLIST`: sign-in is
  open when the allowlist is empty; creation is invite-only when the
  creator allowlist is empty. Either is fine for snapshots — no creation
  flow is screenshotted.
- `PIXIE_INTERNAL_TOKEN` must equal the stub’s token.

## 6. Dev-login, then capture

```sh
# sign in as dev-local (matches the seed owner; sets the session cookie)
open http://127.0.0.1:4901/api/auth/dev-login
```

Capture (baseline repo, then the rewrite worktree, same seed + stub):

```sh
WIZARD_BASE_URL=http://127.0.0.1:4901 npx playwright test --project=desktop-light
```

First run on a clean tree writes `tests/visual/snapshots/<project>/…`;
subsequent runs compare. Keep the two trees’ snapshots apart
(`--output` / separate checkouts) and diff baseline vs rewrite, never a
mixed history.

## Route matrix (18 routes, `visual-program` unless noted)

| Snapshot | Route | DB rows | Core stub reads |
|---|---|---|---|
| `landing` | `/` | — | — |
| `wizard` | `/wizard?mode=hosted` | — | `slack/channels` |
| `overview` | `/overview` | owned programs | `analytics` × programs |
| `programs` | `/programs` | all active programs | — |
| `program` | `/programs/visual-program` | program + channels + helpers | `analytics`, `tickets`, `knowledge/candidates`, `helpers/stats`, `slack/channels` |
| `settings` | `…/settings` | program + channels | `slack/channels`, `slack/membership` |
| `tickets` | `…/tickets` | membership only | `tickets`, `slack/users/info` (batch) |
| `knowledge` | `…/knowledge` | program `sources` | `knowledge/candidates` |
| `gaps` | `…/gaps` | membership only | `gaps/clusters` |
| `macros` | `…/macros` | membership only | `macros` |
| `helpers` | `…/helpers` | `hosted_program_helpers` | `helpers`, `routing/recommend`, `helpers/stats`, `slack/users/info` (batch) |
| `people` | `…/people` | `wizard_people` | `slack/users/info` (batch) |
| `analytics` | `…/analytics` | membership only | `analytics`, `slack/users/info` (batch) |
| `usage` | `…/usage` | `wizard_entitlements` | `usage` |
| `incidents` | `…/incidents` | membership only | `incidents` |
| `audit` | `…/audit` | membership only | `audit`, `slack/users/info` (batch) |
| `radar` | `…/radar` | membership only | `radar`, `health` |
| `retention` | `…/retention` | membership only | `retention` |

## Projects (from `playwright.config.ts`)

| Project | Viewport | Color scheme |
|---|---|---|
| `desktop-light` | 1440×1000 (Desktop Chrome) | light |
| `desktop-dark` | 1440×1000 (Desktop Chrome) | dark |
| `mobile-light` | 390×844 (iPhone 13) | light |
| `mobile-dark` | 390×844 (iPhone 13) | dark |

Snapshots land in `tests/visual/snapshots/<project>/<name>.png`.
`baseURL` defaults to `http://127.0.0.1:4901` (override with
`WIZARD_BASE_URL`). Locale `en-US`, timezone `UTC`, `reducedMotion:
reduce`, `deviceScaleFactor: 1` are pinned in the config.

## 7. Cleanup

```sh
docker rm -f pixie-visual-db   # or: dropdb pixie_wizard_visual
rm -rf test-results/ playwright-report/
```

Seeded rows never touch shared databases; if you pointed at the wrong
`DATABASE_URL`, re-running `seed.sql` only rewrites `visual-program`
rows (it deletes that program’s rows first) — but verify with
`select * from hosted_programs where id = 'visual-program';`.

## Known nondeterminism (read before diffing)

- **Relative times drift.** Ticket/gap/audit/incident timestamps are fixed
  (`T0 = 2024-07-03T09:46:40Z` in the stub, `2024-07-0x` in the seed) but
  render via `timeAgo`/`shortTime`, so capture baseline and rewrite
  snapshots **back-to-back**; a days-old baseline will differ on those
  strings only.
- **Usage window echoes “now”.** The usage page queries `from=<now-30d>`
  to `to=<now>`; the stub echoes the window and returns fixed metrics, so
  only the window label can move between runs minutes apart.
- The spec pins `pixie-theme` from `prefers-color-scheme` per project but
  does not mock the clock or fonts — keep the same machine/fonts for both
  captures.
