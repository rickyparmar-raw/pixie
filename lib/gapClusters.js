// FAQ gap intelligence: doc_gaps rows are individual misses; organizers need
// "17 people asked about PCBWay this week". Clustering is deterministic
// token-overlap (union-find), never embeddings — explainable, stable, and
// cheap. Drafts flow into the same candidate pipeline as resolution memory,
// so approval means the same verification stamp and cache invalidation.
const db = require("./db");
const retrieve = require("./retrieve");
const audit = require("./audit");

const DEFAULT_THRESHOLD = 0.35;

// Long keywords survive phrasing changes ("pcb way" vs "pcbway") where token
// overlap goes to zero. Length-gated so everyday words cannot glue unrelated
// questions together; clustering is a triage suggestion, and organizers can
// always split what it joins.
const KEYWORD_MIN_LEN = 6;
const KEYWORD_SIM = 0.5;

function despace(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keywordContained(a, b, cachedSets = null) {
  const pick = (q) => {
    const terms = cachedSets ? [...cachedSets(q)] : retrieve.tokenize(q);
    return terms.filter((t) => t.length >= KEYWORD_MIN_LEN);
  };
  const tokensA = pick(a);
  const tokensB = pick(b);
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
function tokenSetCache(questions) {
  const cache = new Map();
  return (q) => {
    if (!cache.has(q)) cache.set(q, new Set(retrieve.tokenize(q)));
    return cache.get(q);
  };
}

function pairOverlap(a, b, cachedSets = null) {
  const setA = cachedSets ? cachedSets(a) : new Set(retrieve.tokenize(a));
  const setB = cachedSets ? cachedSets(b) : new Set(retrieve.tokenize(b));
  let overlap = 0;
  if (setA.size > 0 && setB.size > 0) {
    let common = 0;
    for (const t of setA) {
      if (setB.has(t)) common += 1;
    }
    overlap = common / Math.min(setA.size, setB.size);
  }
  if (overlap < KEYWORD_SIM && keywordContained(a, b, cachedSets)) return KEYWORD_SIM;
  return overlap;
}

function clusterQuestions(questions, threshold = DEFAULT_THRESHOLD) {
  const sets = tokenSetCache(questions);
  const parent = questions.map((_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    parent[find(a)] = find(b);
  }
  for (let i = 0; i < questions.length; i++) {
    for (let j = i + 1; j < questions.length; j++) {
      if (pairOverlap(questions[i], questions[j], sets) >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  questions.forEach((q, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(q);
  });
  return [...groups.values()];
}

function clusterGaps({ programId, sinceMs = 30 * 24 * 60 * 60 * 1000, minAskers = 2 } = {}) {
  if (!programId) return { error: "programId required" };
  const now = Date.now();
  let rows = [];
  try {
    rows = db.handle().query(
      "SELECT question, user_id, channel, message_ts, created_at FROM doc_gaps WHERE created_at > ? AND (program_id = ? OR program_id IS NULL)",
    ).all(now - sinceMs, programId);
  } catch (e) {
    return { error: e.message };
  }
  if (rows.length === 0) return { clusters: [] };

  const byQuestion = new Map();
  for (const r of rows) {
    const q = String(r.question || "").trim();
    if (!q) continue;
    if (!byQuestion.has(q)) byQuestion.set(q, { question: q, askCount: 0, askers: new Set(), firstSeen: r.created_at, lastSeen: r.created_at, threads: [] });
    const g = byQuestion.get(q);
    g.askCount += 1;
    if (r.user_id) g.askers.add(r.user_id);
    g.firstSeen = Math.min(g.firstSeen, r.created_at);
    g.lastSeen = Math.max(g.lastSeen, r.created_at);
    if (r.channel && r.message_ts && g.threads.length < 3) g.threads.push({ channel: r.channel, messageTs: r.message_ts });
  }
  const distinct = [...byQuestion.values()];
  const clusters = clusterQuestions(distinct.map((g) => g.question))
    .map((members) => {
      const parts = members.map((q) => byQuestion.get(q));
      const askers = new Set();
      for (const p of parts) for (const u of p.askers) askers.add(u);
      // Escalation frequency: gaps whose threads became tickets.
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
      } catch (_) {}
      // Current source coverage: does any approved fact already answer this?
      let covered = false;
      try {
        const facts = db.approvedFacts(200, programId);
        const rep = parts.sort((a, b) => b.askCount - a.askCount)[0].question;
        covered = facts.some((f) => pairOverlap(rep, `${f.question} ${f.answer}`.slice(0, 200)) >= 0.6);
      } catch (_) {}
      const representative = parts.sort((a, b) => b.askCount - a.askCount)[0].question;
      return {
        representative,
        variants: members.length,
        askCount: parts.reduce((n, p) => n + p.askCount, 0),
        askers: askers.size,
        firstSeen: Math.min(...parts.map((p) => p.firstSeen)),
        lastSeen: Math.max(...parts.map((p) => p.lastSeen)),
        escalated,
        covered,
        threads: parts.flatMap((p) => p.threads).slice(0, 3),
      };
    })
    .filter((c) => c.askers >= minAskers)
    .sort((a, b) => b.askers - a.askers || b.askCount - a.askCount);
  return { clusters };
}

async function proposeFaq({ programId, actorId, question }) {
  const programs = require("./programs");
  const program = programs.get(programId);
  if (!program) return { error: "unknown program" };
  const clean = String(question || "").trim();
  if (!clean) return { error: "question required" };
  // Draft grounded in current docs where possible; an ungrounded draft is
  // still useful as a starting point the approver must verify or rewrite.
  let draft = "";
  let grounded = false;
  try {
    const copilot = require("./copilot");
    const res = await copilot.ask({ program, question: clean });
    if (res.grounded && res.draft) {
      draft = res.draft;
      grounded = true;
    }
  } catch (_) {}
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

module.exports = { clusterGaps, clusterQuestions, pairOverlap, proposeFaq };
