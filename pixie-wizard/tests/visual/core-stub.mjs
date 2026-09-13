// Local stub for Pixie Core's /internal/v1/* read endpoints (tests/visual).
//
// Serves the fixed JSON every program page in wizard.visual.spec.ts reads
// via lib/pixieCore.ts, so screenshots are deterministic without a real
// Core or any external calls (Slack, models, network). Read-only: only the
// GETs the pages issue (plus the batch identity POST) are implemented;
// anything else gets 404/405 and every mutation path gets 501.
//
// Run:  PIXIE_INTERNAL_TOKEN=visual-stub-token node tests/visual/core-stub.mjs
//   (optional CORE_STUB_PORT, default 4902)
// Point the Wizard at it: PIXIE_CORE_BASE_URL=http://127.0.0.1:4902
//   PIXIE_INTERNAL_TOKEN=visual-stub-token
//
// Fixed clock anchors (ms since epoch; the pages render them with timeAgo/
// shortTime, so capture baseline and rewrite snapshots back-to-back):
//   1720000000000 = 2024-07-03T09:46:40Z.

import http from "node:http";

const PORT = Number(process.env.CORE_STUB_PORT || 4902);
const TOKEN = process.env.PIXIE_INTERNAL_TOKEN || "visual-stub-token";
const PROGRAM = "visual-program";

// --- fixed fixtures -------------------------------------------------------

const T0 = 1720000000000; // 2024-07-03T09:46:40Z
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const ANALYTICS = {
  programId: PROGRAM,
  created: 42,
  aiAnswered: 30,
  humanHandled: 12,
  deflected: 26,
  deflectionRate: 0.62,
  reopened: 2,
  reopenRate: 0.05,
  duplicates: 3,
  duplicateRate: 0.07,
  byStatus: { open: 4, waiting_for_helper: 2, assigned: 2, escalated: 2, resolved: 30, reopened: 2 },
  byCategory: [
    { category: "shipping", n: 18 },
    { category: "grants", n: 12 },
    { category: "other", n: 12 },
  ],
  helperLoad: [{ userId: "U_VISUAL_HELPER", openAssigned: 3 }],
  helperResolved: [{ userId: "U_VISUAL_HELPER", resolved: 11 }],
  medianFirstResponseMs: 240_000,
  medianFirstHumanResponseMs: 3_600_000,
  medianResolveMs: 7_200_000,
  stale48h: 1,
  gapCounts: { unanswered: 2 },
  incidents: { candidate: 1 },
};

const TICKETS = [
  {
    id: 1001,
    question: "How do I submit my project for review?",
    summary: "How to submit a project for review",
    status: "open",
    requester_id: "U_VISUAL_REQUESTER",
    assignee_id: null,
    category: "shipping",
    priority: "normal",
    created_at: T0 - 2 * HOUR,
  },
  {
    id: 1002,
    question: "My grant payout has not arrived yet",
    summary: "Grant payout delay",
    status: "assigned",
    requester_id: "U_VISUAL_REQUESTER",
    assignee_id: "U_VISUAL_HELPER",
    category: "grants",
    priority: "high",
    created_at: T0 - 26 * HOUR,
  },
  {
    id: 1003,
    question: "Where are the program guidelines?",
    summary: "Program guidelines location",
    status: "resolved",
    requester_id: "U_VISUAL_REQUESTER",
    assignee_id: "U_VISUAL_HELPER",
    category: "other",
    priority: "normal",
    created_at: T0 - 3 * DAY,
  },
];

function ticketDetail(ticket) {
  return {
    ...ticket,
    program_id: PROGRAM,
    messages: [
      { id: ticket.id * 10 + 1, author_id: ticket.requester_id, body: ticket.question, created_at: ticket.created_at },
    ],
    notes: [],
  };
}

const CANDIDATES = [
  {
    id: 501,
    question: "How do I submit my project for review?",
    answer: "Open the dashboard, pick your program, and press Submit before Friday.",
    status: "candidate",
    category: "shipping",
    ticket_id: 1001,
    resolver_id: "U_VISUAL_HELPER",
    created_at: T0 - DAY,
  },
  {
    id: 502,
    question: "When do grant payouts go out?",
    answer: "Payouts go out on the first Monday of each month.",
    status: "candidate",
    category: "grants",
    ticket_id: null,
    resolver_id: null,
    created_at: T0 - 2 * DAY,
  },
];

const CLUSTERS = [
  {
    representative: "How do I submit my project for review?",
    variants: 3,
    askCount: 9,
    askers: 7,
    firstSeen: T0 - 10 * DAY,
    lastSeen: T0 - HOUR,
    escalated: 2,
    covered: false,
  },
  {
    representative: "When do grant payouts go out?",
    variants: 2,
    askCount: 5,
    askers: 4,
    firstSeen: T0 - 8 * DAY,
    lastSeen: T0 - 5 * HOUR,
    escalated: 0,
    covered: true,
  },
];

const MACROS = [
  {
    id: 301,
    trigger: "?shipping",
    name: "Shipping steps",
    description: "Points at the submission checklist.",
    content: "Hi {requester}! Here is the shipping checklist for ticket {ticket_id}.",
    enabled: 1,
    on_send_transition: null,
  },
  {
    id: 302,
    trigger: "?payout",
    name: "Payout timing",
    description: "Standard payout-timing reply; resolves on send.",
    content: "Payouts go out monthly, {requester} — {helper} will confirm yours.",
    enabled: 1,
    on_send_transition: "resolved",
  },
];

const HELPERS = [
  { user_id: "U_VISUAL_OWNER", helper_source: "creator", role: "owner", active: 1 },
  { user_id: "U_VISUAL_HELPER", helper_source: "manual", role: "helper", active: 1 },
];

const ZERO_COUNTS = { offered: 0, claimed: 0, declined: 0, released: 0, timedOut: 0, completedOffers: 0 };

function helperStat(userId, role, open, resolved) {
  return {
    userId,
    role,
    active: true,
    expertise: [{ tag: "shipping", solved_count: resolved }],
    categoryResolved: [{ category: "shipping", resolved }],
    totals: { assigned: open + resolved, resolved, open, reopened: 0 },
    reopenRate: 0,
    medianFirstResponseMs: 240_000,
    medianResolutionMs: 7_200_000,
    helpfulCount: resolved,
    unhelpfulCount: 0,
    helpfulPercentage: 1,
    lastActivity: T0 - HOUR,
    acceptRate: 1,
    assignmentLifecycle: "supported",
    assignments: ZERO_COUNTS,
    recentTickets: [],
  };
}

const HELPER_STATS = {
  programId: PROGRAM,
  acceptRate: 1,
  acceptedAssignments: 11,
  completedOffers: 11,
  assignmentLifecycle: "supported",
  helpers: [helperStat("U_VISUAL_HELPER", "helper", 3, 11), helperStat("U_VISUAL_OWNER", "owner", 0, 0)],
};

const ROUTING_RECOMMENDATIONS = [
  { userId: "U_VISUAL_HELPER", score: 0.9, reasons: ["resolved 11 shipping tickets", "active in the last hour"] },
];

const INCIDENTS = [
  {
    id: 201,
    title: "Payout status confusion",
    status: "candidate",
    reason: "Burst of similar payout questions in #visual-help",
    confidence: 0.82,
    started_at: T0 - 6 * HOUR,
  },
];

const INCIDENT_DETAIL = {
  incident: {
    id: 201,
    title: "Payout status confusion",
    status: "candidate",
    reason: "Burst of similar payout questions in #visual-help",
    description: "Five payout questions in two hours; likely a stale status page.",
    public_message: null,
    confidence: 0.82,
    started_at: T0 - 6 * HOUR,
    declared_at: T0 - 6 * HOUR,
    resolved_at: null,
  },
  updates: [{ id: 1, body: "Helpers confirmed the status page is stale.", created_at: T0 - 3 * HOUR }],
  tickets: [{ id: 1002, question: "My grant payout has not arrived yet", status: "assigned" }],
};

const INCIDENT_AFFECTED = {
  total: 2,
  unnotified: 2,
  reports: [
    { ticket_id: 1002, notified: false },
    { ticket_id: 1001, notified: false },
  ],
};

const RADAR_SIGNALS = [
  {
    id: 401,
    type: "ESCALATION_SPIKE",
    severity: "MEDIUM",
    status: "active",
    title: "Escalations up 2x in #visual-help",
    summary: "4 escalations in the last day vs a baseline of 2.",
    evidence: { baseline: 2, observed: 4 },
    first_detected_at: T0 - 20 * HOUR,
    last_detected_at: T0 - HOUR,
    resolved_at: null,
  },
  {
    id: 402,
    type: "FAQ_CLUSTER",
    severity: "LOW",
    status: "acknowledged",
    title: "Repeat questions about submissions",
    summary: "9 asks across 7 people need a doc fix.",
    evidence: { askCount: 9, askers: 7 },
    first_detected_at: T0 - 2 * DAY,
    last_detected_at: T0 - 3 * HOUR,
    resolved_at: null,
  },
];

const HEALTH = {
  score: 78,
  label: "healthy",
  components: { responseTime: 82, resolutionRate: 91, reopenRate: 64, backlogHealth: 75 },
  windowDays: 30,
};

const RETENTION = {
  policy: { tickets_days: 365, events_days: 180, notes_days: 365 },
  tickets: 4,
  ticketEvents: 12,
  notes: 2,
  metrics: 30,
  gaps: 1,
};

const AUDIT = [
  {
    id: 3,
    actor_id: "U_VISUAL_OWNER",
    action: "ticket.resolved",
    entity_type: "ticket",
    entity_id: "1001",
    metadata: null,
    created_at: T0 - DAY,
  },
  {
    id: 2,
    actor_id: "U_VISUAL_OWNER",
    action: "helper.added",
    entity_type: "helper",
    entity_id: "U_VISUAL_HELPER",
    metadata: null,
    created_at: T0 - 2 * DAY,
  },
  {
    id: 1,
    actor_id: null,
    action: "program.created",
    entity_type: "program",
    entity_id: PROGRAM,
    metadata: null,
    created_at: T0 - 3 * DAY,
  },
];

const CHANNELS = [
  { id: "C_HELP_VISUAL", name: "visual-help", isMember: true },
  { id: "C_ORG_VISUAL", name: "visual-org", isMember: true },
];

const PROFILES = {
  U_VISUAL_OWNER: {
    slackId: "U_VISUAL_OWNER",
    displayName: "Local Dev",
    realName: "Local Dev",
    username: "localdev",
    avatarUrl: null,
  },
  U_VISUAL_HELPER: {
    slackId: "U_VISUAL_HELPER",
    displayName: "Visual Helper",
    realName: "Visual Helper",
    username: "visualhelper",
    avatarUrl: null,
  },
  U_VISUAL_REQUESTER: {
    slackId: "U_VISUAL_REQUESTER",
    displayName: "Visual Asker",
    realName: "Visual Asker",
    username: "visualasker",
    avatarUrl: null,
  },
};

// --- usage aggregate (echoes the requested window) -------------------------
// lib/pixieCore.ts validates programId/from/to/precision, so these come
// from the query string instead of being hardcoded.

function metric(requests, input, output, cached, costCents) {
  return { requests, inputTokens: input, outputTokens: output, cachedInputTokens: cached, costCents };
}

function usageAggregate(programId, from, until, interval) {
  const step = interval === "hour" ? HOUR : DAY;
  const end = Date.parse(until);
  const at = (n) => new Date(end - n * step).toISOString();
  return {
    programId,
    from,
    to: until,
    precision: "exact",
    ...metric(120, 900_000, 150_000, 300_000, 1575),
    summary: {
      ...metric(120, 900_000, 150_000, 300_000, 1575),
      latencyMs: 420,
      errors: 1,
      rateLimited: 0,
      groundedAnswers: 74,
      fallbacks: 3,
      suppressed: 0,
    },
    timeseries: [3, 2, 1].map((n) => ({ ...metric(10 * n, 75_000 * n, 12_500 * n, 25_000 * n, 130 * n), at: at(n) })),
    operation: [
      { ...metric(90, 700_000, 110_000, 230_000, 1200), name: "answer" },
      { ...metric(30, 200_000, 40_000, 70_000, 375), name: "triage" },
    ],
    provider: [{ ...metric(120, 900_000, 150_000, 300_000, 1575), name: "openai" }],
    model: [{ ...metric(120, 900_000, 150_000, 300_000, 1575), provider: "openai", name: "gpt-4o-mini" }],
    topConsumers: [{ ...metric(40, 300_000, 50_000, 100_000, 525), consumerId: "U_VISUAL_REQUESTER" }],
    recent: [2, 1, 0].map((n) => ({
      at: at(n + 1),
      operation: "answer",
      provider: "openai",
      model: "gpt-4o-mini",
      consumerId: "U_VISUAL_REQUESTER",
      requestId: `req-visual-${n}`,
      status: "ok",
      latencyMs: 400 + n,
      rateLimited: false,
      retryCount: 0,
    })),
  };
}

// --- server ----------------------------------------------------------------

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = (req.method || "GET").toUpperCase();

  if (path === "/healthz") return send(res, 200, { ok: true });

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });

  let m;
  try {
    // -- program reads -----------------------------------------------------
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/analytics$/)) && method === "GET") {
      return send(res, 200, ANALYTICS);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/usage$/)) && method === "GET") {
      const from = url.searchParams.get("from") || new Date(T0 - 30 * DAY).toISOString();
      const until = url.searchParams.get("until") || new Date(T0).toISOString();
      return send(res, 200, usageAggregate(decodeURIComponent(m[1]), from, until, url.searchParams.get("interval")));
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/knowledge\/candidates$/)) && method === "GET") {
      return send(res, 200, CANDIDATES);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/gaps\/clusters$/)) && method === "GET") {
      return send(res, 200, { clusters: CLUSTERS });
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/macros$/)) && method === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      return send(res, 200, q ? MACROS.filter((row) => `${row.trigger} ${row.name}`.toLowerCase().includes(q)) : MACROS);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/helpers\/stats$/)) && method === "GET") {
      return send(res, 200, HELPER_STATS);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/helpers$/)) && method === "GET") {
      return send(res, 200, HELPERS);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/routing\/recommend$/)) && method === "GET") {
      return send(res, 200, ROUTING_RECOMMENDATIONS);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/incidents$/)) && method === "GET") {
      return send(res, 200, INCIDENTS);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/radar$/)) && method === "GET") {
      return send(res, 200, { signals: RADAR_SIGNALS });
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/health$/)) && method === "GET") {
      return send(res, 200, HEALTH);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/retention$/)) && method === "GET") {
      return send(res, 200, RETENTION);
    }
    if ((m = path.match(/^\/internal\/v1\/programs\/([^/]+)\/audit$/)) && method === "GET") {
      return send(res, 200, AUDIT);
    }

    // -- ticket reads -------------------------------------------------------
    if (path === "/internal/v1/tickets" && method === "GET") {
      const status = url.searchParams.get("status");
      const q = (url.searchParams.get("q") || "").toLowerCase();
      let rows = TICKETS;
      if (status) rows = rows.filter((t) => t.status === status);
      if (q) rows = rows.filter((t) => `${t.question} ${t.summary || ""}`.toLowerCase().includes(q));
      const limit = Number(url.searchParams.get("limit") || "25");
      const offset = Number(url.searchParams.get("offset") || "0");
      return send(res, 200, { total: rows.length, rows: rows.slice(offset, offset + limit) });
    }
    if ((m = path.match(/^\/internal\/v1\/tickets\/(\d+)$/)) && method === "GET") {
      const ticket = TICKETS.find((t) => t.id === Number(m[1]));
      if (!ticket) return send(res, 404, { error: "ticket not found" });
      return send(res, 200, ticketDetail(ticket));
    }

    // -- incident reads ------------------------------------------------------
    if ((m = path.match(/^\/internal\/v1\/incidents\/(\d+)\/affected$/)) && method === "GET") {
      if (Number(m[1]) !== INCIDENT_DETAIL.incident.id) return send(res, 404, { error: "incident not found" });
      return send(res, 200, INCIDENT_AFFECTED);
    }
    if ((m = path.match(/^\/internal\/v1\/incidents\/(\d+)$/)) && method === "GET") {
      if (Number(m[1]) !== INCIDENT_DETAIL.incident.id) return send(res, 404, { error: "incident not found" });
      return send(res, 200, INCIDENT_DETAIL);
    }

    // -- slack reads ---------------------------------------------------------
    if (path === "/internal/v1/slack/channels" && method === "GET") {
      return send(res, 200, { ok: true, channels: CHANNELS });
    }
    if (path === "/internal/v1/slack/membership" && method === "GET") {
      const channel = url.searchParams.get("channel") || "C_HELP_VISUAL";
      const found = CHANNELS.find((c) => c.id === channel);
      return send(res, 200, { ok: true, hasAccess: Boolean(found), name: found ? `#${found.name}` : null });
    }
    if (path === "/internal/v1/slack/users/info" && method === "GET") {
      const user = url.searchParams.get("user") || "";
      const profile = PROFILES[user];
      if (!profile) return send(res, 200, { ok: false, reason: "unknown user" });
      return send(res, 200, { ok: true, ...profile });
    }
    if (path === "/internal/v1/slack/users/info" && method === "POST") {
      const body = await readJson(req);
      const ids = Array.isArray(body.userIds) ? body.userIds : [];
      const users = {};
      for (const id of [...new Set(ids)].slice(0, 50)) users[id] = PROFILES[id] || null;
      return send(res, 200, { users });
    }

    // -- explicit read-only boundary -----------------------------------------
    if (path.startsWith("/internal/v1/") && method !== "GET") {
      return send(res, 501, { error: "core stub is read-only; mutations are not implemented" });
    }
    return send(res, 404, { error: `no stub for ${method} ${path}` });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : "stub failure" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[core-stub] listening on http://127.0.0.1:${PORT} (program=${PROGRAM})`);
});
