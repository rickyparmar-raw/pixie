# Pixie

A Slack bot that answers questions grounded in the Pixl FAQ and docs, across whichever channels it's configured to watch (e.g. `#pixl-help`, `#pixl`). It's a separate app from [Pixorpheus](../pixorpheus) — pixie only answers questions from documentation; it does not touch tickets, claiming, or resolving. Both bots can run in the same channel at once.

## How it works

### Where pixie speaks

| Trigger | Behaviour |
|---|---|
| Real `@`-mention, anywhere | Always replies |
| DM | Always replies, full conversational mode |
| `#pixl-help` (`SLACK_HELP_CHANNEL`), top-level | Replies when the message is asking for help (HELP_ONLY) |
| `#pixl` (first `SLACK_FAQ_CHANNELS` entry) | Replies when the intent classifier says the message is a real question |
| Plain-text "pixie …" elsewhere | Replies **only** if the docs cover it, silent otherwise |
| `/pixie <question>` | Ephemeral reply, visible only to the asker |

A plain-text name mention is a weak signal ("pixie bye" shouldn't get a reply), so
outside the channels pixie owns it stays silent unless the docs actually cover the
question. That check is a free local regex, not an AI call, so it costs nothing on
messages that don't mention pixie.

In `#pixl`, thread replies only reach the classifier if pixie is already part of that
thread or was named in the message — otherwise every message in every unrelated thread
would cost a network round-trip.

### How pixie answers

1. **Docs first.** The question plus the whole knowledge corpus goes to the model in one
   call, instructed to answer **only** from the provided docs. This is always tried first
   and always wins.
2. **Conversational fallback.** If the docs don't cover it *and* pixie was addressed
   directly, it answers like a person would — general coding, tools, math, small talk.
   It's hard-blocked from inventing Pixl specifics: anything about deadlines, prizes,
   regions or rules that isn't in the docs gets an honest "not sure, ask in #pixl-help".
3. **Fallback.** If it wasn't really a question, the short neutral reply.

Pasted code or a stack trace routes to a debug-oriented prompt instead of the doc lookup;
uploaded images go to the vision model.

The answer is **streamed**: pixie posts a `_thinking..._` placeholder and rewrites it in
place as the words arrive, at most one edit per 800ms. The first text lands around 2s
instead of the ~4.9s it used to take to show anything at all — the model's own time to
first token is ~1.5s and everything after that used to be dead air.

In the auto-reply channel, where nobody addressed pixie, a second small model call decides
whether anyone was actually asking. It runs **alongside** the answer rather than in front
of it, and nothing is posted until it agrees — so the judgement is unchanged and only the
waiting is gone.

Every message is answered at most once — the dedupe claim is an atomic SQLite insert, so
a redelivered event or an overlapping `message`/`app_mention` pair can't double-post.

### Pixie gets faster the more it's asked

A question pixie has answered before costs **no model call at all** — one Slack post, about
400ms, against ~2.4s for a fresh one. The interesting part is how many questions end up in
that state.

The key is a sorted set of the meaningful words, so "whats the deadline", "when is the
deadline" and "deadline?" are one entry rather than three, and contractions reduce the same
way as the words they contract. Anything with conversation context in the prompt is never
cached: that answer was shaped by one specific thread.

Three things then make the cache accumulate rather than reset:

- **It counts what gets asked.** Every hit bumps `ask_count`, which is the only record of
  which questions actually matter.
- **It refreshes instead of forgetting.** The cache used to be swept wholesale every six
  hours, so freshness and forgetting were the same action and a question asked at 9am was a
  full model call again by 4pm. Now an entry past six hours is still served while
  `lib/warm.js` regenerates it in the background, most-asked first. An entry is only dropped
  once nobody has asked that phrasing for a week.
- **It starts out knowing the FAQ.** On boot the warmer answers every question in the
  Q/A sources — 16 of them — so a fresh deployment is already fast on the canonical asks
  instead of learning each one through a slow first ask. It takes about 35s, spaced out, in
  the background.

The one exception is the program timeline, whose answers carry a live countdown ("august 18
— in 21 days"). Those are never served stale: past six hours they fall through to a real
lookup, because yesterday's copy isn't just old, it's wrong.

`/pixie-stats` and the App Home tab report how many answers pixie knows cold, what share of
replies needed no thinking, and which questions get asked most.

### Feedback and docs gaps

Every question the docs *can't* answer is logged — but a miss is a much weaker claim than
"the docs should cover this". The live log had an outage, somebody's broken laptop and a
half-typed fragment sitting next to the genuine gaps, so the list read as noise and nobody
worked through it.

Each missed question is now judged once, in the background, into one of three kinds:

| Kind | Meaning | Example from the real log |
|---|---|---|
| `docs` | a real question the documentation should answer | "who are pixl orgs" |
| `transient` | true when asked, useless as documentation | "my pfp is bugged sometimes" |
| `noise` | never something the docs could answer | "even sp[aces failed me" |

`/pixie-gaps` shows only the `docs` ones, which is what it always claimed to be. Judged
against the real 91-row backlog, that's 8 genuine gaps out of 91. The judge fails closed:
an error or an unreadable verdict leaves the row unjudged and off the list, rather than
guessing it on. Reacting
:thumbs-up:/:nono: on a pixie answer records a vote, and `/pixie-stats` shows the answer
rate, cache hit rate and median latency. The `first_token` metric records how long each
reply took to start appearing, as distinct from how long it took to finish.

In `#pixl-help`, an unanswerable question also gets reacted with
`PIXIE_ESCALATE_REACTION` — the marker helpers (and Pixorpheus's ticket flow) look for.

### The weekly report

A list nobody reads doesn't move anything, so pixie posts one every Monday at 09:00 to
`PIXIE_REPORT_CHANNEL` (defaulting to `SLACK_HELP_CHANNEL`). `/pixie-report` prints the same
report on demand, and `/pixie-report last` gives the previous week.

It covers what the docs should answer and don't, one line for how much was filtered out as
not-a-docs-problem, and what went well — coverage against the week before, how many answers
pixie now knows cold, feedback, and time to first word. The "already posted" marker lives in
the `metrics` table, which the sweeper never touches, so a restart can't double-post.

With neither `PIXIE_REPORT_CHANNEL` nor `SLACK_HELP_CHANNEL` set, the scheduled post stays
off and the command still works.

### Teaching pixie

Pixie can only answer from its corpus, and most of that corpus is files someone has to
edit and redeploy — so without this, every question the docs don't cover stays uncovered
forever. Two ways knowledge gets in from Slack:

**Directly.** `/pixie-teach <question> :: <answer>` — takes effect immediately.

**By watching helpers.** When pixie misses a question, it records the gap against that
message. If a human later answers in that thread, the reply is queued as a candidate.
Review it with the Approve/Drop buttons on the App Home tab, or with `/pixie-pending` and
`/pixie-approve <n>` / `/pixie-forget <n>`. Nothing enters the corpus unreviewed.

Capture only runs in `SLACK_HELP_CHANNEL`, and deliberately skips replies that are too short,
emoji/link-only, or written by the person who asked ("nvm figured it out" isn't an answer
anyone else can use). Anything that clears those checks is then put to a model — *does this
message actually answer that question?* — and dropped unless the answer is yes. Without that
last step the queue fills with whatever happened to be said next in the thread; it fails
closed, so an outage means no capture rather than a guessed one.

Approving or forgetting clears the answer cache, so the new answer takes effect at once.

## Slash commands

| Command | Who | Description |
|---|---|---|
| `/pixie [question]` | anyone | Private answer — help without cluttering the channel |
| `/pixie-sources` | anyone | What's loaded and when it last refreshed |
| `/pixie-stats` | anyone | Answer rate, cache hits, feedback, latency |
| `/pixie-gaps` | helpers | Top questions the docs didn't cover |
| `/pixie-report` | helpers | The weekly report now — add `last` for the previous week |
| `/pixie-teach` | helpers | Teach an answer directly |
| `/pixie-pending` | helpers | Captured answers awaiting review |
| `/pixie-approve <n>` | helpers | Start using a captured answer |
| `/pixie-forget <target>` | helpers | Drop answer(s) by id (`<n>`), range (`<from>-<to>`), `pending`, or `all` |
| `/pixie-reload` | helpers | Re-fetch the docs and clear the cache, no restart |

"helpers" means a user ID listed in `PIXIE_ADMIN_USER_IDS`. With that unset the helper
commands refuse everyone — they change what pixie tells people, so they fail closed.

### App Home

Pixie's Home tab (click pixie in the Slack sidebar) shows what it knows, what it can walk you
through, its docs-coverage percentage for the last 7 days, and the top gaps in the docs.

For helpers it also carries the **review queue**: each captured candidate answer with
**Approve** and **Drop** buttons. This is the intended way to work through the queue —
`/pixie-pending` and `/pixie-approve <n>` still work, but matching ids by eye across a wall of
ephemeral text is what left 96 candidates unreviewed. Requires *Interactivity* to be enabled on
the Slack app (setup step 7).

## Program dates

[`program.json`](./program.json) holds the real program milestones. Pixie recomputes them
into the corpus on every refresh, so it answers "in 4 days" and "already passed" instead of
reciting a date that has silently gone stale:

```json
{
  "timezone": "America/New_York",
  "milestones": [
    { "name": "Submissions close", "date": "2026-08-01", "note": "23:59 ET" }
  ]
}
```

Leave `milestones` empty and the section is omitted entirely — pixie is told never to state
a date that isn't listed, so an unconfigured file means it declines rather than guesses.

## Knowledge base — adding docs

Everything pixie knows lives in [`sources.json`](./sources.json). Each entry is fetched fresh on startup and every `REFRESH_INTERVAL_MIN` minutes (default 30). If a source fails to fetch, pixie keeps serving the last version it successfully loaded instead of dropping it.

To add a new doc, add an entry:

```json
{ "name": "Getting Started Guide", "type": "gdoc", "url": "https://docs.google.com/document/d/<id>/export?format=txt" }
```

Supported `type`s:

| Type | What it expects | Notes |
|---|---|---|
| `json-faq` | A URL to the landing site's dictionary JSON | Extracts `faq.items[].question` / `.answer` |
| `gdoc` | A public Google Doc export URL (`.../export?format=txt`) | Doc must be shared as "anyone with the link can view" |
| `url` | Any web page or raw text/markdown URL | HTML is stripped to plain text |

No embeddings or vector DB — the whole corpus is small enough to pass straight into the model's context, which keeps answers exact and avoids retrieval mismatches. If the corpus grows large enough that this stops being cheap, that's the point to revisit.

### Deep links in replies

For `url`-type sources, if a page wraps sections in an anchored container (e.g. `<section id="react-native"><h1>React Native app guide</h1>...`), pixie automatically picks that up and links to the exact section (`https://.../docs#react-native`) when it cites that section — turning "from the React Native app guide" into a clickable link in the reply, instead of just a name. This is a code-level lookup (`knowledge.getSourceUrl()`), not something the model generates itself, so a broken/hallucinated link isn't possible — if there's no matching anchor for what's cited, it just falls back to plain text (e.g. FAQ answers, which have no per-item URL to link to).

## Intent classifier

In the `#pixl` channel (the first entry in `SLACK_FAQ_CHANNELS`) pixie replies to real
questions without needing an `@`-mention. A cheap two-tier setup keeps that from being
spammy:

0. **Local pre-filter** (`couldNeedHelp`) — free regexes that drop the obvious chat before
   anything reaches a model. Historically 94% of classifications came back `CASUAL_CHAT`,
   so this is what stops most messages costing anything at all.
1. **Intent classifier** (`lib/intent.js`) — one small call that labels the message
   `HELP_NEEDED` or `CASUAL_CHAT`. It only sees the message, never the corpus, and is
   capped at 20 tokens.
2. **Grounded answer** (`lib/answer.js`) — the full corpus call.

Steps 1 and 2 run **concurrently**, not in sequence. The classifier used to finish before
the answer call started, which put its ~1700ms in front of every reply; now the answer is
already being generated while the verdict lands, and `lib/respond.js` holds the streamed
text back until the classifier agrees someone was asking. A `CASUAL_CHAT` verdict means
nothing was ever posted — not even a placeholder.

Folding the classifier into the answer call as a third output case was tried and reverted.
With the corpus in the same context the model conflates "nobody asked" with "the docs don't
cover it": across three trials, 6 of 15 genuine questions were silenced, including "how do
i submit my project" in two of them. Keeping it as its own corpus-free call is the point.

Replies to: "when does pixl end bro", "how do i join", "whats the deadline".
Stays silent for: "yo i love pixl", "gg everyone", "just shipped my project".

The classifier is deliberately strict about topic — coding, Pixl, setup and math count as
`HELP_NEEDED`; unrelated questions fall through to `CASUAL_CHAT` so pixie doesn't turn into
a general search box in a busy channel.

## Environment Variables

Every variable is read and validated once at startup by [`lib/config.js`](./lib/config.js) —
a missing required value fails fast with a list of what's absent, rather than degrading into
silent fallbacks at answer time.

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot token for pixie's own Slack app (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | App-level token for Socket Mode (`xapp-...`) |
| `SLACK_HELP_CHANNEL` | yes | Channel ID that always responds to every top-level message (e.g. `#pixl-help`) |
| `SLACK_FAQ_CHANNELS` | yes | Comma-separated channel IDs. The **first** entry is the auto-reply channel (`#pixl`) |
| `OPENCODE_API_KEY` | yes | API key for [OpenCode Zen](https://opencode.ai/zen) |
| `PIXIE_ANSWER_BASE_URL` | no | Answer endpoint base, default `https://opencode.ai/zen/v1` |
| `PIXIE_MODEL` | no | Answer model, default `deepseek-v4-flash-free` |
| `INTENT_CLASSIFIER_API_KEY` | no | Key for the intent classifier. Falls back to `OPENCODE_API_KEY` |
| `INTENT_CLASSIFIER_BASE_URL` | no | Default `https://opencode.ai/zen/v1` |
| `INTENT_CLASSIFIER_MODEL` | no | Default `deepseek-v4-flash-free` |
| `VISION_API_KEY` | no | Key for image analysis. Falls back to `OPENCODE_API_KEY` |
| `PIXIE_VISION_BASE_URL` | no | Vision endpoint base. Falls back to `OPENCODE_BASE_URL`, then Zen |
| `PIXIE_VISION_MODEL` | no | Default `kr/claude-sonnet-4.5` |
| `PIXIE_ADMIN_USER_IDS` | no | Comma-separated user IDs allowed to teach/approve. Unset = nobody |
| `PIXIE_FEEDBACK_REACTIONS` | no | Comma-separated emojis to pre-place on pixie's own answers. **Empty by default** — pixie doesn't react to itself. Set e.g. `sparkling_heart` to turn seeding on; names must be ones pixie counts (`UP_REACTIONS`/`DOWN_REACTIONS` in `lib/handlers.js`) |
| `REFRESH_INTERVAL_MIN` | no | How often to re-fetch docs, in minutes (default `30`) |
| `PIXIE_ESCALATE_REACTION` | no | Emoji to flag unanswerable help-channel questions with. Unset disables |
| `PIXIE_REPORT_CHANNEL` | no | Where the weekly report is posted. Defaults to `SLACK_HELP_CHANNEL`; unset with no help channel disables the scheduled post (`/pixie-report` still works) |
| `PIXIE_DEBUG` | no | Set to `1` for per-message debug logging (off by default) |
| `PIXIE_DB_PATH` | no | SQLite file, default `./pixie.db` |

Each of the three call sites has its **own** base URL, so pointing vision at a local proxy
can't silently retarget doc answers. Answers default to Zen and only move if
`PIXIE_ANSWER_BASE_URL` is set explicitly, since `PIXIE_MODEL` names a Zen model — a
self-hosted endpoint has to actually serve that model. `OPENCODE_BASE_URL` is still
honoured as the vision fallback, which is the meaning it had in practice.

Pixie calls OpenCode Zen's OpenAI-compatible `/chat/completions` endpoint, which is what
`deepseek-v4-flash-free` (and most non-Claude Zen models) use. Claude models on Zen are
served from a separate `/messages` (Anthropic format) endpoint instead — switching
`PIXIE_MODEL` to a Claude model requires also changing `lib/answer.js` to call that endpoint.

## Slack App Setup

Pixie needs its own Slack app (separate from Pixorpheus), running in **Socket Mode** — no public URL, tunnel, or deployment required for events to reach it.

1. Create a new app at [api.slack.com/apps](https://api.slack.com/apps).
2. **OAuth scopes:** `chat:write`, `channels:history`, `groups:history`, `channels:join`,
   `app_mentions:read`, `reactions:read`, `reactions:write`, `commands`, `im:history`,
   `im:write`, `channels:read`, `groups:read`, `files:read`.
    Slash commands to register: `/pixie`, `/pixie-guide`, `/guide`, `/pixie-sources`, `/pixie-stats`, `/pixie-gaps`,
    `/pixie-teach`, `/pixie-pending`, `/pixie-approve`, `/pixie-forget`, `/pixie-reload`,
    `/pixie-report`, `/pixie-program`.
3. **Socket Mode:** enable it, generate an App-Level Token with the `connections:write` scope (`xapp-...`).
4. **Event subscriptions:** enable events, subscribe to `message.channels`, `message.groups`,
   `message.im`, `app_mention`, `reaction_added`, `reaction_removed`, `app_home_opened`,
   and `member_joined_channel`. No Request URL needed once Socket Mode is on.
5. **Slash commands:** create the ten listed in step 2 — Slash Commands → *Create New
   Command*, one per name. Registering them in code only tells pixie what to listen for;
   until they exist in the Slack app itself, typing one does nothing. With Socket Mode on
   there is no Request URL field to fill in.
6. **App Home:** enable the Home tab and the Messages tab (with "allow users to send
   Slash commands and messages") so DMs reach pixie.
7. **Interactivity:** turn on *Interactivity & Shortcuts*. Socket Mode delivers it with no
   Request URL, but the toggle itself must be on or the Approve/Drop buttons on the Home tab
   will do nothing when clicked.
8. Install the app to the workspace. With `channels:join`, pixie can self-join any public channel listed in `SLACK_FAQ_CHANNELS` via the `conversations.join` API — no manual `/invite` needed for public channels (private channels still need a manual invite).
9. Copy the bot token (`xoxb-...`) and app-level token (`xapp-...`) into `.env`.

## Running

```bash
bun install
bun run start
```

Pixie runs on Bun (it uses `bun:sqlite` for state) — `node index.js` won't work.

### As a service

For anything beyond a quick test, run it under systemd so it restarts on crash and
survives logout:

```bash
mkdir -p ~/.config/systemd/user
cp scripts/pixie.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pixie
loginctl enable-linger "$USER"   # start at boot, survive logout

journalctl --user -u pixie -f    # logs
```

Edit `WorkingDirectory` and `ExecStart` in the unit if the checkout or `bun` lives
elsewhere — systemd runs with no login shell, so both must be absolute paths.

### State

Thread context, user history, dedupe, the answer cache, feedback and docs gaps live in a
single SQLite file (`pixie.db`, gitignored). It's created on first run; delete it to reset.
Because dedupe is persisted, a restart or redeploy can't make pixie re-answer messages it
already replied to — and because the answer cache is persisted too, a restart doesn't undo
what pixie has learned to answer instantly. Deleting the file makes it slow again until the
warmer has run.

### Offline test mode

Test what pixie would reply without connecting to Slack at all:

```bash
bun index.js --ask "how do i join pixl?"
```

This builds the corpus from `sources.json` and prints the answer — doc-grounded,
conversational, or the fallback — directly to the console. Requires only
`OPENCODE_API_KEY`, no Slack tokens, so it's useful for checking new docs or auth before
deploying.

## Tests

```bash
bun test
```

Covers config validation and base-URL precedence, corpus parsing and link preservation,
chunking and retrieval ranking, model-reply parsing, SSE parsing and stream retry rules,
mention/thread routing, the answer cache and its retention rules, the background warmer,
guide detection and progression, capture judging, the App Home review actions, retry
classification, and the SQLite layer (dedupe, caps, gap grouping, feedback).

The suite is hermetic and runs in well under a second — every model call is stubbed. When
adding a test that drives `respond()`, `learn.captureFromReply()` or `guides.detectGuideIntent()`,
stub `lib/llm.js`'s `complete` (and `lib/answer.js` where relevant) rather than letting it reach
the live API. Those modules are deliberately held as module objects instead of destructured
imports so that the stub takes effect.
