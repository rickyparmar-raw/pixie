# Graph Report - pixie  (2026-08-31)

## Corpus Check
- 104 files · ~195,282 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1346 nodes · 2275 edges · 79 communities (75 shown, 4 thin omitted)
- Extraction: 81% EXTRACTED · 19% INFERRED · 0% AMBIGUOUS · INFERRED: 433 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d50b0cc0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- llm.test.js
- commands.js
- db.js
- handlers.js
- lookup.js
- learn.js
- api.js
- knowledge.js
- guides.js
- cache.js
- shop.js
- serve.js
- app.js
- report.js
- config.js
- Visual Tutorial System for Pixie
- Pixie
- package.json
- programs.js
- program.js
- auth.js
- retrieve.js
- answer.js
- log.js
- Test Questions for Intent Classifier
- deploy
- index.js
- deploy
- respond.js
- brand.js
- home.js
- respond.test.js
- home.test.js
- Real Screenshots Captured ✓
- pixiewizard — architecture plan
- commands.test.js
- intent.js
- Screenshot Replacement Checklist
- generate_screenshots.js
- optimize-screenshot.js
- now
- llm.js
- lib/probe.js
- optimize-screenshots.js
- stats.js
- config
- lookup.test.js
- answer.test.js
- firecrawl.js
- learn.test.js
- 1. 📚 Taught Facts & Core Rules
- chat.js
- Handoff checklist — pixie to a new Railway account
- migrate-railway.mjs
- smoke-test.js
- Path A — through the wizard
- vision.js
- probe.test.js
- test-diff.mjs
- scripts/package.json
- warm.js
- channelsList
- relatedThreads.js
- warm.test.js
- probe.js
- cache.test.js
- db.test.js
- normalizeQuestion
- sweep
- schema.js
- context.js
- handlers.test.js
- onMessage
- teachThread.js
- guides.test.js
- teachThread.test.js
- context.test.js
- captureFromReply

## God Nodes (most connected - your core abstractions)
1. `handle()` - 65 edges
2. `now()` - 35 edges
3. `config` - 29 edges
4. `register()` - 19 edges
5. `directAnswer()` - 16 edges
6. `api()` - 16 edges
7. `esc()` - 14 edges
8. `isAdmin()` - 13 edges
9. `relativeTime()` - 13 edges
10. `pixiewizard — architecture plan` - 13 edges

## Surprising Connections (you probably didn't know these)
- `startBot()` --calls--> `resolveBotUserId()`  [EXTRACTED]
  index.js → lib/config.js
- `startBot()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `runAskCli()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `streamCompletion()` --indirect_call--> `delta()`  [INFERRED]
  lib/llm.js → lib/report.js
- `knowledgeInfo()` --calls--> `relativeTime()`  [EXTRACTED]
  lib/web/api.js → lib/stats.js

## Import Cycles
- None detected.

## Communities (79 total, 4 thin omitted)

### Community 0 - "llm.test.js"
Cohesion: 0.17
Nodes (8): assert, axios, getReader(), llm, REQUEST, sse(), STANDBY, { test }

### Community 1 - "commands.js"
Cohesion: 0.08
Nodes (35): adminOnly(), answer, approveCommand(), askCommand(), brand, { config, isAdmin }, context, db (+27 more)

### Community 2 - "db.js"
Cohesion: 0.08
Nodes (44): approvedFacts(), { Database }, DEFAULT_PATH, deleteGuide(), deleteLearnedByStatus(), deleteLearnedFact(), deleteLearnedRange(), deleteProgram() (+36 more)

### Community 3 - "handlers.js"
Cohesion: 0.15
Nodes (16): { config, isAdmin }, context, db, DOWN_REACTIONS, guides, learn, log, messageAuthor() (+8 more)

### Community 4 - "lookup.js"
Cohesion: 0.18
Nodes (17): answer, answerOrChat(), cache, cacheHit(), dateFallback(), db, firecrawl, idOf() (+9 more)

### Community 5 - "learn.js"
Cohesion: 0.15
Nodes (12): approve(), cache, captureFromThread(), { config }, db, forget(), forgetByStatus(), forgetRange() (+4 more)

### Community 6 - "api.js"
Cohesion: 0.06
Nodes (11): cache, { coverageStats, relativeTime }, db, knowledge, knowledgeInfo(), learn, { probe }, programs (+3 more)

### Community 7 - "knowledge.js"
Cohesion: 0.08
Nodes (41): annotateHeadingAnchors(), APP_ROOT, axios, buildCorpus(), cache, corpusBuiltOnMap, corpusCacheMap, docSlugFromFilename() (+33 more)

### Community 8 - "guides.js"
Cohesion: 0.11
Nodes (29): advanceGuideByReaction(), advanceToNextStep(), answer, answerStuckQuestion(), classifierPrompt(), classifyStepReply(), { config }, continueGuide() (+21 more)

### Community 9 - "cache.js"
Cohesion: 0.18
Nodes (13): cachedCount(), cacheRow(), crypto, db, get(), getCachedAnswer(), isVolatile(), keyFor() (+5 more)

### Community 10 - "shop.js"
Cohesion: 0.13
Nodes (39): ALIASES, amountAnswer(), applyAliases(), asksAboutPrice(), axios, corpusText(), current(), DEFAULT_ECONOMY (+31 more)

### Community 11 - "serve.js"
Cohesion: 0.11
Nodes (27): api, auth, broadcastSSE(), fs, handleApi(), handleAuth(), handleRequest(), handleScreenshots() (+19 more)

### Community 12 - "app.js"
Cohesion: 0.14
Nodes (34): allChannelsData, api(), appendFeed(), askBtn, askInput, askResult, askTrace, connectSSE() (+26 more)

### Community 13 - "report.js"
Cohesion: 0.07
Nodes (43): answer, answeredFrom(), brand, classifyGaps(), collect(), { config }, { coverageStats, relativeTime }, db (+35 more)

### Community 14 - "config.js"
Cohesion: 0.09
Nodes (31): adminUserIds, collectGroqKeys(), collectHcaiKeys(), collectZenKeys(), coolingUntil, faqChannels, groqApiKeys, groqCoolingUntil (+23 more)

### Community 15 - "Visual Tutorial System for Pixie"
Cohesion: 0.07
Nodes (27): Adding New Visual Guides, Adding/Updating Screenshots, Architecture, Backwards Compatibility, Code Flow, Credits, Current Status, Environment Variables (+19 more)

### Community 16 - "Pixie"
Cohesion: 0.06
Nodes (31): App Home, As a service, Deep links in replies, Environment Variables, Feedback and docs gaps, How it works, How pixie answers, Intent classifier (+23 more)

### Community 17 - "package.json"
Cohesion: 0.06
Nodes (31): axios, dotenv, author, dependencies, axios, dotenv, sharp, @slack/bolt (+23 more)

### Community 18 - "programs.js"
Cohesion: 0.09
Nodes (34): addChannelToProgram(), all(), { config }, db, forChannel(), fs, get(), helpChannelName() (+26 more)

### Community 19 - "program.js"
Cohesion: 0.15
Nodes (20): buildNamesRegexPattern(), buildTimingPattern(), corpusSection(), describeEntry(), describeWhen(), directAnswer(), escapeRegex(), extractMilestones() (+12 more)

### Community 20 - "auth.js"
Cohesion: 0.15
Nodes (15): crypto, getSession(), handleCallback(), { isAdmin }, log, parseCookies(), requireAdmin(), requireSession() (+7 more)

### Community 21 - "retrieve.js"
Cohesion: 0.11
Nodes (21): buildIndex(), chunkSection(), chunkSections(), foldPlural(), log, score(), selectChunks(), selectContext() (+13 more)

### Community 22 - "answer.js"
Cohesion: 0.19
Nodes (23): answerOrChatPrompt(), answerRequest(), { config }, getAnswerOrChat(), getAnswerOrChatStream(), getGroundedAnswer(), helpChannelRef(), linkifyHelpChannel() (+15 more)

### Community 23 - "log.js"
Cohesion: 0.06
Nodes (32): { config }, debug(), error(), format(), info(), notify(), subscribers, warn() (+24 more)

### Community 24 - "Test Questions for Intent Classifier"
Cohesion: 0.18
Nodes (10): Casual Statements (CASUAL_CHAT), Documentation & Resources (HELP_NEEDED), Game Mechanics (HELP_NEEDED), General Pixl Questions (HELP_NEEDED), Joining & Getting Started (HELP_NEEDED), Prizes & Rewards (HELP_NEEDED), Projects & Shipping (HELP_NEEDED), Technical Setup (HELP_NEEDED) (+2 more)

### Community 25 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 26 - "index.js"
Cohesion: 0.14
Nodes (19): { App }, commands, { config, validate, resolveBotUserId }, db, guides, handlers, knowledge, log (+11 more)

### Community 27 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 28 - "respond.js"
Cohesion: 0.09
Nodes (29): db, ASKS_WHAT_THEY_MEAN, brand, buildChatContext(), buildContextPrompt(), { config }, context, db (+21 more)

### Community 29 - "brand.js"
Cohesion: 0.07
Nodes (26): cmd(), envValue(), id(), name(), slug(), assert, brand, { test } (+18 more)

### Community 30 - "home.js"
Cohesion: 0.14
Nodes (19): adminOnlyShortcut(), isAdmin(), brand, cache, db, guides, homeBlocks(), { isAdmin } (+11 more)

### Community 31 - "respond.test.js"
Cohesion: 0.07
Nodes (24): fetchUrlContent(), http, https, isBlockedHost(), isPrivateOrLoopbackIp(), knowledge, log, net (+16 more)

### Community 32 - "home.test.js"
Cohesion: 0.22
Nodes (6): assert, { config }, db, learn, { reviewBlocks, reviewAction, coverageBlocks, homeBlocks }, { test }

### Community 33 - "Real Screenshots Captured ✓"
Cohesion: 0.20
Nodes (9): Captured Screenshots, customize-character (3 screenshots), Next Steps, Optimization, Real Screenshots Captured ✓, shop-purchase (4 screenshots), Source, submit-project (5 screenshots) (+1 more)

### Community 34 - "pixiewizard — architecture plan"
Cohesion: 0.08
Nodes (24): 0. The blocking findings, first, 10. Open questions, 11. What has been built, 1. What already works and is worth keeping, 2. Vocabulary, 3. The wizard, 4.1 One slug drives every name, 4.2 User-facing copy (+16 more)

### Community 35 - "commands.test.js"
Cohesion: 0.25
Nodes (6): assert, commands, { config }, learn, teachThread, { test }

### Community 36 - "intent.js"
Cohesion: 0.13
Nodes (20): buildUserPrompt(), classifyIntent(), { complete }, { config }, db, historyFor(), intentSystemPrompt(), log (+12 more)

### Community 37 - "Screenshot Replacement Checklist"
Cohesion: 0.25
Nodes (7): customize-character (3 screenshots needed), Notes, Screenshot Guidelines, Screenshot Replacement Checklist, shop-purchase (4 screenshots needed), submit-project (5 screenshots needed), Testing

### Community 38 - "generate_screenshots.js"
Cohesion: 0.32
Nodes (7): { firefox }, fs, main(), path, saveWebp(), SCREENSHOTS_DIR, sharp

### Community 39 - "optimize-screenshot.js"
Cohesion: 0.25
Nodes (7): args, fs, outputDir, outputDirOnly, outputPath, path, sharp

### Community 40 - "now"
Cohesion: 0.07
Nodes (28): addLearnedFact(), addThreadMessage(), claimMessage(), claimTicket(), closeTicket(), countRecentRequests(), createTicket(), gapCountsByKind() (+20 more)

### Community 41 - "llm.js"
Cohesion: 0.21
Nodes (17): axios, backoffMs(), completeAttempts(), completeStream(), describeError(), https, isRetryableError(), isRetryableStatus() (+9 more)

### Community 42 - "lib/probe.js"
Cohesion: 0.25
Nodes (8): answer, cache, elapsedMs(), intent, knowledge, probe(), retrieve, handleAsk()

### Community 44 - "stats.js"
Cohesion: 0.18
Nodes (12): pendingCommand(), sourcesCommand(), statsCommand(), coverageBlocks(), learnedBlocks(), cache, { config }, coverageStats() (+4 more)

### Community 46 - "config"
Cohesion: 0.29
Nodes (6): config, assert, axios, { config }, firecrawl, { test, before, after, beforeEach }

### Community 47 - "lookup.test.js"
Cohesion: 0.29
Nodes (6): assert, db, lookup, PROG, programs, { test }

### Community 48 - "answer.test.js"
Cohesion: 0.29
Nodes (5): answer, assert, { config }, llm, { test }

### Community 49 - "firecrawl.js"
Cohesion: 0.29
Nodes (9): axios, { config }, getApiKey(), isCreditsExhausted(), log, markCreditsExhausted(), scrapeCache, scrapeUrl() (+1 more)

### Community 50 - "learn.test.js"
Cohesion: 0.29
Nodes (6): assert, { config }, db, learn, llm, { test, before, after }

### Community 51 - "1. 📚 Taught Facts & Core Rules"
Cohesion: 0.12
Nodes (16): 1. 📚 Taught Facts & Core Rules, 2. 🔍 Document Gaps & Missed Questions, 3. 📊 Answered Messages Ledger (295 Total), 4. 👍 User Feedback & Satisfaction Ratings (39 Total), 5. 🏷️ User Topics Discovered (27 Total), Fact #1 — `how to get pixels and use them`, Fact #2 — `decrypt this`, Fact #3 — `there isn't any streak system in pixl right?` (+8 more)

### Community 52 - "chat.js"
Cohesion: 0.21
Nodes (13): looksLikeCode(), pixlGuardrail(), chatSystemPrompt(), { complete }, { config }, debugSystemPrompt(), getChatReply(), looksLikeQuestion() (+5 more)

### Community 53 - "Handoff checklist — pixie to a new Railway account"
Cohesion: 0.15
Nodes (12): 0. Snapshot the current project, 1. Set up the new Railway account, 2. Create the new project, 3. Write the env (most error-prone step), 4. Volume handoff, 5. Deploy the new service, 6. Smoke test the new service, 7. Cut over (+4 more)

### Community 54 - "migrate-railway.mjs"
Cohesion: 0.36
Nodes (12): callRailway(), diff(), dumpExpected(), fetchCurrentVars(), loadFile(), main(), OPTIONAL_KEYS, printDiff() (+4 more)

### Community 55 - "smoke-test.js"
Cohesion: 0.35
Nodes (12): callRailway(), checkAnswer(), checkLogs(), checkWho(), fetchRecentLogs(), fetchVars(), latestDeploymentId(), main() (+4 more)

### Community 56 - "Path A — through the wizard"
Cohesion: 0.17
Nodes (11): 1. Supabase, 2. Wizard environment, 3. Railway pool, 4. Run it, 5. After the deploy goes green, Adding the second bot, Path A — through the wizard, Path B — one bot by hand (+3 more)

### Community 57 - "vision.js"
Cohesion: 0.28
Nodes (8): analyzeImage(), axios, { complete }, { config }, fetchSlackImageAsDataUri(), log, { normalizeEmoji }, visionSystemPrompt()

### Community 58 - "probe.test.js"
Cohesion: 0.29
Nodes (6): answer, assert, db, intent, { probe }, { test, after }

### Community 59 - "test-diff.mjs"
Cohesion: 0.47
Nodes (4): diff(), OPTIONAL, redactedForLog(), REQUIRED

### Community 61 - "warm.js"
Cohesion: 0.24
Nodes (11): cache, db, faqQuestions(), knowledge, log, lookup, refreshStale(), sleep() (+3 more)

### Community 62 - "channelsList"
Cohesion: 0.50
Nodes (4): channelAdd(), channelRemove(), channelsList(), channelToggle()

### Community 63 - "relatedThreads.js"
Cohesion: 0.16
Nodes (13): buildSlackPermalink(), calculateTokenSimilarity(), db, findRelatedThread(), isSimpleLookupQuestion(), log, SIMPLE_LOOKUP_PATTERNS, STOP_WORDS (+5 more)

### Community 64 - "warm.test.js"
Cohesion: 0.20
Nodes (7): assert, cache, db, knowledge, lookup, { test }, warm

### Community 65 - "probe.js"
Cohesion: 0.33
Nodes (5): db, full, probe, rej, top

### Community 66 - "cache.test.js"
Cohesion: 0.40
Nodes (4): assert, cache, db, { test }

### Community 67 - "db.test.js"
Cohesion: 0.40
Nodes (4): assert, cache, db, { test }

### Community 68 - "normalizeQuestion"
Cohesion: 0.50
Nodes (4): clearGapRejection(), normalizeQuestion(), recordGap(), recordGapRejection()

### Community 71 - "context.js"
Cohesion: 0.20
Nodes (5): db, deriveTopic(), log, STOPWORDS, updateUserHistory()

### Community 72 - "handlers.test.js"
Cohesion: 0.18
Nodes (9): assert, { config }, context, db, handlers, learn, respond, { test } (+1 more)

### Community 73 - "onMessage"
Cohesion: 0.31
Nodes (10): findImage(), handleImage(), isDirectMessage(), mentionsPixieByName(), mentionsPixieDirectly(), onAppMention(), onMessage(), respond (+2 more)

### Community 74 - "teachThread.js"
Cohesion: 0.29
Nodes (7): buildTranscript(), { config }, learn, llm, { MAX_TOKENS }, summarizeThread(), SYSTEM_PROMPT

### Community 75 - "guides.test.js"
Cohesion: 0.33
Nodes (5): assert, db, guides, llm, { test, before, after }

### Community 76 - "teachThread.test.js"
Cohesion: 0.33
Nodes (4): assert, llm, teachThread, { test, before, after }

### Community 77 - "context.test.js"
Cohesion: 0.40
Nodes (4): assert, context, db, { test }

### Community 78 - "captureFromReply"
Cohesion: 0.67
Nodes (3): captureFromReply(), judgeAnswer(), log

## Knowledge Gaps
- **592 isolated node(s):** `$schema`, `builder`, `dockerfilePath`, `startCommand`, `restartPolicyType` (+587 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `config` connect `config` to `commands.js`, `handlers.js`, `learn.js`, `api.js`, `guides.js`, `report.js`, `config.js`, `programs.js`, `answer.js`, `log.js`, `index.js`, `respond.js`, `respond.test.js`, `home.test.js`, `commands.test.js`, `intent.js`, `stats.js`, `answer.test.js`, `firecrawl.js`, `learn.test.js`, `chat.js`, `vision.js`, `handlers.test.js`, `teachThread.js`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `isAdmin()` connect `home.js` to `commands.js`, `handlers.js`, `onMessage`, `config.js`, `auth.js`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Why does `complete()` connect `chat.js` to `llm.js`, `intent.js`, `vision.js`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Are the 15 inferred relationships involving `register()` (e.g. with `commands.js` and `approveCommand()`) actually correct?**
  _`register()` has 15 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `builder`, `dockerfilePath` to the rest of the system?**
  _592 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `commands.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08412698412698413 - nodes in this community are weakly interconnected._
- **Should `db.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0782608695652174 - nodes in this community are weakly interconnected._