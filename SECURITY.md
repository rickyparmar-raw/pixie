# Pixie Security Model

## Tenancy

Every program boundary keys on **workspace + channel/message**, never bare
channel IDs. Caches, retrieval, learned facts, gaps, tickets, notes, helpers,
macros, analytics, audit, and retention are all program-scoped in queries —
never UI filtering alone. Proven by `lib/tenancy.test.js` (two tenants, same
question, different knowledge, zero bleed) and cross-write denial tests on
every mutating internal route.

## Secrets

| Secret | Lives in | Never in |
|---|---|---|
| Shared Slack tokens | Core env / secret manager | program rows, logs, snapshots |
| Model provider keys | Core env (pooled, rotated) | program rows, Wizard browser |
| `PIXIE_INTERNAL_TOKEN` | Core env + Wizard server env | browser bundles, logs |
| Per-trial legacy tokens | Wizard AES-256-GCM columns | plaintext, `config_snapshot` (redacted) |
| Railway pool tokens | Wizard AES-256-GCM columns | hosted rows, logs |
| Supabase service key | Wizard server env | `NEXT_PUBLIC_*`, browser |

Supabase has deny-by-default RLS (`004`) as a structural backstop; the real
boundary is service-role-only server access plus explicit session/owner/helper
checks. Audit events never record secret material.

## Permissions

Requester < helper < organizer < owner < platform admin. Card buttons act
within Slack channel membership; dashboard/internal mutations re-verify
helper-or-admin membership per program server-side, with tenant-match on every
ticket-scoped write. Retention sweeps require organizer+. Client-supplied
`programId`/roles are never trusted.

## Source ingestion (SSRF)

Organizer URLs are untrusted input. Core validates before fetching: http(s)
only, no loopback/link-local/RFC1918 (string + resolved-IP checks on every
address), redirect hops revalidated (max 5). Wizard screens private literals
at the form; Core revalidates with DNS. `lib/sourceGuard.*` + tests.

## Abuse

Per-user answer rate limits, per-actor copilot budgets, bounded Slack retries
with `Retry-After`, single-flight job leases, pagination caps, no `limit`
escalation. User text embedded in Slack blocks is markup-escaped (channel-wide
mention injection tested).

## What remains external

Production secret values, Slack workspace admin approval for the shared app
(and re-authorization when adding `chat:write.customize`), Supabase project
backups, and the legacy-bot shutdown at cutover are owner actions — tooling
exists for all of them, but they are not automated.
