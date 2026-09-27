// FAQ gap intelligence: doc_gaps rows are individual misses; organizers need
// "17 people asked about PCBWay this week". Clustering is deterministic
// token-overlap (union-find), never embeddings — explainable, stable, and
// cheap. Drafts flow into the same candidate pipeline as resolution memory,
// so approval means the same verification stamp and cache invalidation.
const db = require("./db");
const retrieve = require("./retrieve");
const audit = require("./audit");
const programs = require("./programs");
const log = require("./log");

type Row = Record<string, any>;
type QuestionGroup = { question: string; askCount: number; askers: Set<string>; firstSeen: number; lastSeen: number; threads: Array<{ channel: string; messageTs: string }> };

// 0.35 joins clear paraphrases without merging everything that shares "how do i".
const DEFAULT_THRESHOLD = 0.35;

// Long keywords survive phrasing changes ("pcb way" vs "pcbway") where token
// overlap goes to zero. Length-gated so everyday words cannot glue unrelated
// questions together; clustering is a triage suggestion, and organizers can
// always split what it joins.
const KEYWORD_MIN_LEN = 6;
const KEYWORD_SIM = 0.5;

// Thirty days: a triage window long enough to see a trend, short enough that
// last month's answered gaps age out on their own.
const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000;
// Two distinct askers before a cluster surfaces: one person's repeat is a
// ticket, two people's same question is a missing doc.
const DEFAULT_MIN_ASKERS = 2;
// 0.6 overlap against an approved fact means the gap is already answered.
const COVERAGE_THRESHOLD = 0.6;
// Cap per-question thread samples so one viral thread cannot dominate a cluster.
const MAX_THREADS_PER_QUESTION = 3;
const MAX_THREADS_PER_CLUSTER = 3;
// Cap fact scan for coverage so a huge learned table cannot stall triage.
const COVERAGE_FACT_LIMIT = 200;

function despace(s: unknown): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function longTokens(question: string, cachedSets: ((question: string) => Set<string>) | null): string[] {
  const terms = cachedSets ? [...cachedSets(question)] : retrieve.tokenize(question);
  return terms.filter((t: string) => t.length >= KEYWORD_MIN_LEN);
}

function keywordContained(a: string, b: string, cachedSets: ((question: string) => Set<string>) | null = null): boolean {
  const tokensA = longTokens(a, cachedSets);
  const tokensB = longTokens(b, cachedSets);
  const flatA = despace(a);
  const flatB = despace(b);
  for (const t of tokensA) {
    if (flatB.includes(t)) return true;
  }
  for (const t of tokensB) {
    if (flatA.includes(t)) return true;
  }
  return false;
}

// Token sets are memoized per clustering pass: pairOverlap is called O(n²)
// times and retokenizing the same questions on every pair dominated burst
// detection over a few hundred tickets.
function tokenSetCache(questions: string[]): (q: string) => Set<string> {
  const cache = new Map<string, Set<string>>();
  return (q: string) => {
    if (!cache.has(q)) cache.set(q, new Set<string>(retrieve.tokenize(q)));
    return cache.get(q) as Set<string>;
  };
}

function overlapOf(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const t of setA) {
    if (setB.has(t)) common += 1;
  }
  return common / Math.min(setA.size, setB.size);
}

function pairOverlap(a: string, b: string, cachedSets: ((question: string) => Set<string>) | null = null): number {
  const setA = cachedSets ? cachedSets(a) : new Set<string>(retrieve.tokenize(a));
  const setB = cachedSets ? cachedSets(b) : new Set<string>(retrieve.tokenize(b));
  const overlap = overlapOf(setA, setB);
  if (overlap < KEYWORD_SIM && keywordContained(a, b, cachedSets)) return KEYWORD_SIM;
  return overlap;
}

function unionFind(count: number): { find: (x: number) => number; union: (a: number, b: number) => void } {
  const parent = Array.from({ length: count }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    parent[find(a)] = find(b);
  }
  return { find, union };
}

function clusterQuestions(questions: string[], threshold = DEFAULT_THRESHOLD): string[][] {
  if (!Array.isArray(questions) || questions.length === 0) return [];
  const sets = tokenSetCache(questions);
  const { find, union } = unionFind(questions.length);
  for (let i = 0; i < questions.length; i++) {
    for (let j = i + 1; j < questions.length; j++) {
      if (pairOverlap(questions[i], questions[j], sets) >= threshold) union(i, j);
    }
  }
  const groups = new Map<number, string[]>();
  questions.forEach((q, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(q);
    else groups.set(root, [q]);
  });
  return [...groups.values()];
}

function fetchGapRows(programId: string, sinceMs: number): Row[] {
  // Strictly program-scoped: unscoped legacy rows carry other programs'
  // members' questions and user ids, so they are never shown to a program.
  return db.handle().query(
    "SELECT question, user_id, channel, message_ts, created_at FROM doc_gaps WHERE created_at > ? AND program_id = ?",
  ).all(Date.now() - sinceMs, programId);
}

function groupRowsByQuestion(rows: Row[]): QuestionGroup[] {
  const byQuestion = new Map<string, QuestionGroup>();
  for (const r of rows) {
    const q = String(r.question || "").trim();
    if (!q) continue;
    if (!byQuestion.has(q)) {
      byQuestion.set(q, { question: q, askCount: 0, askers: new Set<string>(), firstSeen: r.created_at, lastSeen: r.created_at, threads: [] });
    }
    const g = byQuestion.get(q);
    if (!g) continue;
    g.askCount += 1;
    if (r.user_id) g.askers.add(r.user_id);
    g.firstSeen = Math.min(g.firstSeen, r.created_at);
    g.lastSeen = Math.max(g.lastSeen, r.created_at);
    if (r.channel && r.message_ts && g.threads.length < MAX_THREADS_PER_QUESTION) {
      g.threads.push({ channel: r.channel, messageTs: r.message_ts });
    }
  }
  return [...byQuestion.values()];
}

function countEscalated(parts: QuestionGroup[], programId: string): number {
  let escalated = 0;
  try {
    for (const p of parts) {
      for (const t of p.threads) {
        if (db.handle().query("SELECT 1 FROM tickets WHERE thread_ts = ? AND program_id = ? LIMIT 1").get(t.messageTs, programId)) {
          escalated += 1;
          break;
        }
      }
    }
  } catch (e) {
    log.warn("gapClusters", `failed to count escalated threads: ${e instanceof Error ? e.message : String(e)}`);
  }
  return escalated;
}

function isCovered(representative: string, programId: string): boolean {
  try {
    const facts = db.approvedFacts(COVERAGE_FACT_LIMIT, programId);
    return facts.some((f: Row) => pairOverlap(representative, `${f.question} ${f.answer}`.slice(0, 200)) >= COVERAGE_THRESHOLD);
  } catch (e) {
    log.warn("gapClusters", `failed to check coverage for representative: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function summarizeCluster(members: string[], byQuestion: Map<string, QuestionGroup>, programId: string): Row {
  const parts = members.map((q) => byQuestion.get(q) as QuestionGroup);
  const askers = new Set();
  for (const p of parts) for (const u of p.askers) askers.add(u);
  const representative = parts.slice().sort((a, b) => b.askCount - a.askCount)[0].question;
  return {
    representative,
    variants: members.length,
    askCount: parts.reduce((n, p) => n + p.askCount, 0),
    askers: askers.size,
    firstSeen: Math.min(...parts.map((p) => p.firstSeen)),
    lastSeen: Math.max(...parts.map((p) => p.lastSeen)),
    escalated: countEscalated(parts, programId),
    covered: isCovered(representative, programId),
    threads: parts.flatMap((p) => p.threads).slice(0, MAX_THREADS_PER_CLUSTER),
  };
}

function clusterGaps({ programId, sinceMs = DEFAULT_SINCE_MS, minAskers = DEFAULT_MIN_ASKERS }: { programId?: string; sinceMs?: number; minAskers?: number } = {}): Row {
  if (!programId) return { error: "programId required" };
  let rows = [];
  try {
    rows = fetchGapRows(programId, sinceMs);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (rows.length === 0) return { clusters: [] };
  const distinct = groupRowsByQuestion(rows);
  if (distinct.length === 0) return { clusters: [] };
  const byQuestion = new Map(distinct.map((g: QuestionGroup) => [g.question, g]));
  const clusters = clusterQuestions(distinct.map((g) => g.question))
    .map((members) => summarizeCluster(members, byQuestion, programId))
    .filter((c: Row) => c.askers >= minAskers)
    .sort((a: Row, b: Row) => b.askers - a.askers || b.askCount - a.askCount);
  return { clusters };
}

async function proposeFaq({ programId, actorId, question }: { programId: string; actorId?: string | null; question: string }): Promise<Row> {
  const program = programs.get(programId);
  if (!program) return { error: "unknown program" };
  const clean = String(question || "").trim();
  if (!clean) return { error: "question required" };
  // Draft grounded in current docs where possible; an ungrounded draft is
  // still useful as a starting point the approver must verify or rewrite.
  // Copilot stays lazily required: it pulls knowledge->learn at load, and
  // hoisting it here would harden that chain into a load-time cycle.
  let draft = "";
  let grounded = false;
  try {
    const copilot = require("./copilot");
    const res = await copilot.ask({ program, question: clean });
    if (res.grounded && res.draft) {
      draft = res.draft;
      grounded = true;
    }
  } catch (e) {
    log.warn("gapClusters", `failed to ask copilot for FAQ draft: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!draft) draft = "(No grounded answer in current docs — write the approved answer, then approve.)";
  const id = db.addLearnedFact({
    question: clean,
    answer: draft,
    authorId: actorId || null,
    status: "candidate",
    programId,
    category: "faq-gap",
  });
  if (!id) return { error: "could not store FAQ draft" };
  audit.record({ programId, actorId, action: "knowledge.faq_proposed", entityType: "learned_fact", entityId: id, metadata: { grounded } });
  return { ok: true, candidate: db.getLearnedFactById(id), grounded };
}

export = {
  clusterGaps,
  clusterQuestions,
  pairOverlap,
  proposeFaq,
  DEFAULT_THRESHOLD,
  KEYWORD_MIN_LEN,
  KEYWORD_SIM,
  DEFAULT_SINCE_MS,
  DEFAULT_MIN_ASKERS,
  COVERAGE_THRESHOLD,
};
