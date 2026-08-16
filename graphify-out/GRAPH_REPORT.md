# Graph Report - pixie  (2026-08-04)

## Corpus Check
- 68 files · ~63,954 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 818 nodes · 1393 edges · 31 communities
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 285 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `32cae829`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- llm.js
- commands.js
- db.js
- respond.js
- log.js
- learn.js
- api.js
- knowledge.js
- guides.js
- cache.js
- respond.test.js
- serve.js
- app.js
- report.js
- config.js
- handlers.js
- Pixie
- package.json
- index.js
- program.js
- auth.js
- retrieve.js
- llm.test.js
- reply.js
- Test Questions for Intent Classifier
- deploy
- report.test.js
- deploy
- config
- identity.test.js
- learn.test.js

## God Nodes (most connected - your core abstractions)
1. `handle()` - 38 edges
2. `config` - 24 edges
3. `now()` - 22 edges
4. `register()` - 15 edges
5. `relativeTime()` - 13 edges
6. `api()` - 12 edges
7. `isAdmin()` - 10 edges
8. `Pixie` - 10 edges
9. `Test Questions for Intent Classifier` - 10 edges
10. `normalizeEmoji()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `startBot()` --calls--> `resolveBotUserId()`  [EXTRACTED]
  index.js → lib/config.js
- `startBot()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `runAskCli()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js
- `streamCompletion()` --indirect_call--> `delta()`  [INFERRED]
  lib/llm.js → lib/report.js
- `requireAdmin()` --calls--> `isAdmin()`  [EXTRACTED]
  lib/web/auth.js → lib/config.js

## Import Cycles
- None detected.

## Communities (31 total, 0 thin omitted)

### Community 0 - "llm.js"
Cohesion: 0.05
Nodes (64): answerOrChatPrompt(), answerRequest(), { config }, getAnswerOrChat(), getAnswerOrChatStream(), getGroundedAnswer(), linkifyHelpChannel(), llm (+56 more)

### Community 1 - "commands.js"
Cohesion: 0.05
Nodes (60): adminOnly(), adminOnlyShortcut(), answer, approveCommand(), askCommand(), { config, isAdmin }, db, forgetCommand() (+52 more)

### Community 2 - "db.js"
Cohesion: 0.09
Nodes (48): addLearnedFact(), addThreadMessage(), approvedFacts(), claimMessage(), countRecentRequests(), { Database }, DEFAULT_PATH, deleteGuide() (+40 more)

### Community 3 - "respond.js"
Cohesion: 0.05
Nodes (37): db, deriveTopic(), log, STOPWORDS, assert, context, db, { test } (+29 more)

### Community 4 - "log.js"
Cohesion: 0.06
Nodes (38): { config }, debug(), error(), format(), info(), notify(), subscribers, warn() (+30 more)

### Community 5 - "learn.js"
Cohesion: 0.06
Nodes (31): assert, commands, { config }, learn, teachThread, { test }, approve(), cache (+23 more)

### Community 6 - "api.js"
Cohesion: 0.06
Nodes (21): answer, cache, elapsedMs(), intent, knowledge, probe(), retrieve, answer (+13 more)

### Community 7 - "knowledge.js"
Cohesion: 0.09
Nodes (32): annotateHeadingAnchors(), APP_ROOT, axios, buildCorpus(), cache, faqQuestions(), fetchSourceText(), fs (+24 more)

### Community 8 - "guides.js"
Cohesion: 0.10
Nodes (27): classifierPrompt(), classifyStepReply(), { config }, continueGuide(), db, detectGuideByKeyword(), detectGuideByModel(), detectGuideIntent() (+19 more)

### Community 9 - "cache.js"
Cohesion: 0.10
Nodes (21): cachedCount(), cacheRow(), crypto, db, get(), getCachedAnswer(), isVolatile(), keyFor() (+13 more)

### Community 10 - "respond.test.js"
Cohesion: 0.08
Nodes (22): fetchUrlContent(), http, https, isBlockedHost(), isPrivateOrLoopbackIp(), knowledge, log, net (+14 more)

### Community 11 - "serve.js"
Cohesion: 0.12
Nodes (24): api, auth, broadcastSSE(), fs, handleApi(), handleAuth(), handleRequest(), handleStatic() (+16 more)

### Community 12 - "app.js"
Cohesion: 0.18
Nodes (26): api(), appendFeed(), askBtn, askInput, askResult, askTrace, connectSSE(), doAsk() (+18 more)

### Community 13 - "report.js"
Cohesion: 0.14
Nodes (23): answeredFrom(), classifyGaps(), collect(), { config }, { coverageStats, relativeTime }, db, delta(), isReportDue() (+15 more)

### Community 14 - "config.js"
Cohesion: 0.12
Nodes (19): adminUserIds, answerBaseUrl, collectZenKeys(), coolingUntil, faqChannels, intentBaseUrl, MODEL_VARS, nextZenApiKey() (+11 more)

### Community 15 - "handlers.js"
Cohesion: 0.17
Nodes (21): { config }, context, { couldNeedHelp }, db, DOWN_REACTIONS, findImage(), handleImage(), isDirectMessage() (+13 more)

### Community 16 - "Pixie"
Cohesion: 0.09
Nodes (21): App Home, As a service, Deep links in replies, Environment Variables, Feedback and docs gaps, How it works, How pixie answers, Intent classifier (+13 more)

### Community 17 - "package.json"
Cohesion: 0.10
Nodes (20): axios, dotenv, author, dependencies, axios, dotenv, @slack/bolt, description (+12 more)

### Community 18 - "index.js"
Cohesion: 0.14
Nodes (19): { App }, commands, { config, validate, resolveBotUserId }, db, guides, handlers, knowledge, log (+11 more)

### Community 19 - "program.js"
Cohesion: 0.16
Nodes (16): corpusSection(), describeEntry(), describeWhen(), directAnswer(), formatDate(), fs, isTimingQuestion(), log (+8 more)

### Community 20 - "auth.js"
Cohesion: 0.15
Nodes (15): crypto, getSession(), handleCallback(), { isAdmin }, log, parseCookies(), requireAdmin(), requireSession() (+7 more)

### Community 21 - "retrieve.js"
Cohesion: 0.15
Nodes (15): buildIndex(), chunkSection(), chunkSections(), log, score(), selectChunks(), selectContext(), STOPWORDS (+7 more)

### Community 22 - "llm.test.js"
Cohesion: 0.17
Nodes (8): assert, axios, getReader(), llm, REQUEST, sse(), STANDBY, { test }

### Community 23 - "reply.js"
Cohesion: 0.17
Nodes (3): { config }, knowledge, log

### Community 24 - "Test Questions for Intent Classifier"
Cohesion: 0.18
Nodes (10): Casual Statements (CASUAL_CHAT), Documentation & Resources (HELP_NEEDED), Game Mechanics (HELP_NEEDED), General Pixl Questions (HELP_NEEDED), Joining & Getting Started (HELP_NEEDED), Prizes & Rewards (HELP_NEEDED), Projects & Shipping (HELP_NEEDED), Technical Setup (HELP_NEEDED) (+2 more)

### Community 25 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 26 - "report.test.js"
Cohesion: 0.20
Nodes (6): assert, { config }, db, llm, report, { test }

### Community 27 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 28 - "config"
Cohesion: 0.25
Nodes (6): answer, assert, { config }, llm, { test }, config

### Community 29 - "identity.test.js"
Cohesion: 0.29
Nodes (4): IDENTITY, assert, identity, { test }

### Community 30 - "learn.test.js"
Cohesion: 0.29
Nodes (6): assert, { config }, db, learn, llm, { test }

## Knowledge Gaps
- **355 isolated node(s):** `$schema`, `builder`, `dockerfilePath`, `startCommand`, `restartPolicyType` (+350 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `config` connect `config` to `llm.js`, `commands.js`, `respond.js`, `log.js`, `learn.js`, `api.js`, `guides.js`, `report.js`, `config.js`, `handlers.js`, `index.js`, `reply.js`, `report.test.js`, `learn.test.js`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `isAdmin()` connect `commands.js` to `auth.js`, `config.js`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Why does `relativeTime()` connect `commands.js` to `report.js`, `api.js`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Are the 13 inferred relationships involving `register()` (e.g. with `commands.js` and `approveCommand()`) actually correct?**
  _`register()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `builder`, `dockerfilePath` to the rest of the system?**
  _355 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `llm.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05432595573440644 - nodes in this community are weakly interconnected._
- **Should `commands.js` be split into smaller, more focused modules?**
  _Cohesion score 0.053613053613053616 - nodes in this community are weakly interconnected._