// Web console for Pixie. Runs as Bun.serve in the same process as the Slack
// bot, so it can call lib/ functions directly. Serves static assets from
// public/ with no build step, and JSON APIs that assemble existing DB queries.
const path = require("path");
const fs = require("fs");
const log = require("../log");
const auth = require("./auth");
const api = require("./api");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);
  return new Response(data, {
    headers: { "Content-Type": mime, "Cache-Control": "no-cache" },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

function htmlResponse(html, extraHeaders = {}) {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

/* ------------------------------------------------------------------- SSE -- */

const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) {}
  }
}

function sseStream(req) {
  let closed = false;
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const client = {
        write(data) {
          if (!closed) controller.enqueue(encoder.encode(data));
        },
      };
      sseClients.add(client);

      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));

      req.signal.addEventListener("abort", () => {
        closed = true;
        sseClients.delete(client);
        try { controller.close(); } catch (_) {}
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Hook log events into the SSE feed so the live panel works without touching
// any call site. Called by web.start().
function startLogFeed() {
  log.subscribe((kind, scope, args) => {
    broadcastSSE("log", {
      kind,
      scope,
      message: args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
      time: Date.now(),
    });
  });
}

// Tick: broadcast vitals every 10s so the HUD updates without polling.
let metricTimer = null;

function startMetricTicks() {
  if (metricTimer) return;
  metricTimer = setInterval(() => {
    try {
      const pulse = api.buildPulse();
      broadcastSSE("pulse", pulse);
    } catch (_) {}
    try {
      broadcastSSE("metric", { time: Date.now() });
    } catch (_) {}
  }, 10000);
  if (metricTimer.unref) metricTimer.unref();
}

/* ---------------------------------------------------------------- router -- */

async function handleStatic(req) {
  const url = new URL(req.url);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;

  // Prevent directory traversal.
  if (filePath.includes("..")) return null;

  const fullPath = path.join(PUBLIC_DIR, filePath);

  // If the file exists, serve it. / requires session; static assets don't.
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    // index.html requires a session.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const session = auth.requireSession(req);
      if (!session) return redirect("/login");
    }
    return serveFile(fullPath);
  }

  return null;
}

async function handleAuth(req) {
  const url = new URL(req.url);

  if (url.pathname === "/login") {
    // Dev mode: skip real OAuth when SLACK_CLIENT_ID is just "dev-testing".
    if (process.env.SLACK_CLIENT_ID === "dev-testing") {
      const cookieValue = auth.signSession("dev-user", "Developer");
      const setCookie = `${auth.COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
      return new Response(null, { status: 302, headers: { "Set-Cookie": setCookie, Location: "/" } });
    }
    return redirect(auth.loginUrl("/"));
  }

  if (url.pathname === "/auth/callback") {
    const result = await auth.handleCallback(req);
    if (result.headers) {
      return new Response(null, { status: result.status, headers: result.headers });
    }
    return json(result.body, result.status);
  }

  if (url.pathname === "/auth/logout") {
    const result = auth.handleLogout();
    return new Response(null, { status: result.status, headers: result.headers });
  }

  return null;
}

async function handleApi(req) {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // Admin check for writes.
  const adminResult = auth.requireAdmin(req);

  // Pulse — anyone with a session.
  if (url.pathname === "/api/pulse" && method === "GET") {
    const session = auth.requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json(api.buildPulse());
  }

  // Stream — SSE.
  if (url.pathname === "/api/stream" && method === "GET") {
    const session = auth.requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return sseStream(req);
  }

  // Ask — the probe.
  if (url.pathname === "/api/ask" && method === "POST") {
    const session = auth.requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const result = await api.handleAsk(body.question || "");
    return json(result);
  }

  // Queue.
  if (url.pathname === "/api/queue" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.queueList());
  }

  if (url.pathname.startsWith("/api/queue/") && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const parts = url.pathname.split("/");
    const id = Number(parts[3]);
    const action = parts[4];
    if (action === "approve") api.queueApprove(id);
    else if (action === "drop") api.queueDrop(id);
    return json({ ok: true });
  }

  if (url.pathname.startsWith("/api/queue/") && method === "PATCH") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const id = Number(url.pathname.split("/")[3]);
    const body = await req.json().catch(() => ({}));
    api.queueEdit(id, body.question, body.answer);
    return json({ ok: true });
  }

  // Gaps.
  if (url.pathname === "/api/gaps" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.gapsList());
  }

  if (url.pathname.startsWith("/api/gaps/") && method === "PATCH") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const parts = url.pathname.split("/");
    const id = Number(parts[3]);
    const body = await req.json().catch(() => ({}));
    api.gapsMove(id, body.kind);
    return json({ ok: true });
  }

  if (url.pathname.startsWith("/api/gaps/") && url.pathname.endsWith("/rejudge") && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const id = Number(url.pathname.split("/")[3]);
    const result = await api.gapsRejudge(id);
    return json(result);
  }

  // Silence.
  if (url.pathname === "/api/silence" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.silenceList());
  }

  // Knowledge.
  if (url.pathname === "/api/knowledge" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.knowledgeInfo());
  }

  if (url.pathname === "/api/knowledge/corpus" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.knowledgeCorpus());
  }

  if (url.pathname === "/api/knowledge/refresh" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    await api.knowledgeRefresh();
    return json({ ok: true });
  }

  // Cache.
  if (url.pathname === "/api/cache" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    return json(api.cacheList());
  }

  if (url.pathname.startsWith("/api/cache/") && method === "DELETE") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const hash = url.pathname.split("/")[3];
    api.cacheBust(hash);
    return json({ ok: true });
  }

  // Teach.
  if (url.pathname === "/api/teach" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const body = await req.json().catch(() => ({}));
    api.handleTeach(body.question, body.answer, adminResult.session.userId);
    return json({ ok: true });
  }

  // Report.
  if (url.pathname === "/api/report" && method === "GET") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const week = Number(url.searchParams.get("week") || "0");
    return json(api.reportText(week));
  }

  if (url.pathname === "/api/report/post" && method === "POST") {
    if (adminResult.status) return json(adminResult.body, adminResult.status);
    const ok = await api.reportPost();
    return json({ ok });
  }

  // Health.
  if (url.pathname === "/api/health" && method === "GET") {
    const session = auth.requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json(api.healthCheck());
  }

  return null;
}

async function handleRequest(req) {
  const url = new URL(req.url);

  try {
    // Auth routes first.
    if (["/login", "/auth/callback", "/auth/logout"].includes(url.pathname) || url.pathname.startsWith("/auth/")) {
      const res = await handleAuth(req);
      if (res) return res;
    }

    // API routes.
    if (url.pathname.startsWith("/api/")) {
      const res = await handleApi(req);
      if (res) return res;
    }

    // Static files.
    const res = await handleStatic(req);
    if (res) return res;

    return new Response("not found", { status: 404 });
  } catch (e) {
    log.error("web", `request error: ${e.message}`);
    return json({ error: "internal error" }, 500);
  }
}

function start() {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    log.info("web", "SLACK_CLIENT_ID not set — web server disabled");
    return null;
  }

  const port = Number(process.env.PIXIE_WEB_PORT) || 4100;

  startLogFeed();
  startMetricTicks();

  const server = Bun.serve({
    port,
    fetch: handleRequest,
  });

  log.info("web", `console running on http://localhost:${port}`);
  return server;
}

module.exports = { start, broadcastSSE };
