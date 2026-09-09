# Graph Report - pixie  (2026-09-09)

## Corpus Check
- 261 files · ~348,072 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3019 nodes · 5545 edges · 186 communities (173 shown, 13 thin omitted)
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 739 edges (avg confidence: 0.51)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `133f1bc6`
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
- session.ts
- lib/probe.js
- answer.js
- reply.js
- Test Questions for Intent Classifier
- deploy
- validator.js
- deploy
- respond.js
- brand.js
- home.js
- link.js
- knowledge/page.tsx
- Real Screenshots Captured ✓
- pixiewizard — architecture plan
- commands.test.js
- firecrawl.js
- Screenshot Replacement Checklist
- generate_screenshots.js
- optimize-screenshot.js
- now
- llm.js
- index.js
- optimize-screenshots.js
- stats.js
- requireProgramMembership
- intent.js
- answer.test.js
- respond.test.js
- config
- 1. 📚 Taught Facts & Core Rules
- chat.js
- Handoff checklist — pixie to a new Railway account
- migrate-railway.mjs
- smoke-test.js
- Path A — through the wizard
- vision.js
- intent.test.js
- test-diff.mjs
- scripts/package.json
- programClaim.ts
- hostedActions.ts
- relatedThreads.js
- eligibility.test.js
- probe.js
- helperRoute.js
- gapClusters.js
- normalizeQuestion
- sweep
- schema.js
- devDependencies
- incidents.js
- pixieCore.ts
- types.ts
- macros.js
- report.test.js
- rateLimit.js
- compilerOptions
- radar.js
- tickets.js
- [id]/page.tsx
- retrieve.js
- copilot.js
- tickets.test.js
- sumThread.js
- sla.js
- slackMessages.test.js
- context.js
- programHealth.js
- hardwire-setup.mjs
- programHealth.test.js
- programAccess.ts
- liveShop.js
- needProgram
- resolutionMemory.js
- retention.js
- sourceGuard.js
- warm.js
- migrate-to-shared.js
- knowledge.test.js
- memKey
- multiTenantSecurity.test.js
- shared
- hardwire-verify.mjs
- audit.js
- calculator.test.js
- handlers.test.js
- rankDuplicateCandidates
- log.js
- platformOps.test.js
- routing.test.js
- supportAnalytics.js
- YSWS Project Submission Guidelines: AI Policy
- jobLease.js
- fetchSourceText
- slackMessages.js
- SidebarNav.tsx
- teachThread.js
- tenancy.test.js
- warm.test.js
- ticketActorAllowed
- normalizeEmoji
- #pixie-sandbox Staging Runbook
- calculator.js
- hosted.test.js
- cache.test.js
- platformFlow.test.js
- evaluateProgram
- needProgramActor
- Pixie Wizard Design System
- retrieve.test.js
- radar.test.js
- Pixie Security Model
- Pixie Hosted Deployment
- backToBasics.test.js
- lookup.test.js
- workspace.js
- api.test.js
- onMessage
- hardwire-move-help.mjs
- jobLease.test.js
- programs.test.js
- liveShop.test.js
- routing.js
- shop.test.js
- radar/page.tsx
- Dedicated → Shared Migration
- app/layout.tsx
- Pixie Wizard — shared control plane
- fetchUrlSource
- db.test.js
- forChannel
- row
- handleTeachRequest
- ensureSchema
- assertValid
- detectStaleTickets
- pixie-wizard/railway.json
- hardwire-isolate-legacy-facts.mjs
- channelsList
- macroScope
- decideEscalationSpike
- decideReopenSpike
- detectFaqClusters
- StepShell.tsx
- hostedNoSecrets.test.ts
- vercel.json
- createTicket
- setTicketTriage
- app/page.tsx
- next.config.ts
- postcss.config.mjs
- retention.test.js
- resolutionMemory.test.js
- boostedValue
- context.test.js
- validator.test.js
- hardwire-inspect.mjs
- chunkSection

## God Nodes (most connected - your core abstractions)
1. `handle()` - 96 edges
2. `now()` - 54 edges
3. `config` - 37 edges
4. `request()` - 37 edges
5. `requireProgramMembership()` - 28 edges
6. `register()` - 22 edges
7. `isAdmin()` - 20 edges
8. `send()` - 20 edges
9. `linkedSlackSession()` - 19 edges
10. `respond()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `sourceSections()` --indirect_call--> `src()`  [INFERRED]
  lib/knowledge.js → pixie-wizard/lib/wizardControlPlane.test.ts
- `loadSources()` --indirect_call--> `src()`  [INFERRED]
  lib/knowledge.js → pixie-wizard/lib/wizardControlPlane.test.ts
- `dropSharedLines()` --indirect_call--> `line()`  [INFERRED]
  lib/knowledge.js → pixie-wizard/scripts/hardwire-setup.mjs
- `startBot()` --calls--> `resolveBotUserId()`  [EXTRACTED]
  index.js → lib/config.js
- `startBot()` --calls--> `validate()`  [EXTRACTED]
  index.js → lib/config.js

## Import Cycles
- None detected.

## Communities (186 total, 13 thin omitted)

### Community 0 - "llm.test.js"
Cohesion: 0.17
Nodes (8): assert, axios, getReader(), llm, REQUEST, sse(), STANDBY, { test }

### Community 1 - "commands.js"
Cohesion: 0.07
Nodes (44): adminOnly(), adminOnlyShortcut(), answer, approveCommand(), askCommand(), brand, calcCommand(), checkCommand() (+36 more)

### Community 2 - "db.js"
Cohesion: 0.06
Nodes (62): addTicketEvent(), addTicketNote(), approvedFacts(), candidateForTicket(), claimTicket(), clearTakeover(), countRecentRequests(), { Database } (+54 more)

### Community 3 - "handlers.js"
Cohesion: 0.09
Nodes (28): brand, { config, isAdmin }, context, db, DELETE_REACTIONS, DOWN_REACTIONS, guides, learn (+20 more)

### Community 4 - "lookup.js"
Cohesion: 0.11
Nodes (28): answer, answerOrChat(), cache, cacheHit(), calculator, calculatorAnswer(), dateFallback(), db (+20 more)

### Community 5 - "learn.js"
Cohesion: 0.12
Nodes (17): approve(), cache, captureFromThread(), { config }, db, forget(), forgetByStatus(), forgetRange() (+9 more)

### Community 6 - "api.js"
Cohesion: 0.05
Nodes (15): cache, CHANNEL_KINDS, { coverageStats, relativeTime }, db, internalProgramSync(), knowledge, learn, log (+7 more)

### Community 7 - "knowledge.js"
Cohesion: 0.08
Nodes (31): answerCache, APP_ROOT, axios, buildCorpus(), cache, corpusBuiltOnMap, corpusCacheMap, db (+23 more)

### Community 8 - "guides.js"
Cohesion: 0.07
Nodes (39): advanceGuideByReaction(), advanceToNextStep(), answer, answerStuckQuestion(), availableFor(), classifierPrompt(), classifyStepReply(), { config } (+31 more)

### Community 9 - "cache.js"
Cohesion: 0.18
Nodes (13): cachedCount(), cacheRow(), crypto, db, get(), getCachedAnswer(), isVolatile(), keyFor() (+5 more)

### Community 10 - "shop.js"
Cohesion: 0.13
Nodes (40): ALIASES, amountAnswer(), answerForSingleItem(), applyAliases(), asksAboutPrice(), axios, corpusText(), current() (+32 more)

### Community 11 - "serve.js"
Cohesion: 0.05
Nodes (55): crypto, getSession(), handleCallback(), { isAdmin }, isAdminSession(), log, parseCookies(), requireAdmin() (+47 more)

### Community 12 - "app.js"
Cohesion: 0.14
Nodes (34): allChannelsData, api(), appendFeed(), askBtn, askInput, askResult, askTrace, connectSSE() (+26 more)

### Community 13 - "report.js"
Cohesion: 0.10
Nodes (34): answer, answeredFrom(), brand, classifyGaps(), collect(), { config }, { coverageStats, relativeTime }, db (+26 more)

### Community 14 - "config.js"
Cohesion: 0.08
Nodes (37): adminUserIds, collectGroqKeys(), collectHcaiKeys(), collectNumberedKeys(), collectZenKeys(), coolingUntil, faqChannels, groqApiKeys (+29 more)

### Community 15 - "Visual Tutorial System for Pixie"
Cohesion: 0.07
Nodes (27): Adding New Visual Guides, Adding/Updating Screenshots, Architecture, Backwards Compatibility, Code Flow, Credits, Current Status, Environment Variables (+19 more)

### Community 16 - "Pixie"
Cohesion: 0.06
Nodes (33): App Home, As a service, Deep links in replies, Deployment modes, Environment Variables, Feedback and docs gaps, How it works, How pixie answers (+25 more)

### Community 17 - "package.json"
Cohesion: 0.06
Nodes (31): axios, dotenv, author, dependencies, axios, dotenv, sharp, @slack/bolt (+23 more)

### Community 18 - "programs.js"
Cohesion: 0.12
Nodes (29): addChannelToProgram(), aiAnswersEnabled(), channelRow(), { config }, db, deploymentMode(), fs, get() (+21 more)

### Community 19 - "program.js"
Cohesion: 0.15
Nodes (22): buildNamesRegexPattern(), buildTimingPattern(), corpusSection(), describeEntry(), describeWhen(), directAnswer(), escapeRegex(), extractMilestones() (+14 more)

### Community 20 - "session.ts"
Cohesion: 0.17
Nodes (16): GET(), HackClubMeResponse, HackClubTokenResponse, GET(), GET(), clearSessionCookie(), decodeSession(), encodeSession() (+8 more)

### Community 21 - "lib/probe.js"
Cohesion: 0.13
Nodes (17): answer, cache, cacheVerdict(), citationCheck(), elapsedMs(), intent, knowledge, probe() (+9 more)

### Community 22 - "answer.js"
Cohesion: 0.18
Nodes (23): answerOrChatPrompt(), answerRequest(), brand, { config }, getGroundedAnswer(), helpChannelRef(), INSTRUCTION_ECHO_WEAK, linkifyHelpChannel() (+15 more)

### Community 23 - "reply.js"
Cohesion: 0.11
Nodes (22): { config }, decidePostSuppression(), dedash(), discardPlaceholder(), finalize(), flagForHumans(), knowledge, log (+14 more)

### Community 24 - "Test Questions for Intent Classifier"
Cohesion: 0.18
Nodes (10): Casual Statements (CASUAL_CHAT), Documentation & Resources (HELP_NEEDED), Game Mechanics (HELP_NEEDED), General Pixl Questions (HELP_NEEDED), Joining & Getting Started (HELP_NEEDED), Prizes & Rewards (HELP_NEEDED), Projects & Shipping (HELP_NEEDED), Technical Setup (HELP_NEEDED) (+2 more)

### Community 25 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 26 - "validator.js"
Cohesion: 0.23
Nodes (11): analyzeReadme(), assessReadiness(), axios, detectLicense(), fetchFirstHit(), fetchRawFile(), log, OPEN_SOURCE_LICENSES (+3 more)

### Community 27 - "deploy"
Cohesion: 0.20
Nodes (9): build, builder, dockerfilePath, deploy, numReplicas, restartPolicyMaxRetries, restartPolicyType, startCommand (+1 more)

### Community 28 - "respond.js"
Cohesion: 0.09
Nodes (38): ASKS_WHAT_THEY_MEAN, brand, buildChatContext(), buildContextPrompt(), { config }, context, db, decideStreamGate() (+30 more)

### Community 29 - "brand.js"
Cohesion: 0.07
Nodes (32): cmd(), envValue(), id(), name(), rawSlug(), slug(), assert, brand (+24 more)

### Community 30 - "home.js"
Cohesion: 0.09
Nodes (32): statsCommand(), allProgramNames(), brand, cache, coverageBlocks(), db, divider(), guides (+24 more)

### Community 31 - "link.js"
Cohesion: 0.15
Nodes (16): blocked(), fetchUrlContent(), http, https, isBlockedHost(), isPrivateOrLoopbackIp(), knowledge, log (+8 more)

### Community 32 - "knowledge/page.tsx"
Cohesion: 0.10
Nodes (19): Section(), ChannelChangeForm(), ChannelsSection(), Candidate, hostname(), KnowledgePage(), SOURCE_KIND, SettingsPage() (+11 more)

### Community 33 - "Real Screenshots Captured ✓"
Cohesion: 0.20
Nodes (9): Captured Screenshots, customize-character (3 screenshots), Next Steps, Optimization, Real Screenshots Captured ✓, shop-purchase (4 screenshots), Source, submit-project (5 screenshots) (+1 more)

### Community 34 - "pixiewizard — architecture plan"
Cohesion: 0.08
Nodes (24): 0. The blocking findings, first, 10. Open questions, 11. What has been built, 1. What already works and is worth keeping, 2. Vocabulary, 3. The wizard, 4.1 One slug drives every name, 4.2 User-facing copy (+16 more)

### Community 35 - "commands.test.js"
Cohesion: 0.25
Nodes (6): assert, commands, { config }, learn, teachThread, { test }

### Community 36 - "firecrawl.js"
Cohesion: 0.27
Nodes (11): authHeaders(), axios, { config }, getApiKey(), isCreditsExhausted(), log, markCreditsExhausted(), noteFailure() (+3 more)

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
Cohesion: 0.05
Nodes (40): addLearnedFact(), addThreadMessage(), assignTicket(), claimMessage(), claimProgramChannel(), closeTicket(), escalateTicketStatus(), gapForThread() (+32 more)

### Community 41 - "llm.js"
Cohesion: 0.19
Nodes (20): axios, backoffMs(), complete(), completeAttempts(), completeStream(), describeError(), https, isRetryableError() (+12 more)

### Community 42 - "index.js"
Cohesion: 0.14
Nodes (19): { App }, commands, { config, validate, resolveBotUserId }, db, guides, handlers, knowledge, log (+11 more)

### Community 44 - "stats.js"
Cohesion: 0.20
Nodes (9): pendingCommand(), sourcesCommand(), cache, { config }, db, relativeTime(), buildPulse(), knowledgeInfo() (+1 more)

### Community 46 - "requireProgramMembership"
Cohesion: 0.09
Nodes (41): CoreError(), EmptyState(), PageHeader(), StatusDot(), toneForStatus(), shortTime(), timeAgo(), userLabel() (+33 more)

### Community 47 - "intent.js"
Cohesion: 0.16
Nodes (18): buildUserPrompt(), classifyIntent(), { complete }, { config }, db, historyFor(), intentSystemPrompt(), log (+10 more)

### Community 48 - "answer.test.js"
Cohesion: 0.25
Nodes (6): answer, assert, { config }, llm, pixlProgram, { test }

### Community 49 - "respond.test.js"
Cohesion: 0.11
Nodes (11): answer, assert, cache, { config }, db, intent, link, llm (+3 more)

### Community 50 - "config"
Cohesion: 0.11
Nodes (16): config, assert, axios, { config }, firecrawl, { test, before, after, beforeEach }, assert, { config } (+8 more)

### Community 51 - "1. 📚 Taught Facts & Core Rules"
Cohesion: 0.12
Nodes (16): 1. 📚 Taught Facts & Core Rules, 2. 🔍 Document Gaps & Missed Questions, 3. 📊 Answered Messages Ledger (295 Total), 4. 👍 User Feedback & Satisfaction Ratings (39 Total), 5. 🏷️ User Topics Discovered (27 Total), Fact #1 — `how to get pixels and use them`, Fact #2 — `decrypt this`, Fact #3 — `there isn't any streak system in pixl right?` (+8 more)

### Community 52 - "chat.js"
Cohesion: 0.20
Nodes (13): looksLikeCode(), pixlGuardrail(), VOICE, chatSystemPrompt(), { complete }, { config }, debugSystemPrompt(), getChatReply() (+5 more)

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
Cohesion: 0.15
Nodes (14): analyzeImage(), axios, { complete }, { config }, fetchSlackImageAsDataUri(), log, needsSlackFetch(), { normalizeEmoji } (+6 more)

### Community 58 - "intent.test.js"
Cohesion: 0.25
Nodes (7): assert, intent, WHY: short HELP_ONLY inputs never reach the model — worth drops them,, WHY: "still nothing" repeats are recorded even when silent — the gate reads, WHY: short-input ticket signal stays non-ticketworthy — null falls back, WHY: fail-soft short gate — null keeps HELP_ONLY silent and keeps tickets, { test }

### Community 59 - "test-diff.mjs"
Cohesion: 0.47
Nodes (4): diff(), OPTIONAL, redactedForLog(), REQUIRED

### Community 61 - "programClaim.ts"
Cohesion: 0.08
Nodes (35): ActivationGuardInput, ActivationGuardResult, ChannelMembershipInfo, checkChannelIds(), CheckedChannels, iconError(), isValidSlackChannelId(), MembershipChecker (+27 more)

### Community 62 - "hostedActions.ts"
Cohesion: 0.17
Nodes (30): dynamic, GET(), ProgramSettingsForms(), activateHostedProgram(), flagOn(), hostedChannelsUpdate(), parseSources(), requireHostedSession() (+22 more)

### Community 63 - "relatedThreads.js"
Cohesion: 0.16
Nodes (13): buildSlackPermalink(), calculateTokenSimilarity(), db, findRelatedThread(), isSimpleLookupQuestion(), log, SIMPLE_LOOKUP_PATTERNS, STOP_WORDS (+5 more)

### Community 64 - "eligibility.test.js"
Cohesion: 0.05
Nodes (56): ackOnly(), botNamePattern(), DEFERRAL_RES, directMention(), escapeRegex(), explicitHumanRequest(), greetingOrNoise(), humanDirected() (+48 more)

### Community 65 - "probe.js"
Cohesion: 0.33
Nodes (5): db, full, probe, rej, top

### Community 66 - "helperRoute.js"
Cohesion: 0.05
Nodes (45): breadthBonus(), clampLimit(), db, getExpertise(), hasRoleBonus(), isRecentlyActive(), loadPenalty(), matchBonus() (+37 more)

### Community 67 - "gapClusters.js"
Cohesion: 0.06
Nodes (41): audit, clusterGaps(), clusterQuestions(), countEscalated(), db, despace(), fetchGapRows(), groupRowsByQuestion() (+33 more)

### Community 68 - "normalizeQuestion"
Cohesion: 0.50
Nodes (4): clearGapRejection(), normalizeQuestion(), recordGap(), recordGapRejection()

### Community 71 - "devDependencies"
Cohesion: 0.05
Nodes (39): clsx, next, pg, pg-mem, dependencies, clsx, next, pg (+31 more)

### Community 72 - "incidents.js"
Cohesion: 0.08
Nodes (34): affectedReports(), audit, buildQuestionIndex(), burstConfidence(), burstReason(), db, declareIncident(), defaultResolutionText() (+26 more)

### Community 73 - "pixieCore.ts"
Cohesion: 0.11
Nodes (40): IncidentControls(), IncidentDetectButton(), NotifyAffectedButton(), IncidentDetailSection(), RadarPage(), hostedIncidentAction(), hostedIncidentNotify(), call() (+32 more)

### Community 74 - "types.ts"
Cohesion: 0.07
Nodes (42): initialState, initialState, CandidateCard(), FaqProposeButton(), initialState, ProposeTicketForm(), initialState, MacroCreateForm() (+34 more)

### Community 75 - "macros.js"
Cohesion: 0.12
Nodes (28): actorRole(), applySendTransition(), audit, create(), db, get(), interpolate(), isUniqueConflict() (+20 more)

### Community 76 - "report.test.js"
Cohesion: 0.17
Nodes (9): reply, assert, { config }, db, learn, llm, report, { test } (+1 more)

### Community 77 - "rateLimit.js"
Cohesion: 0.22
Nodes (6): ALLOW, db, assert, db, rateLimit, { test }

### Community 78 - "compilerOptions"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 79 - "radar.js"
Cohesion: 0.08
Nodes (24): audit, crypto, db, gapClusters, incidents, OPEN_STATUSES, WHY: a ticket with an owner or a pending state still needs someone to act,, WHY: 12h is the nudge point (something is waiting), 24h is the escalation (+16 more)

### Community 80 - "tickets.js"
Cohesion: 0.06
Nodes (72): ackTicket(), addInternalNote(), aiAnsweredLabel(), assignTicket(), audit, authorize(), buildPublicAckBlocks(), buildTicketCardBlocks() (+64 more)

### Community 81 - "[id]/page.tsx"
Cohesion: 0.07
Nodes (41): BarList(), DashboardShell(), DataRow(), MetricCard(), MiniBar(), SignalRail(), Stage, StatusBadge() (+33 more)

### Community 82 - "retrieve.js"
Cohesion: 0.13
Nodes (21): AI_TERMS, baseScore(), bm25TermScore(), buildIndex(), CAD_TERMS, classifyQuery(), CONSEQUENCE_TERMS, DISCLOSURE_TERMS (+13 more)

### Community 83 - "copilot.js"
Cohesion: 0.06
Nodes (39): ask(), audit, checkSentence(), clampLimit(), completeHelper(), { config }, context, db (+31 more)

### Community 84 - "tickets.test.js"
Cohesion: 0.10
Nodes (20): assert, db, WHY: refreshed row must exist before the timeline write., WHY: legacy dashboard must share the control-plane outcome, never silent ok., WHY: malformed metadata must ack an error, never throw., WHY: second bot touch must not bump updated_at., WHY: unclaim is a demotion back to the queue, not back to waiting — the, WHY: reopen is unconditional outside the guarded set — even an open ticket (+12 more)

### Community 85 - "sumThread.js"
Cohesion: 0.17
Nodes (11): buildTranscript(), { config }, HELPER_SUMMARY_SYSTEM_PROMPT, llm, log, summarizeThreadForHelper(), assert, { config } (+3 more)

### Community 86 - "sla.js"
Cohesion: 0.15
Nodes (18): audit, checkProgram(), db, dueNotifications(), markNotified(), openTickets(), programThresholds(), WHY: a ticket with no owner, a parked ticket, and a ticket whose helper (+10 more)

### Community 87 - "slackMessages.test.js"
Cohesion: 0.11
Nodes (16): assert, WHY: the cap must be proven without waiting 30s in the suite., WHY: callers branch on the exact shape, so it is pinned not unified., WHY: pinned bug now fixed, so the pin asserts the fixed shape., WHY: pinned bug now fixed, so the pin asserts the fixed shape., WHY: a bad value must fall to backoff, not a Retry-After wait., WHY: pinned bug now fixed, so the pin asserts preservation., WHY: buttons must not chatter on failure; the one explain path is pinned here. (+8 more)

### Community 88 - "context.js"
Cohesion: 0.20
Nodes (7): db, deriveTopic(), log, roleForMessage(), seedFromSlack(), STOPWORDS, updateUserHistory()

### Community 89 - "programHealth.js"
Cohesion: 0.40
Nodes (9): clamp(), computeHealthScore(), db, knowledgeCoverageComponent(), OPEN_STATUSES, resolutionQualityComponent(), sourceHealthComponent(), supportAnalytics (+1 more)

### Community 90 - "hardwire-setup.mjs"
Cohesion: 0.13
Nodes (16): dropSharedLines(), APPLY, CHANNELS, CORE_HELPER_MEMBERS, CORE_PAYLOAD, CORE_TOKEN, CORE_URL, coreCall() (+8 more)

### Community 91 - "programHealth.test.js"
Cohesion: 0.29
Nodes (5): assert, db, health, programs, { test, before, after }

### Community 92 - "programAccess.ts"
Cohesion: 0.26
Nodes (12): ProgramsLayout(), ACTION_LABEL, ProgramsIndex(), RELATIONSHIP_LABEL, getHelperRow(), ProgramContext, ProgramMembership, relationshipFor() (+4 more)

### Community 93 - "liveShop.js"
Cohesion: 0.23
Nodes (12): answerForStreamTime(), answerForThreshold(), answerForUnlockable(), axios, directAnswer(), formatMinutes(), items, matchingItem() (+4 more)

### Community 94 - "needProgram"
Cohesion: 0.14
Nodes (14): internalAnalytics(), internalDuplicates(), internalGapClusters(), internalHealthScore(), internalIncidents(), internalKnowledgeCandidates(), internalMacrosList(), internalMacroSuggest() (+6 more)

### Community 95 - "resolutionMemory.js"
Cohesion: 0.19
Nodes (9): audit, { config }, db, existingCandidate(), extractCandidate(), learn, log, proposeFromTicket() (+1 more)

### Community 96 - "retention.js"
Cohesion: 0.24
Nodes (11): audit, countFor(), db, DEFAULTS, deleteTicketScope(), eligibleTicketIds(), policyFor(), preview() (+3 more)

### Community 97 - "sourceGuard.js"
Cohesion: 0.26
Nodes (11): axios, fetchSourceUrl(), hostnameLooksPrivate(), isPublicAddress(), isPublicV4(), isPublicV6(), net, assert (+3 more)

### Community 98 - "warm.js"
Cohesion: 0.24
Nodes (11): cache, db, faqQuestions(), knowledge, log, lookup, refreshStale(), sleep() (+3 more)

### Community 99 - "migrate-to-shared.js"
Cohesion: 0.31
Nodes (11): args(), collect(), count(), { Database }, fs, importData(), inspect(), main() (+3 more)

### Community 100 - "knowledge.test.js"
Cohesion: 0.28
Nodes (8): docSlugFromFilename(), docTitleFromFilename(), markdownFilesFromListing(), preserveLinks(), stripHtml(), assert, { test }, {
  textFromJsonFaq,
  stripHtml,
  preserveLinks,
  annotateHeadingAnchors,
  docTitleFromFilename,
  markdownFilesFromListing,
  dropSharedLines,
}

### Community 101 - "memKey"
Cohesion: 0.29
Nodes (12): faqQuestions(), invalidate(), loadSources(), memKey(), memText(), persistSourceText(), refreshCorpus(), refreshSource() (+4 more)

### Community 102 - "multiTenantSecurity.test.js"
Cohesion: 0.17
Nodes (11): answer, api, assert, cache, db, intent, learn, programs (+3 more)

### Community 103 - "shared"
Cohesion: 0.24
Nodes (12): all(), alt(), emptyShared(), legacyFallbackProgram(), loadConfiguredPrograms(), loadEnvPrograms(), loadFilePrograms(), normalizeProgram() (+4 more)

### Community 104 - "hardwire-verify.mjs"
Cohesion: 0.13
Nodes (13): ctx, db, helpers, helpProg, hset, hw, hwSources, knowledge (+5 more)

### Community 105 - "audit.js"
Cohesion: 0.22
Nodes (9): db, log, packEntityId(), packMetadata(), record(), assert, audit, db (+1 more)

### Community 106 - "calculator.test.js"
Cohesion: 0.33
Nodes (5): assert, calculator, DATA, ITEMS, { test }

### Community 107 - "handlers.test.js"
Cohesion: 0.18
Nodes (9): assert, { config }, context, db, handlers, learn, respond, { test } (+1 more)

### Community 108 - "rankDuplicateCandidates"
Cohesion: 0.18
Nodes (11): clampLimit(), fetchDuplicateRows(), findCooldownIncident(), isSimilar(), listIncidents(), matchActiveIncident(), pickBestIncident(), rankDuplicateCandidates() (+3 more)

### Community 109 - "log.js"
Cohesion: 0.29
Nodes (9): { config }, debug(), emit(), error(), format(), info(), notify(), subscribers (+1 more)

### Community 110 - "platformOps.test.js"
Cohesion: 0.18
Nodes (9): analytics, api, assert, db, lease, programs, retention, sla (+1 more)

### Community 111 - "routing.test.js"
Cohesion: 0.18
Nodes (7): assert, db, helperRoute, programs, routing, { test, before }, workspace

### Community 112 - "supportAnalytics.js"
Cohesion: 0.24
Nodes (10): db, lags(), median(), overview(), rate(), WHY: 48h without movement means the requester waited two full workdays;, WHY: gap trends only matter while fresh — a week of misses is a backlog,, WHY: rates round to 3 decimals — precise enough to graph, too coarse to (+2 more)

### Community 113 - "YSWS Project Submission Guidelines: AI Policy"
Cohesion: 0.20
Nodes (9): AI Usage Rules and 30% Limit, Consequences of Exceeding the AI Limit or Hiding AI, Disclosing AI Usage, Hardware and Firmware AI Rules, Hardware Project Requirements, Referral Codes and Expiration, Returned Submissions and Resubmissions, Software Project Requirements and README (+1 more)

### Community 114 - "jobLease.js"
Cohesion: 0.31
Nodes (9): acquire(), crypto, db, log, ownerId(), release(), runOnce(), tryInsert() (+1 more)

### Community 115 - "fetchSourceText"
Cohesion: 0.46
Nodes (8): fetchGithubDir(), fetchGithubFile(), fetchSourceText(), inlineText(), localFileText(), recordLink(), resolveLocalPath(), textFromJsonFaq()

### Community 116 - "slackMessages.js"
Cohesion: 0.31
Nodes (9): brandingFor(), headerCaseInsensitive(), isPermanentError(), log, WHY: Slack rejects non-http icons, so only http(s) survives branding., WHY: missing/empty must fall to backoff, not a 0ms retry storm., retryAfterMs(), sendProgramMessage() (+1 more)

### Community 117 - "SidebarNav.tsx"
Cohesion: 0.24
Nodes (9): isActive(), Item, MAIN, MobileNavLink(), MobileProgramNav(), NavLink(), ProgramNav(), SECONDARY (+1 more)

### Community 118 - "teachThread.js"
Cohesion: 0.15
Nodes (13): buildTranscript(), { config }, isDeclineLine(), learn, llm, { MAX_TOKENS }, parseModelReply(), summarizeThread() (+5 more)

### Community 119 - "tenancy.test.js"
Cohesion: 0.20
Nodes (8): api, assert, cache, db, knowledge, programs, { test, before, after }, TNT_BLOB

### Community 120 - "warm.test.js"
Cohesion: 0.20
Nodes (7): assert, cache, db, knowledge, lookup, { test }, warm

### Community 121 - "ticketActorAllowed"
Cohesion: 0.20
Nodes (10): internalIncidentAction(), internalIncidentNotify(), internalKnowledgeCandidateAction(), internalRadarAction(), internalTicketAction(), internalTicketNote(), internalTicketReply(), ticketActorAllowed() (+2 more)

### Community 122 - "normalizeEmoji"
Cohesion: 0.38
Nodes (11): getAnswerOrChat(), getAnswerOrChatStream(), INSTRUCTION_ECHO_STRONG, looksLikeInstructionEcho(), looksTruncated(), normalizeEmoji(), parseAnswerOrChat(), parseReply() (+3 more)

### Community 123 - "#pixie-sandbox Staging Runbook"
Cohesion: 0.20
Nodes (9): 1. Channels (manual, Slack), 2. Staging Core (Railway, manual), 3. Staging database (manual if no staging project exists), 4. Staging Wizard (Vercel or local, manual), 5. Activate the sandbox program, 6. Smoke test, 7. Teardown / rollback, #pixie-sandbox Staging Runbook (+1 more)

### Community 124 - "calculator.js"
Cohesion: 0.39
Nodes (8): answerForAffordable(), answerForPayout(), answerForTargetItem(), directAnswer(), isCalculatorQuery(), parseHours(), parseRe(), shop

### Community 125 - "hosted.test.js"
Cohesion: 0.22
Nodes (6): api, assert, db, programs, { test, before }, tickets

### Community 126 - "cache.test.js"
Cohesion: 0.40
Nodes (4): assert, cache, db, { test }

### Community 127 - "platformFlow.test.js"
Cohesion: 0.22
Nodes (8): api, assert, db, knowledge, lookup, programs, respond, { test, before, after }

### Community 128 - "evaluateProgram"
Cohesion: 0.22
Nodes (9): autoResolveMissing(), decideLowConfidenceFinding(), detectIncidentSignals(), detectLowConfidenceTopics(), detectSourceFailures(), evaluateProgram(), lowConfidenceSeverity(), sourceSeverity() (+1 more)

### Community 129 - "needProgramActor"
Cohesion: 0.22
Nodes (9): internalCopilot(), internalFaqPropose(), internalIncidentDetect(), internalKnowledgePropose(), internalMacroCreate(), internalRadarEvaluate(), internalRetentionPolicy(), internalRoutingExpertise() (+1 more)

### Community 130 - "Pixie Wizard Design System"
Cohesion: 0.22
Nodes (8): 1. Reference, 2. Tokens, 3. Layout, 4. Type and Motion, 5. Primitives, 6. Accessibility, 7. Accepted Differences, Pixie Wizard Design System

### Community 131 - "retrieve.test.js"
Cohesion: 0.12
Nodes (16): AI_POLICY_DOCS, aiIndex, assert, DOMAIN_DOCS, domainIndex, GENERATED, HIERARCHY_DOCS, hierarchyIndex (+8 more)

### Community 132 - "radar.test.js"
Cohesion: 0.25
Nodes (5): assert, db, programs, radar, { test, before, after }

### Community 133 - "Pixie Security Model"
Cohesion: 0.25
Nodes (7): Abuse, Permissions, Pixie Security Model, Secrets, Source ingestion (SSRF), Tenancy, What remains external

### Community 134 - "Pixie Hosted Deployment"
Cohesion: 0.29
Nodes (6): Environment (Core), Health, Pixie Hosted Deployment, Slack app scopes, What runs, Wizard env

### Community 135 - "backToBasics.test.js"
Cohesion: 0.18
Nodes (10): answer, assert, db, FLEET, identity, knowledge, llm, programs (+2 more)

### Community 136 - "lookup.test.js"
Cohesion: 0.29
Nodes (6): assert, db, lookup, PROG, programs, { test }

### Community 137 - "workspace.js"
Cohesion: 0.23
Nodes (10): channelKey(), { config }, configuredWorkspaceId(), scopedKey(), teamOfBody(), assert, { test }, workspace (+2 more)

### Community 138 - "api.test.js"
Cohesion: 0.29
Nodes (4): api, assert, db, { test, before, after }

### Community 139 - "onMessage"
Cohesion: 0.27
Nodes (11): checkEligibility(), findImage(), handleImage(), isDirectMessage(), mentionsPixieByName(), mentionsPixieDirectly(), onAppMention(), onMessage() (+3 more)

### Community 140 - "hardwire-move-help.mjs"
Cohesion: 0.24
Nodes (8): APPLY, core(), CORE_TOKEN, CORE_URL, DB_URL, main(), pool, q()

### Community 141 - "jobLease.test.js"
Cohesion: 0.33
Nodes (4): assert, db, lease, { test }

### Community 142 - "programs.test.js"
Cohesion: 0.33
Nodes (4): assert, db, programs, { test }

### Community 143 - "liveShop.test.js"
Cohesion: 0.50
Nodes (3): assert, shop, { test }

### Community 144 - "routing.js"
Cohesion: 0.33
Nodes (3): db, log, programs

### Community 145 - "shop.test.js"
Cohesion: 0.33
Nodes (5): assert, DATA, ITEMS, shop, { test }

### Community 146 - "radar/page.tsx"
Cohesion: 0.25
Nodes (9): HealthScore, linkFor(), RadarSignal, SEV_RANK, SEV_TONE, SignalRow(), RadarRefreshButton(), RadarSignalControls() (+1 more)

### Community 147 - "Dedicated → Shared Migration"
Cohesion: 0.33
Nodes (5): Dedicated → Shared Migration, Principle, Procedure, What migrates, Wizard trial rows

### Community 148 - "app/layout.tsx"
Cohesion: 0.29
Nodes (5): heading, metadata, mono, sans, viewport

### Community 149 - "Pixie Wizard — shared control plane"
Cohesion: 0.33
Nodes (5): Database, Hosted Pixie (default), Legacy dedicated path, Pixie Wizard — shared control plane, Trial lifecycle

### Community 150 - "fetchUrlSource"
Cohesion: 0.27
Nodes (10): annotateHeadingAnchors(), canonicalUrl(), crawlPrefixes(), fetchCrawlPage(), fetchUrlSource(), inScope(), linksFrom(), nextHops() (+2 more)

### Community 151 - "db.test.js"
Cohesion: 0.40
Nodes (4): assert, cache, db, { test }

### Community 152 - "forChannel"
Cohesion: 0.40
Nodes (5): claimedProgram(), forChannel(), hostedClaim(), isHelpChannel(), servesChannel()

### Community 153 - "row"
Cohesion: 0.70
Nodes (5): acknowledgeSignal(), programScoped(), resolveSignal(), row(), suppressSignal()

### Community 155 - "handleTeachRequest"
Cohesion: 0.40
Nodes (6): escapeRegex(), handleSumRequest(), handleTeachRequest(), stripTeachCommand(), sumPattern(), teachPattern()

### Community 156 - "ensureSchema"
Cohesion: 0.50
Nodes (4): close(), ensureSchema(), migrate(), open()

### Community 158 - "assertValid"
Cohesion: 0.50
Nodes (4): assertValid(), SEVERITIES, TYPES, upsertSignal()

### Community 159 - "detectStaleTickets"
Cohesion: 0.50
Nodes (4): decideStaleTickets(), detectStaleTickets(), fetchOpenTickets(), staleSeverity()

### Community 160 - "pixie-wizard/railway.json"
Cohesion: 0.29
Nodes (6): build, builder, deploy, restartPolicyMaxRetries, restartPolicyType, $schema

### Community 161 - "hardwire-isolate-legacy-facts.mjs"
Cohesion: 0.33
Nodes (5): APPLY, db, h, res, sampleNonPixl

### Community 162 - "channelsList"
Cohesion: 0.50
Nodes (4): channelAdd(), channelRemove(), channelsList(), channelToggle()

### Community 163 - "macroScope"
Cohesion: 0.50
Nodes (4): internalMacroDelete(), internalMacroSend(), internalMacroUpdate(), macroScope()

### Community 164 - "decideEscalationSpike"
Cohesion: 0.67
Nodes (3): decideEscalationSpike(), detectEscalationSpike(), escalationSeverity()

### Community 165 - "decideReopenSpike"
Cohesion: 0.67
Nodes (3): decideReopenSpike(), detectReopenSpike(), reopenSeverity()

### Community 166 - "detectFaqClusters"
Cohesion: 0.67
Nodes (3): detectFaqClusters(), faqFingerprint(), faqSeverity()

### Community 179 - "retention.test.js"
Cohesion: 0.33
Nodes (5): assert, db, programs, retention, { test, before, after }

### Community 180 - "resolutionMemory.test.js"
Cohesion: 0.20
Nodes (7): api, assert, db, knowledge, memory, programs, { test, before, after }

### Community 182 - "boostedValue"
Cohesion: 0.29
Nodes (7): aiChunkSignals(), applyAiBoost(), applyDomainBoost(), applyReferralBoost(), applyReturnedBoost(), boostedValue(), chunkDomainSignals()

### Community 183 - "context.test.js"
Cohesion: 0.40
Nodes (4): assert, context, db, { test }

### Community 184 - "validator.test.js"
Cohesion: 0.50
Nodes (3): assert, { test }, validator

### Community 187 - "chunkSection"
Cohesion: 0.67
Nodes (4): chunkSection(), chunkSections(), detectDomain(), shouldFlushBeforeMerge()

## Knowledge Gaps
- **1102 isolated node(s):** `$schema`, `builder`, `dockerfilePath`, `startCommand`, `restartPolicyType` (+1097 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `src()` connect `memKey` to `hardwire-verify.mjs`, `programClaim.ts`, `knowledge.js`?**
  _High betweenness centrality (0.182) - this node is a cross-community bridge._
- **Why does `WizardSession` connect `programAccess.ts` to `session.ts`, `programClaim.ts`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `dropSharedLines()` connect `hardwire-setup.mjs` to `fetchSourceText`, `knowledge.test.js`, `fetchUrlSource`, `knowledge.js`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `$schema`, `builder`, `dockerfilePath` to the rest of the system?**
  _1102 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `commands.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0707070707070707 - nodes in this community are weakly interconnected._
- **Should `db.js` be split into smaller, more focused modules?**
  _Cohesion score 0.057859703020993344 - nodes in this community are weakly interconnected._
- **Should `handlers.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08620689655172414 - nodes in this community are weakly interconnected._