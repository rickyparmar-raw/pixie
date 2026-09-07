# Pixie Wizard — shared control plane

Wizard stopped being "create me another Pixie server" and became "manage
programs connected to the Pixie network".

## Hosted Pixie (default)

One shared `@Pixie` app serves every program. Onboarding is configuration:

1. Create `#your-help` and `#your-organizers` in Slack, `/invite @Pixie` into both.
2. Open the Wizard → **Connect with hosted Pixie**.
3. Enter the program name + support identity, pick both channels from the
   selector (raw-ID fallback for private channels), enable AI + tickets, add docs.
4. **Activate** — seconds, no build, no deploy.

You never create a Slack app, paste `xoxb`/`xapp` tokens, provide an AI key,
or touch Railway. Model and Slack credentials live in central Pixie Core
infrastructure (`PIXIE_INTERNAL_TOKEN` stays server-side; the browser never
sees it). If Core is unreachable, programs still activate locally and sync
(`core_sync_state`) once it is back.

Program pages (`/programs/[id]`) hold settings, sources, the ticket queue,
ticket detail (claim/assign/resolve/reopen/snooze/duplicate, reply-as-program,
internal notes, timeline, copilot drafts, macro send), knowledge review,
FAQ gaps, macros, helpers + expertise, analytics, incidents, audit, and
retention (policy + confirmed sweep).

## Legacy dedicated path

Existing isolated deployments keep working: per-program Slack apps, Railway
pool provisioning (`lib/railway*.ts`, `provisionTrial.ts`), trial lifecycle
sweep (`sweepTrials.ts` — hosted rows suspend the tenant and never reach
Railway deletion). The dedicated onboarding steps remain behind the legacy
path in `/wizard`. Do not delete Railway pool code until migration is proven.

## Trial lifecycle

Dedicated trials: 14-day expiry → pause (7-day reclaim) → delete with secret
scrub. Hosted trials never touch Railway: expiry suspends the tenant,
reclaim archives it. The sweeper branches on `deployment_mode`, proven by
tests asserting zero Railway calls for hosted rows.

## Database

Supabase schema in `supabase/schema.sql`, migrations in
`supabase/migrations/` (001 fleet config, 002 hosted programs, 003 trial
deployment mode, 004 deny-by-default RLS backstop). `hosted_programs` + `hosted_program_channels` carry
workspace identity in every uniqueness boundary; channel claims are atomic
(`UNIQUE(workspace, channel)`), so double-submit Activate collapses and
channel hijacking fails with the owning program named.
