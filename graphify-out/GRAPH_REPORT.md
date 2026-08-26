# Graph Report - pixie  (2026-08-26)

## Corpus Check
- 87 files · ~158,756 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1141 nodes · 1985 edges · 54 communities (52 shown, 2 thin omitted)
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 406 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7876e42a`
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
- reply.js
- Test Questions for Intent Classifier
- deploy
- index.js
- deploy
- respond.js
- identity.js
- home.js
- respond.test.js
- home.test.js
- Real Screenshots Captured ✓
- relativeTime
- commands.test.js
- handlers.test.js
- Screenshot Replacement Checklist
- generate_screenshots.js
- optimize-screenshot.js
- log.js
- context.js
- probe.js
- optimize-screenshots.js
- stats.js
- probe.test.js
- channelsList
- answer.test.js
- config
- learn.test.js
- context.test.js
- rateLimit.js
- teachThread.js

## God Nodes (most connected - your core abstractions)
1. `handle()` - 61 edges
2. `now()` - 33 edges
3. `config` - 29 edges
4. `register()` - 18 edges
5. `directAnswer()` - 16 edges
6. `api()` - 15 edges
7. `relativeTime()` - 13 edges
8. `esc()` - 13 edges
9. `init()` - 11 edges
10. `isAdmin()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `startBot()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `runAskCli()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `startBot()` --calls--> `resolveBotUserId()`  [EXTRACTED]
  index.js → lib/config.js
- `streamCompletion()` --indirect_call--> `delta()`  [INFERRED]
  lib/llm.js → lib/report.js
- `looksLikeHelpRequest()` --calls--> `looksLikeCode()`  [EXTRACTED]
  lib/intent.js → lib/answer.js

## Import Cycles
- None detected.

## Communities (54 total, 2 thin omitted)

### Community 0 - "llm.test.js"
Cohesion: 0.17
Nodes (8): assert, axios, getReader(), llm, REQUEST, sse(), STANDBY, { test }

### Community 1 - "commands.js"
Cohesion: 0.09
Nodes (33): adminOnly(), answer, approveCommand(), askCommand(), { config, isAdmin }, context, db, forgetCommand() (+25 more)

### Community 2 - "db.js"
Cohesion: 0.06
Nodes (71): addLearnedFact(), addThreadMessage(), approvedFacts(), claimMessage(), claimTicket(), closeTicket(), countRecentRequests(), createTicket() (+63 more)

### Community 3 - "handlers.js"
Cohesion: 0.07
Nodes (45): { config }, context, db, DOWN_REACTIONS, findImage(), guides, handleImage(), isDirectMessage() (+37 more)

### Community 4 - "lookup.js"
Cohesion: 0.06
Nodes (41): answer, answerOrChat(), cache, cacheHit(), dateFallback(), db, firecrawl, idOf() (+33 more)

### Community 5 - "learn.js"
Cohesion: 0.13
Nodes (15): approve(), cache, captureFromReply(), { config }, db, forget(), forgetByStatus(), forgetRange() (+7 more)

### Community 6 - "api.js"
Cohesion: 0.06
Nodes (8): cache, { coverageStats, relativeTime }, db, knowledge, learn, { probe }, programs, report

### Community 7 - "knowledge.js"
Cohesion: 0.08
Nodes (41): annotateHeadingAnchors(), APP_ROOT, axios, buildCorpus(), cache, corpusBuiltOnMap, corpusCacheMap, docSlugFromFilename() (+33 more)

### Community 8 - "guides.js"
Cohesion: 0.11
Nodes (29): advanceGuideByReaction(), advanceToNextStep(), answer, answerStuckQuestion(), classifierPrompt(), classifyStepReply(), { config }, continueGuide() (+21 more)

### Community 9 - "cache.js"
Cohesion: 0.10
Nodes (21): cachedCount(), cacheRow(), crypto, db, get(), getCachedAnswer(), isVolatile(), keyFor() (+13 more)

### Community 10 - "shop.js"
Cohesion: 0.13
Nodes (39): ALIASES, amountAnswer(), applyAliases(), asksAboutPrice(), axios, corpusText(), current(), DEFAULT_ECONOMY (+31 more)

### Community 11 - "serve.js"
Cohesion: 0.12
Nodes (25): api, auth, broadcastSSE(), fs, handleApi(), handleAuth(), handleRequest(), handleScreenshots() (+17 more)

### Community 12 - "app.js"
Cohesion: 0.16
Nodes (32): allChannelsData, api(), appendFeed(), askBtn, askInput, askResult, askTrace, connectSSE() (+24 more)

### Community 13 - "report.js"
Cohesion: 0.07
Nodes (41): answer, answeredFrom(), classifyGaps(), collect(), { config }, { coverageStats, relativeTime }, db, delta() (+33 more)

### Community 14 - "config.js"
Cohesion: 0.10
Nodes (26): adminUserIds, collectHcaiKeys(), collectZenKeys(), coolingUntil, faqChannels, hcaiApiKeys, hcaiCoolingUntil, intentBaseUrl (+18 more)

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
Cohesion: 0.10
Nodes (30): addChannelToProgram(), all(), { config }, db, forChannel(), fs, get(), helpChannelName() (+22 more)

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
Cohesion: 0.06
Nodes (65): answerOrChatPrompt(), answerRequest(), { config }, getAnswerOrChat(), getAnswerOrChatStream(), getGroundedAnswer(), helpChannelRef(), linkifyHelpChannel() (+57 more)

### Community 23 - "reply.js"
Cohesion: 0.07
Nodes (24): { config }, dedash(), finalize(), knowledge, log, makeStreamWriter(), plainDashes(), plainDashesInBlocks() (+16 more)

### Community 24 - "Test Questions for Intent Classifier"
Cohesion: 0.18
Nodes (10): Casual Statements (CASUAL_CHAT), Documentation & Resources (HELP_NEEDED), Game Mechanics (HELP_NEEDED), General Pixl Questions (HELP_NEEDED), Joining & Getting Started (HELP_NEEDED), Prizes & Rewards (HELP_NEEDED), Projects & Shipping (HELP_NEEDED), Technical Setup (HELP_NEEDED) (+2 more)

### Community 25 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 26 - "index.js"
Cohesion: 0.15
Nodes (17): { App }, commands, { config, validate, resolveBotUserId }, db, guides, handlers, knowledge, log (+9 more)

### Community 27 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 28 - "respond.js"
Cohesion: 0.12
Nodes (26): ASKS_WHAT_THEY_MEAN, buildChatContext(), buildContextPrompt(), { config }, context, db, formatGuideText(), guides (+18 more)

### Community 29 - "identity.js"
Cohesion: 0.29
Nodes (6): corpusSection(), DEFAULT_IDENTITY, otherProgramNames(), assert, identity, { test }

### Community 30 - "home.js"
Cohesion: 0.13
Nodes (22): adminOnlyShortcut(), isAdmin(), cache, coverageBlocks(), db, guides, homeBlocks(), { isAdmin } (+14 more)

### Community 31 - "respond.test.js"
Cohesion: 0.08
Nodes (24): fetchUrlContent(), http, https, isBlockedHost(), isPrivateOrLoopbackIp(), knowledge, log, net (+16 more)

### Community 32 - "home.test.js"
Cohesion: 0.22
Nodes (6): assert, { config }, db, learn, { reviewBlocks, reviewAction, coverageBlocks, homeBlocks }, { test }

### Community 33 - "Real Screenshots Captured ✓"
Cohesion: 0.20
Nodes (9): Captured Screenshots, customize-character (3 screenshots), Next Steps, Optimization, Real Screenshots Captured ✓, shop-purchase (4 screenshots), Source, submit-project (5 screenshots) (+1 more)

### Community 34 - "relativeTime"
Cohesion: 0.40
Nodes (5): pendingCommand(), sourcesCommand(), relativeTime(), knowledgeInfo(), queueList()

### Community 35 - "commands.test.js"
Cohesion: 0.25
Nodes (6): assert, commands, { config }, learn, teachThread, { test }

### Community 36 - "handlers.test.js"
Cohesion: 0.18
Nodes (9): assert, { config }, context, db, handlers, learn, respond, { test } (+1 more)

### Community 37 - "Screenshot Replacement Checklist"
Cohesion: 0.25
Nodes (7): customize-character (3 screenshots needed), Notes, Screenshot Guidelines, Screenshot Replacement Checklist, shop-purchase (4 screenshots needed), submit-project (5 screenshots needed), Testing

### Community 38 - "generate_screenshots.js"
Cohesion: 0.32
Nodes (7): { firefox }, fs, main(), path, saveWebp(), SCREENSHOTS_DIR, sharp

### Community 39 - "optimize-screenshot.js"
Cohesion: 0.25
Nodes (7): args, fs, outputDir, outputDirOnly, outputPath, path, sharp

### Community 40 - "log.js"
Cohesion: 0.16
Nodes (15): axios, { config }, getApiKey(), log, scrapeCache, scrapeUrl(), searchWeb(), { config } (+7 more)

### Community 41 - "context.js"
Cohesion: 0.20
Nodes (5): db, deriveTopic(), log, STOPWORDS, updateUserHistory()

### Community 42 - "probe.js"
Cohesion: 0.25
Nodes (8): answer, cache, elapsedMs(), intent, knowledge, probe(), retrieve, handleAsk()

### Community 44 - "stats.js"
Cohesion: 0.33
Nodes (5): statsCommand(), cache, { config }, db, statsText()

### Community 46 - "probe.test.js"
Cohesion: 0.29
Nodes (6): answer, assert, db, intent, { probe }, { test, after }

### Community 47 - "channelsList"
Cohesion: 0.50
Nodes (4): channelAdd(), channelRemove(), channelsList(), channelToggle()

### Community 48 - "answer.test.js"
Cohesion: 0.29
Nodes (5): answer, assert, { config }, llm, { test }

### Community 49 - "config"
Cohesion: 0.29
Nodes (6): config, assert, axios, { config }, firecrawl, { test, before, after, beforeEach }

### Community 50 - "learn.test.js"
Cohesion: 0.29
Nodes (6): assert, { config }, db, learn, llm, { test, before, after }

### Community 51 - "context.test.js"
Cohesion: 0.40
Nodes (4): assert, context, db, { test }

### Community 55 - "teachThread.js"
Cohesion: 0.15
Nodes (11): buildTranscript(), { config }, learn, llm, { MAX_TOKENS }, summarizeThread(), SYSTEM_PROMPT, assert (+3 more)

## Knowledge Gaps
- **484 isolated node(s):** `$schema`, `builder`, `dockerfilePath`, `startCommand`, `restartPolicyType` (+479 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `config` connect `config` to `commands.js`, `handlers.js`, `learn.js`, `api.js`, `guides.js`, `report.js`, `config.js`, `programs.js`, `answer.js`, `reply.js`, `index.js`, `respond.js`, `respond.test.js`, `home.test.js`, `commands.test.js`, `handlers.test.js`, `log.js`, `stats.js`, `answer.test.js`, `learn.test.js`, `teachThread.js`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `complete()` connect `answer.js` to `handlers.js`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Why does `isAdmin()` connect `home.js` to `commands.js`, `auth.js`, `config.js`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Are the 15 inferred relationships involving `register()` (e.g. with `commands.js` and `approveCommand()`) actually correct?**
  _`register()` has 15 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `builder`, `dockerfilePath` to the rest of the system?**
  _484 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `commands.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08912655971479501 - nodes in this community are weakly interconnected._
- **Should `db.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06219918548685672 - nodes in this community are weakly interconnected._