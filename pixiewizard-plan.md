# pixiewizard — architecture plan

How a YSWS lead goes from "I have a Slack workspace" to "my bot is live" in one web
session, and how every bot in the fleet picks up a new pixie feature the moment it
lands on `main`.

Written against the tree as it stands: `pixie/` (the bot, Bun + Bolt Socket Mode,
`lib/*.js`) and `pixie-wizard/` (Next.js control plane, Supabase, Railway GraphQL).
Decisions taken in this plan: a pool of separate Railway accounts, every bot tracking
`main` with auto-deploy, and one shared engine that rebrands itself from `pixie` to the
YSWS bot's name rather than being forked per program.

---

## 0. The blocking findings, first

Four things must change before a shared image can serve two differently-branded bots.
Every later section is blocked on them.

**Per-bot config is on disk.** `lib/programs.js` reads `programs.json`,
`sources.json`, and `program.json` from the repo root at boot. `programs.json` today
contains Pixl's and Twisted's channel IDs, sources, and milestones. In a shared-image
fleet the image is identical everywhere, so this file cannot be the source of truth —
bot #7 would boot holding Pixl's channel IDs.

**The wizard's sources never reach the bot.** This is the one that makes the current
wizard unable to produce a correct bot at all. It collects sources, stores them in
Supabase, and then `generateConfig.ts` emits no source variable — so the deployed bot falls
through to `legacyFallbackProgram()` and answers from Pixl's Quick Links. Section 4.4 has
the full env-contract diff; this is the headline.

**Two sources point at repo files.** `quick-links.json` and `twisted-faq.json` are
referenced as `file://./quick-links.json` in the source list. A per-bot FAQ cannot be a
file baked into a shared image.

**Slash commands are hardcoded.** `lib/commands.js` registers fourteen literal strings
(`/pixie`, `/pixie-teach`, `/pixie-program`, …). `pixie-wizard/lib/slackManifest.ts`
emits the same literals into the Slack manifest. A bot named `dispatch` would get a
manifest advertising `/dispatch-teach` while the process listens for `/pixie-teach`, and
every admin command would silently no-op.

The fix for all four is the same shape: config arrives as environment, not as files;
command names are derived from one slug, not typed out. Sections 3 and 4 spell it out.

---

## 1. What already works and is worth keeping

Roughly 70% of the control plane exists and is tested. This plan extends it rather than
restarting it.

`lib/railway.ts` is real, introspected-against-the-live-schema Railway client code:
`projectCreate` → `serviceCreate` → `variableCollectionUpsert(skipDeploys: true)` →
`environmentTriggersDeploy`, plus deployment status polling with a correct terminal-state
set, and `pauseService`/`resumeService`/`deleteProject`. The `skipDeploys: true` detail
matters — it's the difference between one deploy and one partial redeploy per variable.

`lib/railwayPool.ts` already implements the multi-account pool this plan needs:
least-loaded account selection, claim/release counters, a cooldown penalty on failure,
and `PoolExhaustedError` rather than a doomed retry. Its own comment is honest that
claim is a non-atomic read-then-write; section 5 says when that starts to matter.

`lib/crypto.ts` (AES-256-GCM under `WIZARD_ENCRYPTION_KEY`) and the `*_encrypted`
columns mean no plaintext token is ever at rest, and `redactEnvForSnapshot` keeps the
audit trail in `config_snapshot` free of live secrets. `WIZARD_DRY_RUN` lets the whole
provisioning path run without touching Railway, which is what makes the changes below
testable.

`generateConfig.ts` already generates a per-trial env map including a
`PIXIE_IDENTITY_OVERRIDE` that rewrites the bot's self-description — the seed of the
rebranding mechanism, extended in section 4.

Two things in there are now wrong and get fixed in passing. `generateConfig.ts` sets
`PIXIE_ANSWER_FALLBACK_BASE_URL`, a variable `lib/config.js` no longer reads; the
fallback is now built by `zenStandby()`. And `slackManifest.ts` says it was assembled
from the README and never diffed against a real Slack export — it needs that diff before
anyone trusts it, because a wrong manifest fails at install time, in front of the user.

---

## 2. Vocabulary

The control plane currently calls every deployment a *trial*, with a unique index
enforcing one live trial per requester. The fleet this plan describes has long-lived
production bots in it, so the noun changes to **bot**, and *trial* becomes a
`lifecycle` value on a bot (`trial` | `permanent`). The one-live-per-requester index
must be dropped: Pixl and Twisted are both yours, and a fleet operator will own many.

- **engine** — the pixie code, one repo, one image, one `main`.
- **bot** — one deployed instance: a Slack app, a Railway service, and a config row.
- **fleet** — every bot the control plane knows about.
- **pool account** — one Railway account holding some number of bots.

---

## 3. The wizard

Login is Hack Club Auth, already built (`app/api/auth/*`), gated by
`PIXIE_WIZARD_ALLOWLIST`. Leave that allowlist unset and anyone with an HCA account can
provision a Railway service on your bill — set it before this is public.

Each step writes to the bot row and returns. Nothing is held in client state, so a
closed tab resumes exactly where it left off — `stepForTrial()` already derives the step
from row contents, and that pattern carries over unchanged.

Where each field you listed lands: *your name* and *bot name* in step 1, alongside the
YSWS/program name (your "u-ship v-ship name" — the program this bot serves, e.g. Solvable,
Penumbra, Twisted). *Credentials* split across two steps because they fail differently —
model keys in step 2, where a bad key is a form error, and Slack tokens in step 3, where
they can't exist until the app does. *The commands you need* is step 6: which command
surfaces this bot actually gets (guides on/off, tickets on/off, learning commands, the
weekly report), because a small YSWS probably wants the answering commands and not the
report machinery. *The slash commands* is the naming of those commands, decided in step 1
by the slug and shown live as you type — the two are separate questions and separating
them keeps step 1 short. *Sources* in step 5, *help channel* in step 4, *admins* in
step 7.

**Step 1 — you and your program.** Your name (prefilled from HCA), the program name
(*Solvable*), the program slug (`solvable`, derived, editable, validated
`^[a-z][a-z0-9-]{1,20}$`), the bot's display name (*Sol*), and the bot's command slug
(derived from the display name, `sol`, giving `/sol`, `/sol-teach`, `/sol-gaps`). Show
the resulting command list live as they type — it is the single most confusing thing in
the flow and the cheapest to make obvious. One-line program description, used in the
identity block and the Slack app description.

The slug is the load-bearing field. Everything downstream keys off it: the Railway
project name, the command prefix, the `PIXIE_BOT_SLUG` variable, the manifest. Slugs must
be unique across the fleet — enforce with a unique index, not a check-then-insert.

**Step 2 — model credentials.** Base URL, model, API key, exactly as
`LlmKeyStep.tsx` does now, and keep `llmValidate.ts`'s live probe: a bad key caught here
is a form error, and a bad key caught at deploy time is a crashed service the user cannot
debug. Offer the two known-good defaults (Zen `deepseek-v4-flash-free`, or an HCAI key)
rather than an empty box.

Accept a *list* of keys, not one. `lib/config.js` already scans
`OPENCODE_API_KEY`, `_2`, `_3`… into a rotating pool with per-key cooldown, and the same
for `HCAI_API_KEY`. The wizard collecting only one key throws away a feature the engine
already has, and rate-limit pressure is the most likely reason a new bot looks broken in
its first week.

**Step 3 — Slack app handshake.** The wizard renders a manifest, the user creates the
app at `api.slack.com/apps` from it, enables Socket Mode, and pastes back `xoxb-` and
`xapp-`. `SlackHandshakeStep.tsx` does this today. Two upgrades: the manifest must be
generated from the bot's command slug rather than the `/pixie-*` literals, and the pasted
tokens must be verified with `auth.test` before the step is allowed to complete —
capturing `team_id`, `team` and the bot's own `user_id` into the row.

This step stays manual on purpose. Slack app creation from a manifest cannot be done on
someone's behalf without a Slack org-level app-config token, which is a heavier ask than
pasting two strings once.

**Step 4 — channels.** `ChannelPickerStep.tsx` already lists public channels with the
bot's own token. Collect: the help channel (escalation target, where the weekly report
lands by default), the FAQ/answer channels, and note that the *first* FAQ channel is the
auto-reply channel — `config.slack.autoReplyChannel` is `faqChannels[0]`, which is
surprising enough that the UI should label it rather than leave it to be discovered.
Optional ticket channel if tickets are on.

**Step 5 — sources.** GitHub docs directory, rendered docs site, plain URL, or an
inline FAQ typed into a textarea. The engine supports `github-dir`, `url`, `json-faq`,
and `pixl-shop` source types. Two changes needed: `json-faq` must accept inline content
stored in the row instead of only a `file://` path (section 0), and a source added here
should be probed once — a 404'd docs URL discovered now beats a bot that answers
"I don't know" for a week. Firecrawl key optional, for sites that need JS rendering.

**Step 6 — behaviour.** Posture (`active` replies whenever it can, `passive` only when
mentioned or when intent classification is confident, `muted` for setup). Scope
(`program` keeps it to this program's docs, `any` lets it answer general YSWS
questions). Which guides to enable, from the engine's registry — `submit-ysws-guidelines`
is the fleet-wide one and should default on. Tickets on/off. Escalation reaction emoji.
Feedback reactions, defaulting to off, matching the engine's own default.

**Step 7 — admins.** Slack user IDs allowed to run the mutating commands. This one
deserves a hard stop in the UI: `isAdmin()` fails closed, so an empty list means nobody
can ever teach the bot anything, and the requester's own ID should be prefilled and
non-removable.

**Step 8 — review and deploy.** Show the resolved env map with secrets masked — the
same `redactEnvForSnapshot` output that gets written to `config_snapshot`. Then
`provisionTrial` → pool pick → project + service create → variables → deploy, with
`DeployingStep.tsx` polling `checkTrialDeployStatus`. That polling design (trigger, then
poll separately) is correct and stays: Railway builds routinely outlive a serverless
function's execution window.

A Railway **volume** must be attached before first deploy. `lib/db.js` writes
`pixie.db` next to the code by default; without a volume, every redeploy wipes the
answer cache, learned facts, ticket records, and the last-good docs copy. Mount at
`/data` and set `PIXIE_DB_PATH=/data/pixie.db`. This is currently missing from
`railway.ts` entirely — no `volumeCreate` call exists — and it is the highest-severity
gap in the provisioning path, because it silently loses user data rather than failing.

**Step 9 — post-deploy.** Once status is `SUCCESS`: the bot needs to be invited to its
channels. It self-joins public channels at boot via `conversations.join`, which covers
most cases; private channels need a manual invite, so say so explicitly. Then run a smoke
test — post a known question through the bot's own token and confirm an answer comes
back — and only then call the bot live. A green Railway build only proves the process
started.

---

## 4. The template contract: pixie → any YSWS bot

The goal, stated as you put it: everything pixie can do shows up in the next bot, with
the name `pixie` becoming that bot's name — commands, identity, help text, all of it.
One engine, no forks. A new bot is a config row, not a repo.

### 4.1 One slug drives every name

Introduce two variables and derive everything from them:

```
PIXIE_BOT_SLUG=sol      # command prefix, ids
PIXIE_BOT_NAME=Sol      # display name in prose
```

Then in `lib/commands.js`, replace the fourteen literals with a helper:

```js
const SLUG = process.env.PIXIE_BOT_SLUG || "pixie";
const cmd = (suffix) => (suffix ? `/${SLUG}-${suffix}` : `/${SLUG}`);

app.command(cmd(), plainSpoken(askCommand));
app.command(cmd("teach"), plainSpoken(adminOnly(teachCommand)));
// …
```

Slack delivers whatever command name the app is configured with, so as long as the
manifest and the listener are generated from the same slug they cannot drift.
`slackManifest.ts` takes the slug as an argument and emits the same strings.

Three details that will bite otherwise. `/guide` is registered unprefixed as an alias
for `/pixie-guide` — it must become `/${SLUG}-guide` plus an optional unprefixed alias,
because two bots in one workspace cannot both own `/guide`, and *every bot in the fleet
will share the Hack Club workspace*. Slash command names are globally unique per
workspace, so the slug uniqueness constraint from step 1 is not cosmetic — a collision
makes the second app fail to install. Same for the shortcut `callback_id`
`pixie_teach_thread`, which is per-app and therefore safe, but should still be slugged
for legibility.

### 4.2 User-facing copy

Roughly 380 occurrences of "pixie"/"pixl" across shipped `lib/` and `index.js`
(test files excluded — they don't ship), concentrated in `commands.js` (44),
`respond.js` (30), and the identity block. Not all of it needs to change — internal
identifiers, log tags and comments are fine as they are — but every string a user reads
does.

Do it with a single accessor rather than a find-and-replace: a `lib/brand.js` exporting
`name` (display), `slug` (commands), and `handle` (mention text), all falling back to
today's pixie values so the default deployment is byte-identical. Then work outward from
the highest-traffic files: `commands.js` help text, `respond.js` fallbacks,
`identity.js`, `home.js` app-home blocks, `report.js` prompt preamble.

`report.js` is worth calling out — its prompts hardcode "a program where teenagers
build and ship projects" and name Pixl directly. A bot for a 3D-printing YSWS gets worse
reports because the judging prompt is describing a different program. Feed the program
name and description in from config.

`identity.js` already has the escape hatch: `PIXIE_IDENTITY_OVERRIDE` short-circuits
the whole block, and `generateConfig.ts` already writes a generated one. Keep that, but
generate a fuller override that also mentions the bot's real command names — the current
generated text says "use /pixie <question>", which will be wrong for every bot in the
fleet.

Also in `identity.js`: the "Who made you" answer ("Ricky built me…") and the "Are you
Pixorpheus" pair are Pixl-specific. The override path drops them, which is correct, but
the fallback path is what a misconfigured bot shows, so it should degrade to something
program-neutral.

### 4.3 Config from environment, not from disk

`lib/programs.js` gains one more loader ahead of the file loaders: if
`PIXIE_PROGRAMS_JSON` is set, parse it and use it. The existing file path stays as the
fallback, so the Pixl deployment keeps working untouched and no migration is forced.

```
loadFromEnv()  →  loadFilePrograms()  →  legacyFallbackProgram()
```

Same for inline FAQ content: extend the source resolver so `{ type: "json-faq",
content: [...] }` is honoured alongside `{ type: "json-faq", url: "file://…" }`. That
removes the last reason a bot would need a file in the image.

A Railway variable has a size ceiling, so a genuinely large inline FAQ should be stored
in Supabase and fetched by the bot at boot with a `PIXIE_CONFIG_URL` + token. Worth
designing the accessor for that now even if the first implementation reads the env var,
because retrofitting a fetch into a synchronous boot path is unpleasant.

### 4.4 The wizard→engine env contract, as it actually stands

I diffed every key `generateConfig.ts` emits against every `process.env` read in the
shipped engine. The wizard generates ten variables. The engine reads thirty-four. The gap
is where this plan's real work is, so it's worth listing rather than describing.

**The severe one: sources never reach the bot.** `SourcesStep.tsx` collects sources and
`trials.sources` stores them in Supabase, and `generateConfig.ts` emits *no source
variable at all*. A bot provisioned by the wizard today boots, finds no
`programs.json` override, and falls through `legacyFallbackProgram()` — which reads
`sources.json` from the image, i.e. Pixl's Quick Links. The single most important thing the
user chose in the wizard is silently discarded, and the bot answers from the wrong
program's docs. Section 4.3's `PIXIE_PROGRAMS_JSON` is what closes this; until it exists,
the wizard cannot produce a correct bot.

**Same shape, less severe:** posture, scope, guides, and milestones have no env path
either. `posture` is read only from `programs.json` (`lib/programs.js:63`); `scope` has
`PIXIE_SCOPE` but it's global, not per-program (`lib/programs.js:44`). So wizard step 6
is unimplementable as env vars — it has to go through the programs blob. That's an argument
for doing `PIXIE_PROGRAMS_JSON` early and routing everything program-shaped through it,
rather than inventing a variable per field.

**Collected-or-promised but never emitted:** `PIXIE_DB_PATH` (the volume — data loss),
`PIXIE_ESCALATE_REACTION` (step 6's escalation emoji; unset disables the handoff entirely),
`PIXIE_FEEDBACK_REACTIONS`, `PIXIE_REPORT_CHANNEL`, `FIRECRAWL_API_KEY`,
`REFRESH_INTERVAL_MIN`, and the multi-key pools `OPENCODE_API_KEY_2…N` / `HCAI_API_KEY`.

**Emitted but dead:** `PIXIE_ANSWER_FALLBACK_BASE_URL`. No shipped engine file reads it —
confirmed, the only hits are in `pixie-wizard/.next` build output. The fallback is built by
`zenStandby()` now. Harmless, but the comment above it in `generateConfig.ts` describes a
landmine that no longer exists, which is worse than no comment.

**Fine to leave unset:** the intent and vision tiers (`INTENT_CLASSIFIER_*`,
`PIXIE_VISION_*`, `VISION_API_KEY`) all default to Zen with the shared key pool, so they
work without wizard involvement. The web console (`SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET`, `PIXIE_WEB_URL`, `PIXIE_SESSION_SECRET`) stays off when unset by
design — note though that `lib/web/auth.js:19` falls back to a *random* session secret if
the console is ever enabled without one, which invalidates sessions on every restart.

### 4.5 What "new YSWS bot in ten minutes" then means

Fill the wizard, paste two Slack tokens, click deploy. No repo, no fork, no code. The
bot comes up with all fourteen commands under its own name, the guides you enabled, your
docs loaded, your admins, your channels — running the exact same image as every other bot
in the fleet, which is precisely why section 5's one-push update works.

---

## 5. Railway: a pool of separate accounts

This is the model you asked for, so this section covers how to run it. It also has to
state the risk plainly, because the risk is account termination and it is not
hypothetical.

### 5.1 The risk, stated once

Railway's Acceptable Use Policy treats multi-accounting as abuse, and their own RFC on
the change is titled "One Chocolate Per Person" — the metaphor being that they moved from
a candy bowl to a camera on the candy bowl. Their forums have multiple threads of
accounts banned for "Trial Plan Abuse" with appeals refused, including people who created
duplicates by accident. Verification for the free trial exists specifically to detect
multiple accounts per person.

What that means concretely: N accounts each holding a free trial, created by you, sharing
a machine, a card, and an IP, is the pattern their automation is built to catch. If it
fires, you don't lose one bot — you lose the accounts, and the projects on them, possibly
without warning.

What is defensible: **N accounts that are each genuinely paid and genuinely
separately owned.** A Hobby subscription per account, or an account per YSWS program
owned and paid by that program's lead with you added as a workspace member. Adding
members to a workspace costs no seat fee, so "their account, your access" is both cheap
and legitimate — and it is the version of your architecture that survives contact with
their policy.

If separate accounts are the goal purely for blast-radius isolation, note that Railway's
own project boundary already gives you per-project variables, logs, metrics, volumes, and
usage accounting, with a 50-project ceiling on Hobby. The isolation you get from separate
accounts over separate projects is billing separation and quota separation — real, but
much narrower than it sounds.

Recommendation: build the pool exactly as described below, because it costs nothing extra
and it is what the schema already models, but populate it with legitimately separate
accounts (one paid Hobby each, or program-owned), not with N free trials you created.
The code is identical either way; only the sourcing of the accounts differs, and that is
the part that determines whether the fleet is still there next month.

### 5.2 The pool

`railway_account_pool` already holds `label`, `api_token_encrypted`,
`max_concurrent_trials`, `current_trial_count`, `cooling_until`, `disabled`. Add:
`owner_email`, `plan` (`free` | `hobby` | `pro`), `notes`, and `token_created_at` so
rotation has a date to reason about. Add `bot_count` semantics distinct from trial count
once *trial* stops meaning *bot*.

Selection stays least-loaded-first with cooldown, and `PoolExhaustedError` stays a hard
failure rather than a retry — a half-created cloud resource is worse than an error
message. The non-atomic claim is fine at manual provisioning frequency; make it a
Postgres RPC with `update … set current = current + 1 where current < max returning *` if
two people ever provision at once, because the failure mode is a silently over-committed
account.

### 5.3 Managing N accounts from one machine — the actual mechanics

The important insight: **you never log into these accounts to operate the fleet.** Every
routine operation is an API call with an account-scoped token, and the control plane holds
the tokens. Browser logins are needed only for the things the API cannot do — creating the
account, adding a payment method, changing the plan.

So the working setup is:

*Tokens, not sessions.* One account-scoped Railway API token per account, created once
in that account's UI, encrypted into `railway_account_pool`. The control plane
decrypts on demand (`getPoolAccountToken`). Nothing on your laptop holds a Railway
credential; nothing depends on a browser session staying alive.

*One browser profile per account, for the rare manual visit.* Separate Chrome/Firefox
profiles keyed to the account label — not incognito, not one profile with logout/login,
because logging in and out of the same profile repeatedly is exactly the signal that
looks like multi-accounting. If a profile is only opened to change billing, it's opened
twice a year.

*Distinct real identities per account.* Each account needs its own email that receives
mail (`+` aliases on one Gmail are trivially collapsible and won't read as separate) and,
if paid, its own or its owner's payment method. If accounts are program-owned, this
happens naturally and is the strongest version of the setup.

*A local inventory that is not the source of truth.* `railway_account_pool` in Supabase
is authoritative. A `pixie fleet accounts` CLI command reads it and prints label, owner,
plan, bot count, cooling status, token age. Don't keep a spreadsheet — it will disagree
with reality within a month.

*No Railway CLI in the loop.* `railway login` is interactive and per-machine, and the
CLI's multi-workspace handling wants `--workspace` on every non-interactive call. The
GraphQL API with an explicit token per call has no ambient state to get wrong, which is
what you want when a mistake means deploying bot A's config to bot B.

*Token hygiene.* Rotate on a schedule using `token_created_at`, one account at a time,
and keep `disabled` as the kill switch: flip it and the pool stops selecting that account
without touching the bots already on it.

### 5.4 One-time per-account setup

Per account, once: create it, add payment method and plan, connect GitHub so the engine
repo is deployable (this is required — `serviceCreate` takes
`source: { repo: "rickyparmar-raw/PIXIE" }`, and the account's GitHub install must cover
that repo or every provision fails at create), mint an account-scoped API token, insert
the encrypted row.

The GitHub connection is the step most likely to be forgotten and the least obvious when
it breaks, because the failure surfaces as an opaque Railway API error during
provisioning. Worth a `pixie fleet check-account <label>` that provisions and immediately
deletes a throwaway project, verifying the whole chain before a real user hits it.

---

## 6. Fleet updates: everyone tracks `main`

Chosen model: every service is wired to the engine repo's `main`, Railway's GitHub
integration fires per service on push, and the fleet rebuilds itself. No orchestration
code required, which is the strongest argument for it.

```
git push origin main
  → Railway webhook per service, per account
  → every bot rebuilds, restarts, reconnects Socket Mode
```

Because `serviceCreate` is already called with
`source: { repo: PIXIE_REPO_FULL_NAME }, branch: "main"`, this works the moment each
pool account's GitHub app can see the repo. Nothing to build.

### 6.1 What this costs, and the two mitigations worth having

The honest tradeoff: a bad commit breaks every bot at once, simultaneously, across
accounts you'd then have to fix one by one. The engine is a Slack bot with no inbound
HTTP, so Railway's healthcheck cannot catch a bot that boots and then answers nothing —
`config.validate()` throws loudly on missing variables, which covers config errors, but
not a logic regression.

Two mitigations, both cheap, both worth doing before the fleet is larger than about five
bots:

*Green tests gate the push.* There is no `.github/workflows/` directory in the repo
today. `bun test` exists and the suite is substantial. A CI workflow running it on push
to `main` — with branch protection so a red suite can't land — is the single highest-value
addition in this whole plan, because under auto-deploy `main` is production for every
program at once.

*A fleet health check, not a fleet deployer.* `pixie fleet status` walks
`railway_account_pool` × bots, calls `latestDeploymentStatus` for each, and prints
anything not `SUCCESS`. Run it after a push. This is ~40 lines against functions that
already exist, and it turns "did that break anything" from a question into a command.

### 6.2 When a redeploy has to be explicit

Auto-deploy covers code. Three cases need a manual trigger, and all three already have
their primitive:

- **Config change** — the wizard's settings view writes new variables:
  `setVariables(skipDeploys: true)` then `triggerDeploy` for that one bot.
- **Resurrection** — a paused bot: `resumeService`, which correctly already calls
  `triggerDeploy` itself, because a slept Socket Mode service will never wake on its own
  (there is no inbound traffic to wake it — `railway.ts` documents this).
- **Backfill** — a variable that must be added to every bot at once (a new required
  env var introduced by a feature). This is the one genuinely fleet-wide mutation:
  iterate bots, `setVariables`, `triggerDeploy`.

That last case is the coupling to watch. Under auto-deploy, a commit that requires a new
env var deploys before the variable exists, and `validate()` throws — every bot down until
the backfill finishes. So the rule for the engine is: **new configuration must always
default to today's behaviour**, never be required. `lib/config.js` is already written this
way throughout (every new var has a default or is optional), and that discipline is now
load-bearing rather than merely tidy.

Add the variable in a first push, backfill it, then ship the commit that uses it. Two
pushes, no outage.

---

## 7. Data model changes

Against `pixie-wizard/supabase/schema.sql`:

Rename `pixie_trials` → `bots`, or keep the table and add a `lifecycle` column
(`trial` | `permanent`); the rename is cleaner and this is early enough to pay for it.
**Drop** `pixie_trials_one_live_per_requester` — a fleet operator owns many bots.

New columns: `bot_slug` (unique, not null — the load-bearing field), `program_slug`,
`posture`, `scope`, `guides jsonb`, `admin_slack_ids jsonb`, `escalate_reaction`,
`feedback_reactions`, `ticket_channel`, `report_channel`, `volume_id`,
`firecrawl_key_encrypted`, `llm_keys_encrypted jsonb` (the pool from step 2, replacing
the single `llm_key_encrypted`), `engine_ref` (`main` today; present so pinning is
possible later without a migration), `lifecycle`, `last_smoke_test_at`.

Most of those columns exist to be *rendered into the programs blob*, not read
individually by the engine — posture, scope, guides, and the milestone list have no
per-field env path and never will. Keep one function that turns a bot row into
`PIXIE_PROGRAMS_JSON` and treat it as the contract; adding a program-shaped field then
means one column and one line in that renderer, not a new variable to plumb.

`railway_account_pool` gains `owner_email`, `plan`, `token_created_at`, `notes`.

`trial_events` → `bot_events`, unchanged in shape. It's the audit trail for a system
that holds live Slack tokens for other people's workspaces; keep every provisioning
mutation logged there.

---

## 8. Security

Three points, because this system's blast radius is other people's Slack workspaces.

The Supabase row holds live `xoxb-`/`xapp-` tokens for external orgs plus Railway
account tokens that can create and delete infrastructure. `WIZARD_ENCRYPTION_KEY`
compromise is total compromise. It belongs only in the deployment's env, never in a repo,
and the Supabase project should be reachable only by the service role key.

`PIXIE_WIZARD_ALLOWLIST` empty means any Hack Club Auth account can provision on your
Railway bill. `CRON_SECRET` empty means the lifecycle sweep endpoint — which pauses and
deletes bots — is callable by anyone who finds the URL. Both fail open today. Both should
refuse to boot when unset in production rather than defaulting to permissive.

Deleted bots must have their tokens purged, not just their status flipped. A `deleted`
row still holding a valid `xoxb-` is a credential you're storing for a workspace you no
longer serve.

---

## 9. Order of work

Items 1–5, 7 and 9 are **done** — see §11 for what landed. What remains:

6. Wizard steps for behaviour (posture, scope, guides, tickets, escalation reaction) and
   admins, plus multi-key entry on the model step. The columns, the env contract and the
   programs renderer are all in place, so this is form UI writing to columns that already
   exist. Verify under `WIZARD_DRY_RUN`.
8. `pixie fleet status` (walk the pool × bots, report anything not `SUCCESS`) and
   `pixie fleet check-account` (provision and delete a throwaway project, proving the
   account's GitHub connection before a real user hits it).
10. Second Railway pool account, sourced legitimately. Provision one real bot on it, and
    smoke-test it end to end before offering the wizard to anyone else.

Also outstanding, and cheap: run the migration against Supabase, diff the generated Slack
manifest against a real Slack export, and turn on branch protection so the new CI workflow
actually gates `main` rather than merely reporting on it.

---

## 11. What has been built

Landed against the tree, with tests. Engine suite: 555 cases, 554 passing — the one
failure is `link.test.js`'s `isBlockedHost allows public domain names`, which resolves
real hostnames through DNS and fails in this sandbox for lack of it, not from any change
here. Wizard suite: 87 cases, all passing, `tsc --noEmit` clean.

**Per-bot config now reaches the bot.** `lib/programs.js` gained a
`PIXIE_PROGRAMS_JSON` loader ahead of the file loaders, and `generateConfig.ts` renders
the bot row into it (`renderProgramsJson`). This closes §0's headline bug: sources were
collected, stored, and never sent, so every provisioned bot answered from Pixl's docs. The
env blob wins outright over the image's `programs.json` — a fleet bot must never inherit
whichever program the image was built for. Malformed JSON logs and falls back to files
rather than crash-looping, since a bot nobody can reach is worse than a bot with stale
config.

`shared()` needed the same treatment and it wasn't obvious: it read `sources.json`
directly, which is Pixl's quick links, so a Solvable bot was picking them up as a second
source. Once `PIXIE_PROGRAMS_JSON` is set, the file isn't consulted — a bot supplies its
own shared layer via a `ysws-global` entry or gets an empty one.

**Inline FAQ content works.** `fetchSourceText` handles `{ type: "json-faq", content:
[...] }` alongside `file://` URLs, accepting both the wrapped `{faq:{items}}` envelope and
a bare array. `loadSources()` had to stop requiring a `url` — it was silently dropping
every inline source before it could be fetched, and inline sources key on name alone so
two of them don't collapse into one.

**The volume exists.** `createVolume` in `railway.ts`, called before the first deploy
because the engine opens SQLite on boot, with `PIXIE_DB_PATH=/data/pixie.db` in the
generated env. `environmentId` is always sent: it isn't marked required in
`VolumeCreateInput`, but omitting it makes Railway report success while creating a volume
attached to nothing. A volume failure releases and penalizes the pool account like any
other provisioning failure, and is recorded as `volume_failed` rather than lumped in with
deploy failures.

**One slug drives every name.** `lib/brand.js` exposes `name()`, `slug()`, `cmd()` and
`id()`, all read per call rather than captured at require time. `commands.js` registers
from `cmd(...)`; `slackManifest.ts` generates the same twelve names from a suffix list, so
manifest and listeners cannot drift. The bare `/guide` alias is now registered only for the
default bot — command names are unique per workspace and every fleet bot shares the Hack
Club one, so a second bot claiming it would fail to install. The wizard's Slack step gained
a command-prefix field that renders the resulting command list live.

**The copy sweep.** `identity.js`, `home.js`, `report.js` and `commands.js` read their
name and commands from `brand`. Two behavioural finds along the way: `report.js`'s judging
prompts described Pixl by name in every deployment, so a bot for a 3D-printing YSWS was
having its gaps judged against a description of a different program; and `respond.js`
matched the literal word "pixie" for both the guide-menu and mute triggers, meaning a
rebranded bot could not be told to shut up at all. Both now match the bot's own name, with
the interpolated values regex-escaped.

Two claims that shouldn't be repeated for a rebranded bot are dropped rather than
rewritten: "Ricky built me" (a fabricated origin story for another program's bot) and the
Pixorpheus comparison (a sibling that doesn't exist outside Pixl).

**Everything defaults to today's behaviour.** Verified by running the engine with no new
variables set: the same twelve `/pixie-*` commands plus `/guide`, the same
`pixie_teach_thread` shortcut, the same two programs, the same six sources, the same
identity text naming Ricky and Pixorpheus. Then with `PIXIE_BOT_SLUG=sol` and a Solvable
blob: `/sol-*` commands, `sol_teach_thread`, one program, only Solvable's inline FAQ in the
corpus, and no Pixl content anywhere in it. This matters more than any single feature —
it's what makes the whole change safe to land on the bot that's currently live.

**CI and schema.** `.github/workflows/test.yml` runs `bun test` on push and PR to
`main`, Bun pinned to the version in `packageManager`. `supabase/migrations/001_fleet_config.sql`
adds the bot slug (unique, since a duplicate breaks Slack installation), the
program-shaped columns, the behaviour knobs, the extra credential slots, the volume id,
and pool-account provenance — and drops the one-live-trial-per-requester index, which was
right for a trial programme and wrong for a fleet.

The dead `PIXIE_ANSWER_FALLBACK_BASE_URL` is no longer emitted.

---

## 10. Open questions

**Whose Railway accounts?** Section 5.1 is the one decision in this plan I'd want
settled before writing provisioning code, because "N free trials I made" and "one paid
account per program lead" produce identical code and opposite outcomes.

**Does sleeping actually stop billing?** `railway.ts` flags this as unverified without a
live account-scoped token. It determines whether pausing a trial saves money or merely
stops the bot.

**Slash command and app-count budget.** Every bot is a separate Slack app claiming
fourteen commands. I could not confirm a documented per-workspace slash command ceiling —
Slack documents an app-install limit (10 apps on free workspaces; paid workspaces are the
relevant case here and the limit isn't published the same way) but not a command count.
Command *names* are definitely unique per workspace, which the slug constraint handles.
Two things to check against the real workspace before the fleet grows: whether app installs
are capped, and whether fifteen bots × fourteen commands makes the autocomplete menu
unusable for members. Collapsing the admin surface into one `/<slug> admin <verb>` would
take each bot from fourteen commands to about four, and is worth doing on legibility
grounds regardless of any limit.

**One volume per bot at what cost?** Each bot's SQLite volume is billed storage per
account. Small, but it's the per-bot floor cost and worth knowing before quoting a number.

---

Sources: [Railway pricing plans](https://docs.railway.com/pricing/plans) ·
[project limits per plan](https://station.railway.com/questions/projects-limits-797a0c14) ·
[Acceptable Use Policy](https://railway.com/legal/fair-use) ·
[free trial verification](https://docs.railway.com/pricing/free-trial) ·
["One Chocolate Per Person" RFC](https://blog.railway.com/p/free-plan-changes) ·
[a refused multi-accounting ban appeal](https://station.railway.com/questions/banned-account-8ad5ae3e) ·
[workspace members cost no seat](https://docs.railway.com/projects/workspaces) ·
[Railway GraphQL overview](https://docs.railway.com/integrations/api/graphql-overview) ·
[Slack workspace app limits](https://slack.com/help/articles/115002422943-Usage-limits-for-free-workspaces)
