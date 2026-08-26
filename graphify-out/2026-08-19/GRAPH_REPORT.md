# Graph Report - pixie  (2026-08-19)

## Corpus Check
- 82 files · ~136,393 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1027 nodes · 1725 edges · 59 communities (57 shown, 2 thin omitted)
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 352 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `349bb737`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- intent.js
- commands.js
- db.js
- handlers.js
- lookup.js
- learn.js
- api.js
- knowledge.js
- guides.js
- cache.js
- link.js
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
- llm.js
- log.js
- Test Questions for Intent Classifier
- deploy
- report.test.js
- deploy
- respond.js
- identity.test.js
- home.js
- respond.test.js
- home.test.js
- Real Screenshots Captured ✓
- stats.js
- commands.test.js
- teachThread.js
- Screenshot Replacement Checklist
- generate_screenshots.js
- optimize-screenshot.js
- teachThread.test.js
- link.test.js
- rateLimit.js
- optimize-screenshots.js
- index.js
- answer.js
- context.js
- chat.js
- warm.js
- handlers.test.js
- warm.test.js
- firecrawl.js
- vision.js
- answer.test.js
- config
- learn.test.js
- cache.test.js
- db.test.js
- intent.test.js

## God Nodes (most connected - your core abstractions)
1. `handle()` - 56 edges
2. `now()` - 31 edges
3. `config` - 29 edges
4. `register()` - 17 edges
5. `api()` - 14 edges
6. `relativeTime()` - 13 edges
7. `esc()` - 11 edges
8. `isAdmin()` - 10 edges
9. `init()` - 10 edges
10. `Pixie` - 10 edges

## Surprising Connections (you probably didn't know these)
- `startBot()` --calls--> `resolveBotUserId()`  [EXTRACTED]
  index.js → lib/config.js
- `startBot()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `runAskCli()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `streamCompletion()` --indirect_call--> `delta()`  [INFERRED]
  lib/llm.js → lib/report.js
- `getChatReply()` --calls--> `normalizeEmoji()`  [EXTRACTED]
  lib/chat.js → lib/answer.js

## Import Cycles
- None detected.

## Communities (59 total, 2 thin omitted)

### Community 0 - "intent.js"
Cohesion: 0.16
Nodes (19): looksLikeCode(), buildUserPrompt(), classifyIntent(), { complete }, { config }, db, historyFor(), intentSystemPrompt() (+11 more)

### Community 1 - "commands.js"
Cohesion: 0.10
Nodes (30): adminOnly(), answer, approveCommand(), askCommand(), { config, isAdmin }, db, forgetCommand(), gapsCommand() (+22 more)

### Community 2 - "db.js"
Cohesion: 0.07
Nodes (66): addLearnedFact(), addThreadMessage(), approvedFacts(), claimMessage(), claimTicket(), closeTicket(), countRecentRequests(), createTicket() (+58 more)

### Community 3 - "handlers.js"
Cohesion: 0.15
Nodes (23): { config }, context, db, DOWN_REACTIONS, findImage(), guides, handleImage(), isDirectMessage() (+15 more)

### Community 4 - "lookup.js"
Cohesion: 0.20
Nodes (13): answer, answerOrChat(), cache, cacheHit(), dateFallback(), db, firecrawl, knowledge (+5 more)

### Community 5 - "learn.js"
Cohesion: 0.13
Nodes (15): approve(), cache, captureFromReply(), { config }, db, forget(), forgetByStatus(), forgetRange() (+7 more)

### Community 6 - "api.js"
Cohesion: 0.05
Nodes (22): answer, cache, elapsedMs(), intent, knowledge, probe(), retrieve, answer (+14 more)

### Community 7 - "knowledge.js"
Cohesion: 0.08
Nodes (35): annotateHeadingAnchors(), APP_ROOT, axios, buildCorpus(), cache, corpusBuiltOnMap, corpusCacheMap, faqQuestions() (+27 more)

### Community 8 - "guides.js"
Cohesion: 0.11
Nodes (29): advanceGuideByReaction(), advanceToNextStep(), answer, answerStuckQuestion(), classifierPrompt(), classifyStepReply(), { config }, continueGuide() (+21 more)

### Community 9 - "cache.js"
Cohesion: 0.18
Nodes (13): cachedCount(), cacheRow(), crypto, db, get(), getCachedAnswer(), isVolatile(), keyFor() (+5 more)

### Community 10 - "link.js"
Cohesion: 0.23
Nodes (10): fetchUrlContent(), http, https, isBlockedHost(), isPrivateOrLoopbackIp(), knowledge, log, net (+2 more)

### Community 11 - "serve.js"
Cohesion: 0.12
Nodes (25): api, auth, broadcastSSE(), fs, handleApi(), handleAuth(), handleRequest(), handleScreenshots() (+17 more)

### Community 12 - "app.js"
Cohesion: 0.18
Nodes (28): api(), appendFeed(), askBtn, askInput, askResult, askTrace, connectSSE(), doAsk() (+20 more)

### Community 13 - "report.js"
Cohesion: 0.10
Nodes (32): answer, answeredFrom(), classifyGaps(), collect(), { config }, { coverageStats, relativeTime }, db, delta() (+24 more)

### Community 14 - "config.js"
Cohesion: 0.10
Nodes (24): adminUserIds, collectHcaiKeys(), collectZenKeys(), coolingUntil, faqChannels, hcaiApiKeys, hcaiCoolingUntil, intentBaseUrl (+16 more)

### Community 15 - "Visual Tutorial System for Pixie"
Cohesion: 0.07
Nodes (27): Adding New Visual Guides, Adding/Updating Screenshots, Architecture, Backwards Compatibility, Code Flow, Credits, Current Status, Environment Variables (+19 more)

### Community 16 - "Pixie"
Cohesion: 0.09
Nodes (21): App Home, As a service, Deep links in replies, Environment Variables, Feedback and docs gaps, How it works, How pixie answers, Intent classifier (+13 more)

### Community 17 - "package.json"
Cohesion: 0.08
Nodes (25): axios, dotenv, author, dependencies, axios, dotenv, sharp, @slack/bolt (+17 more)

### Community 18 - "programs.js"
Cohesion: 0.11
Nodes (27): all(), { config }, db, forChannel(), fs, get(), helpChannelName(), invalidate() (+19 more)

### Community 19 - "program.js"
Cohesion: 0.15
Nodes (20): buildNamesRegexPattern(), buildTimingPattern(), corpusSection(), describeEntry(), describeWhen(), directAnswer(), escapeRegex(), extractMilestones() (+12 more)

### Community 20 - "auth.js"
Cohesion: 0.15
Nodes (15): crypto, getSession(), handleCallback(), { isAdmin }, log, parseCookies(), requireAdmin(), requireSession() (+7 more)

### Community 21 - "retrieve.js"
Cohesion: 0.15
Nodes (15): buildIndex(), chunkSection(), chunkSections(), log, score(), selectChunks(), selectContext(), STOPWORDS (+7 more)

### Community 22 - "llm.js"
Cohesion: 0.08
Nodes (29): assert, db, guides, llm, { test, before, after }, axios, backoffMs(), completeAttempts() (+21 more)

### Community 23 - "log.js"
Cohesion: 0.07
Nodes (23): { config }, debug(), error(), format(), info(), notify(), subscribers, warn() (+15 more)

### Community 24 - "Test Questions for Intent Classifier"
Cohesion: 0.18
Nodes (10): Casual Statements (CASUAL_CHAT), Documentation & Resources (HELP_NEEDED), Game Mechanics (HELP_NEEDED), General Pixl Questions (HELP_NEEDED), Joining & Getting Started (HELP_NEEDED), Prizes & Rewards (HELP_NEEDED), Projects & Shipping (HELP_NEEDED), Technical Setup (HELP_NEEDED) (+2 more)

### Community 25 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 26 - "report.test.js"
Cohesion: 0.18
Nodes (7): assert, { config }, db, learn, llm, report, { test }

### Community 27 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 28 - "respond.js"
Cohesion: 0.14
Nodes (21): buildChatContext(), buildContextPrompt(), { config }, context, db, formatGuideText(), guides, handleActiveGuide() (+13 more)

### Community 29 - "identity.test.js"
Cohesion: 0.29
Nodes (4): DEFAULT_IDENTITY, assert, identity, { test }

### Community 30 - "home.js"
Cohesion: 0.16
Nodes (18): statsCommand(), cache, coverageBlocks(), db, guides, homeBlocks(), { isAdmin }, knowledge (+10 more)

### Community 31 - "respond.test.js"
Cohesion: 0.15
Nodes (10): answer, assert, cache, { config }, db, intent, link, llm (+2 more)

### Community 32 - "home.test.js"
Cohesion: 0.17
Nodes (9): adminOnlyShortcut(), isAdmin(), reviewBlocks(), assert, { config }, db, learn, { reviewBlocks, reviewAction, coverageBlocks, homeBlocks } (+1 more)

### Community 33 - "Real Screenshots Captured ✓"
Cohesion: 0.20
Nodes (9): Captured Screenshots, customize-character (3 screenshots), Next Steps, Optimization, Real Screenshots Captured ✓, shop-purchase (4 screenshots), Source, submit-project (5 screenshots) (+1 more)

### Community 34 - "stats.js"
Cohesion: 0.22
Nodes (8): pendingCommand(), sourcesCommand(), cache, { config }, db, relativeTime(), knowledgeInfo(), queueList()

### Community 35 - "commands.test.js"
Cohesion: 0.25
Nodes (6): assert, commands, { config }, learn, teachThread, { test }

### Community 36 - "teachThread.js"
Cohesion: 0.29
Nodes (7): buildTranscript(), { config }, learn, llm, { MAX_TOKENS }, summarizeThread(), SYSTEM_PROMPT

### Community 37 - "Screenshot Replacement Checklist"
Cohesion: 0.25
Nodes (7): customize-character (3 screenshots needed), Notes, Screenshot Guidelines, Screenshot Replacement Checklist, shop-purchase (4 screenshots needed), submit-project (5 screenshots needed), Testing

### Community 38 - "generate_screenshots.js"
Cohesion: 0.32
Nodes (7): { firefox }, fs, main(), path, saveWebp(), SCREENSHOTS_DIR, sharp

### Community 39 - "optimize-screenshot.js"
Cohesion: 0.25
Nodes (7): args, fs, outputDir, outputDirOnly, outputPath, path, sharp

### Community 40 - "teachThread.test.js"
Cohesion: 0.33
Nodes (4): assert, llm, teachThread, { test, before, after }

### Community 41 - "link.test.js"
Cohesion: 0.50
Nodes (3): assert, link, { test }

### Community 44 - "index.js"
Cohesion: 0.14
Nodes (19): { App }, commands, { config, validate, resolveBotUserId }, db, guides, handlers, knowledge, log (+11 more)

### Community 45 - "answer.js"
Cohesion: 0.25
Nodes (15): answerOrChatPrompt(), answerRequest(), { config }, getAnswerOrChat(), getAnswerOrChatStream(), getGroundedAnswer(), linkifyHelpChannel(), llm (+7 more)

### Community 46 - "context.js"
Cohesion: 0.13
Nodes (9): db, deriveTopic(), log, STOPWORDS, assert, context, db, { test } (+1 more)

### Community 47 - "chat.js"
Cohesion: 0.20
Nodes (12): pixlGuardrail(), VOICE, chatSystemPrompt(), { complete }, { config }, debugSystemPrompt(), getChatReply(), looksLikeQuestion() (+4 more)

### Community 48 - "warm.js"
Cohesion: 0.24
Nodes (11): cache, db, faqQuestions(), knowledge, log, lookup, refreshStale(), sleep() (+3 more)

### Community 49 - "handlers.test.js"
Cohesion: 0.18
Nodes (9): assert, { config }, context, db, handlers, learn, respond, { test } (+1 more)

### Community 50 - "warm.test.js"
Cohesion: 0.20
Nodes (7): assert, cache, db, knowledge, lookup, { test }, warm

### Community 51 - "firecrawl.js"
Cohesion: 0.28
Nodes (7): axios, { config }, getApiKey(), log, scrapeCache, scrapeUrl(), searchWeb()

### Community 52 - "vision.js"
Cohesion: 0.28
Nodes (8): analyzeImage(), axios, { complete }, { config }, fetchSlackImageAsDataUri(), log, { normalizeEmoji }, visionSystemPrompt()

### Community 53 - "answer.test.js"
Cohesion: 0.29
Nodes (5): answer, assert, { config }, llm, { test }

### Community 54 - "config"
Cohesion: 0.29
Nodes (6): config, assert, axios, { config }, firecrawl, { test, before, after, beforeEach }

### Community 55 - "learn.test.js"
Cohesion: 0.29
Nodes (6): assert, { config }, db, learn, llm, { test, before, after }

### Community 56 - "cache.test.js"
Cohesion: 0.40
Nodes (4): assert, cache, db, { test }

### Community 57 - "db.test.js"
Cohesion: 0.40
Nodes (4): assert, cache, db, { test }

### Community 58 - "intent.test.js"
Cohesion: 0.50
Nodes (3): assert, intent, { test }

## Knowledge Gaps
- **455 isolated node(s):** `$schema`, `builder`, `dockerfilePath`, `startCommand`, `restartPolicyType` (+450 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `config` connect `config` to `intent.js`, `commands.js`, `handlers.js`, `learn.js`, `api.js`, `guides.js`, `report.js`, `config.js`, `programs.js`, `log.js`, `report.test.js`, `respond.js`, `respond.test.js`, `home.test.js`, `stats.js`, `commands.test.js`, `teachThread.js`, `index.js`, `answer.js`, `chat.js`, `handlers.test.js`, `firecrawl.js`, `vision.js`, `answer.test.js`, `learn.test.js`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `isAdmin()` connect `home.test.js` to `commands.js`, `auth.js`, `config.js`, `home.js`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `looksLikeCode()` connect `intent.js` to `answer.js`, `chat.js`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Are the 15 inferred relationships involving `register()` (e.g. with `commands.js` and `approveCommand()`) actually correct?**
  _`register()` has 15 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `builder`, `dockerfilePath` to the rest of the system?**
  _455 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `commands.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0989247311827957 - nodes in this community are weakly interconnected._
- **Should `db.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06649616368286446 - nodes in this community are weakly interconnected._