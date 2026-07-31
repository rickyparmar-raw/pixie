// Pixie Control Room — vanilla ES module app. No framework, no build step.
// Loaded as type="module" from index.html, served by Bun.serve.

/* ----------------------------------------------------------- api -- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    if (res.status === 401) { window.location.href = "/login"; return; }
    if (res.status === 403) { console.warn("admin only:", path); return { error: "admin only" }; }
  }
  return res.json();
}

/* --------------------------------------------------------- socket -- */

let pulseTimer = null;

function connectSSE() {
  const es = new EventSource("/api/stream");
  const dot = document.getElementById("socket-dot");

  es.addEventListener("connected", () => {
    dot?.classList.remove("disconnected");
  });

  es.addEventListener("pulse", (e) => {
    try { updateHud(JSON.parse(e.data)); } catch (_) {}
  });

  es.addEventListener("log", (e) => {
    try { appendFeed(JSON.parse(e.data)); } catch (_) {}
  });

  es.addEventListener("metric", () => {
    // heartbeat — can trigger refresh if needed
  });

  es.onerror = () => {
    dot?.classList.add("disconnected");
  };

  // Fallback polling for pulse if SSE dies.
  clearInterval(pulseTimer);
  pulseTimer = setInterval(async () => {
    try {
      const pulse = await api("/api/pulse");
      if (pulse && !pulse.error) updateHud(pulse);
    } catch (_) {}
  }, 30000);
}

/* ----------------------------------------------------------- hud -- */

function updateHud(pulse) {
  setEl("hud-coverage", `${pulse.coverage}%`);
  setEl("hud-answered", pulse.answered);
  setEl("hud-silent", pulse.silent);
  setEl("hud-cold", pulse.knownCold);
  setEl("hud-instant", pulse.instantPercent > 0 ? `(${pulse.instantPercent}% instant)` : "");
  setEl("hud-corpus", pulse.corpusRefreshedRelative);

  const q = document.getElementById("hud-queue");
  if (q) {
    q.textContent = pulse.queue;
    q.classList.toggle("glow", pulse.queue > 0);
  }

  const delta = document.getElementById("hud-coverage-delta");
  if (delta && pulse.coverageDelta !== undefined) {
    const d = pulse.coverageDelta;
    if (d > 0) { delta.textContent = `+${d}`; delta.className = "hud-delta up"; }
    else if (d < 0) { delta.textContent = `${d}`; delta.className = "hud-delta down"; }
    else { delta.textContent = ""; delta.className = "hud-delta"; }
  }
}

/* ----------------------------------------------------------- feed -- */

const MAX_FEED = 100;

function appendFeed(e) {
  if (e.kind === "debug") return;
  const list = document.getElementById("feed-list");
  if (!list) return;

  const row = document.createElement("div");
  row.className = "feed-row";
  row.innerHTML = `<span class="feed-scope">[${e.kind}/${e.scope}]</span> <span class="feed-msg">${esc(e.message || "")}</span>`;
  list.prepend(row);

  while (list.children.length > MAX_FEED) list.lastChild.remove();
}

/* --------------------------------------------------------- ask -- */

const askInput = document.getElementById("ask-input");
const askBtn = document.getElementById("ask-btn");
const askResult = document.getElementById("ask-result");
const askTrace = document.getElementById("ask-trace");

let asking = false;

askBtn?.addEventListener("click", doAsk);
askInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !asking) doAsk();
});

async function doAsk() {
  const q = askInput?.value.trim();
  if (!q || asking) return;
  asking = true;
  askBtn.disabled = true;
  askResult.innerHTML = '<div class="ask-placeholder">thinking...</div>';
  askTrace.innerHTML = "";

  try {
    const data = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question: q }),
    });

    if (data.error) {
      askResult.innerHTML = `<div class="ask-placeholder">Error: ${esc(data.error)}</div>`;
    } else {
      renderAskResult(data);
    }
  } catch (e) {
    askResult.innerHTML = `<div class="ask-placeholder">Request failed: ${esc(e.message)}</div>`;
  }

  asking = false;
  askBtn.disabled = false;
  askInput?.focus();
}

function renderAskResult(data) {
  const answer = data.answer || "(no answer)";
  const source = data.source || "(conversational — not in docs)";
  const latency = data.latencyMs ? `${(data.latencyMs / 1000).toFixed(1)}s` : "?";
  const ttft = data.firstTokenMs ? `${(data.firstTokenMs / 1000).toFixed(1)}s` : "n/a";

  askResult.innerHTML = `<div>${esc(answer)}</div>`;

  let trace = "";

  // Meta.
  trace += `<div class="trace-section"><h4>Meta</h4>`;
  trace += `<div class="trace-meta">`;
  trace += `<span>Source: <b>${esc(source)}</b></span>`;
  trace += `<span>Latency: <b>${latency}</b></span>`;
  trace += `<span>TTFT: <b>${ttft}</b></span>`;
  trace += `<span>Corpus: <b>${data.corpusSize}</b> chars / <b>${data.chunkCount}</b> chunks</span>`;
  if (data.citationOk === true) trace += `<span class="meta-ok">Citation OK</span>`;
  else if (data.citationOk === false) trace += `<span class="meta-warn">Citation MISMATCH — cited "${esc(source)}" not in retrieved chunks</span>`;
  trace += `</div></div>`;

  // Cache.
  trace += `<div class="trace-section"><h4>Cache</h4>`;
  trace += `<div class="trace-meta">`;
  trace += `<span>Would hit: <b>${data.cacheWouldHit ? "yes" : "no"}</b></span>`;
  if (data.cacheKey) trace += `<span>Key: <code>${esc(data.cacheKey.slice(0, 12))}...</code></span>`;
  if (data.cacheEntry) {
    trace += `<span>Stored answer: "${esc(data.cacheEntry.answer.slice(0, 60))}..."</span>`;
    trace += `<span>Asked ${data.cacheEntry.askCount}x (${data.cacheEntry.ageMs ? `${Math.round(data.cacheEntry.ageMs / 3600000)}h old` : ""})</span>`;
  }
  trace += `</div></div>`;

  // Intent gate.
  if (data.gateVerdict) {
    trace += `<div class="trace-section"><h4>Intent Gate</h4>`;
    trace += `<div class="trace-meta"><span>Verdict: <b>${esc(data.gateVerdict)}</b></span></div>`;
    trace += `</div>`;
  }

  // Query terms.
  if (data.queryTerms?.length) {
    trace += `<div class="trace-section"><h4>Query Terms</h4>`;
    trace += `<div class="trace-meta"><span>${data.queryTerms.map(esc).join(", ")}</span></div></div>`;
  }

  // Retrieved chunks.
  if (data.retrievalTrace?.length) {
    trace += `<div class="trace-section"><h4>Retrieved Chunks (${data.retrievalTrace.length})</h4>`;
    for (const c of data.retrievalTrace) {
      trace += `<div class="trace-chunk">`;
      trace += `<div class="chunk-source">${esc(c.source)}</div>`;
      if (c.heading) trace += `<div class="chunk-heading">${esc(c.heading)}</div>`;
      trace += `<div>${esc(c.snippet)}...</div>`;
      trace += `</div>`;
    }
    trace += `</div>`;
  }

  // Wrong button.
  trace += `<div class="trace-section">`;
  trace += `<button class="btn btn-ghost btn-small" onclick="document.getElementById('ask-input').value='${escJs(data.question)}';document.getElementById('ask-input').focus()">Ask again</button>`;
  trace += `</div>`;

  askTrace.innerHTML = trace;
}

/* -------------------------------------------------------- queue -- */

let queueIndex = 0;
let queueData = [];
let queueUndo = null;

async function loadQueue() {
  const data = await api("/api/queue");
  if (!data || data.error) return;
  queueData = data;
  queueIndex = Math.min(queueIndex, queueData.length - 1);
  if (queueIndex < 0) queueIndex = 0;
  renderQueue();
}

function renderQueue() {
  const list = document.getElementById("queue-list");
  const countEl = document.getElementById("queue-count");
  if (!list) return;

  if (countEl) countEl.textContent = queueData.length > 0 ? `(${queueData.length})` : "";

  if (queueData.length === 0) {
    list.innerHTML = '<div style="color:rgba(244,241,232,0.3);font-style:italic">nothing queued :yay:</div>';
    return;
  }

  let html = "";
  for (let i = 0; i < Math.min(queueData.length, 20); i++) {
    const row = queueData[i];
    const cls = i === queueIndex ? "queue-row focused" : "queue-row";
    html += `<div class="${cls}" data-idx="${i}">`;
    html += `<div class="q-question">${esc(row.question)}</div>`;
    html += `<div class="q-answer">${esc(row.answer.slice(0, 200))}${row.answer.length > 200 ? "..." : ""}</div>`;
    html += `<div class="q-meta">by ${row.authorId || "?"} · ${row.createdRelative || ""}</div>`;
    html += `</div>`;
  }

  if (queueData.length > 20) {
    html += `<div style="color:rgba(244,241,232,0.3);font-style:italic;padding:8px">+${queueData.length - 20} more</div>`;
  }

  list.innerHTML = html;
}

async function queueAction(action, id) {
  if (action === "approve") await api(`/api/queue/${id}/approve`, { method: "POST" });
  else if (action === "drop") await api(`/api/queue/${id}/drop`, { method: "POST" });
  await loadQueue();
}

function handleQueueKey(e) {
  if (queueData.length === 0) return;

  if (e.key === "j" || e.key === "ArrowDown") {
    e.preventDefault();
    queueIndex = Math.min(queueIndex + 1, queueData.length - 1);
    renderQueue();
  } else if (e.key === "k" || e.key === "ArrowUp") {
    e.preventDefault();
    queueIndex = Math.max(queueIndex - 1, 0);
    renderQueue();
  } else if (e.key === "a") {
    e.preventDefault();
    const row = queueData[queueIndex];
    if (row) {
      queueUndo = row;
      queueAction("approve", row.id);
    }
  } else if (e.key === "d") {
    e.preventDefault();
    const row = queueData[queueIndex];
    if (row) {
      queueUndo = row;
      queueAction("drop", row.id);
    }
  } else if (e.key === "e") {
    e.preventDefault();
    const row = queueData[queueIndex];
    if (row) openEditModal(row);
  } else if (e.key === "u") {
    e.preventDefault();
    if (queueUndo) {
      api("/api/teach", {
        method: "POST",
        body: JSON.stringify({ question: queueUndo.question, answer: queueUndo.answer }),
      }).then(() => loadQueue());
      queueUndo = null;
    }
  }
}

/* ---------------------------------------------------- edit modal -- */

function openEditModal(row) {
  const modal = document.getElementById("edit-modal");
  const qInput = document.getElementById("edit-question");
  const aInput = document.getElementById("edit-answer");
  if (!modal || !qInput || !aInput) return;

  qInput.value = row.question;
  aInput.value = row.answer;
  modal.classList.add("open");
  modal.dataset.id = row.id;
}

document.getElementById("edit-cancel")?.addEventListener("click", () => {
  document.getElementById("edit-modal")?.classList.remove("open");
});

document.getElementById("edit-save")?.addEventListener("click", async () => {
  const modal = document.getElementById("edit-modal");
  const q = document.getElementById("edit-question")?.value.trim();
  const a = document.getElementById("edit-answer")?.value.trim();
  const id = modal?.dataset.id;
  if (!q || !a || !id) return;

  await api(`/api/queue/${id}/drop`, { method: "POST" });
  await api("/api/teach", { method: "POST", body: JSON.stringify({ question: q, answer: a }) });
  modal?.classList.remove("open");
  await loadQueue();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.getElementById("edit-modal")?.classList.remove("open");
  }
});

/* -------------------------------------------------------- gaps -- */

let gapsTab = "docs";
let gapsData = null;

async function loadGaps() {
  gapsData = await api("/api/gaps");
  if (!gapsData || gapsData.error) return;
  renderGaps();
}

function renderGaps() {
  const content = document.getElementById("gaps-content");
  if (!content || !gapsData) return;

  const rows = gapsData.columns[gapsTab] || [];

  if (rows.length === 0) {
    content.innerHTML = '<div style="color:rgba(244,241,232,0.3);font-style:italic">nothing here</div>';
    return;
  }

  let html = "";

  if (gapsTab === "unjudged") {
    for (const row of rows) {
      html += `<div class="gap-unjudged-row">`;
      html += `<div>${esc(row.question)}</div>`;
      html += `<button class="gap-rejudge" data-id="${row.id}">re-judge</button>`;
      html += `</div>`;
    }
  } else {
    for (const row of rows) {
      html += `<div class="gap-row">`;
      html += `<span class="gap-question">${esc(row.question)}</span>`;
      html += `<span class="gap-count">${row.count}x</span>`;
      html += `<span class="gap-actions">`;
      if (gapsTab !== "docs") html += `<button class="gap-move-btn" data-id="${row.question}" data-kind="docs">→docs</button>`;
      if (gapsTab !== "transient") html += `<button class="gap-move-btn" data-id="${row.question}" data-kind="transient">→transient</button>`;
      if (gapsTab !== "noise") html += `<button class="gap-move-btn" data-id="${row.question}" data-kind="noise">→noise</button>`;
      html += `</span></div>`;
    }
  }

  content.innerHTML = html;

  // Event delegation for gap actions.
  content.querySelectorAll(".gap-move-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const question = btn.dataset.id;
      const kind = btn.dataset.kind;
      // Find the gap row(s) with this question and move each.
      // For grouped gaps, we need to move all matching rows.
      // The API uses individual gap IDs, but grouped gaps are by question text.
      // Reload unjudged separately, grouped by setGapKind on individual rows.
      await api(`/api/gaps`, { method: "PATCH", body: JSON.stringify({ id: question, kind }) });
      loadGaps();
    });
  });

  content.querySelectorAll(".gap-rejudge").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      await api(`/api/gaps/${id}/rejudge`, { method: "POST" });
      loadGaps();
    });
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    gapsTab = tab.dataset.tab;
    renderGaps();
  });
});

/* ----------------------------------------------------- silence -- */

async function loadSilence() {
  const data = await api("/api/silence");
  if (!data || data.error) return;
  const el = document.getElementById("silence-breakdown");
  if (!el) return;

  if (!data.breakdown?.length) {
    el.innerHTML = '<div style="color:rgba(244,241,232,0.3);font-style:italic">no silence data yet</div>';
    return;
  }

  let html = "";
  for (const d of data.breakdown) {
    html += `<div class="silence-reason">`;
    html += `<div class="reason-label">${esc(d.reason)}</div>`;
    html += `<div class="reason-count">${d.count}</div>`;
    html += `</div>`;
  }
  el.innerHTML = html;
}

/* -------------------------------------------------- knowledge -- */

async function loadKnowledge() {
  const data = await api("/api/knowledge");
  if (!data || data.error) return;
  const el = document.getElementById("knowledge-info");
  if (!el) return;

  let html = "";
  html += `<div class="k-row"><span class="k-label">Corpus</span><span>${data.corpusLength} chars</span></div>`;
  html += `<div class="k-row"><span class="k-label">Chunks</span><span>${data.chunkCount}</span></div>`;
  html += `<div class="k-row"><span class="k-label">Last built</span><span>${data.lastBuiltRelative}</span></div>`;
  html += `<div class="k-row"><span class="k-label">Sources</span><span>${data.sources.length}</span></div>`;

  for (const s of data.sources) {
    html += `<div class="k-row"><span class="k-label">${esc(s.name)}</span><span>${esc(s.type)}</span></div>`;
  }

  el.innerHTML = html;
}

document.getElementById("refresh-corpus")?.addEventListener("click", async () => {
  await api("/api/knowledge/refresh", { method: "POST" });
  loadKnowledge();
});

/* ----------------------------------------------------- cache -- */

async function loadCache() {
  const data = await api("/api/cache");
  if (!data || data.error) return;
  const el = document.getElementById("cache-list");
  if (!el) return;

  let html = `<div style="margin-bottom:8px;color:rgba(244,241,232,0.5);font-size:0.7rem">${data.known} known answers</div>`;

  for (const row of (data.top || []).slice(0, 10)) {
    html += `<div class="cache-row">`;
    html += `<span class="cache-q" title="${esc(row.question)}">${esc(row.question)}</span>`;
    html += `<span class="cache-count">${row.askCount}x</span>`;
    html += `</div>`;
  }

  el.innerHTML = html;
}

/* --------------------------------------------------- report -- */

async function loadReport() {
  const data = await api("/api/report?week=0");
  if (!data || data.error) return;
  const el = document.getElementById("report-content");
  if (!el) return;
  el.textContent = data.text || "no report data";
}

document.getElementById("post-report")?.addEventListener("click", async () => {
  const data = await api("/api/report/post", { method: "POST" });
  if (data?.ok) {
    document.getElementById("post-report").textContent = "Posted!";
    setTimeout(() => {
      const btn = document.getElementById("post-report");
      if (btn) btn.textContent = "Post now";
    }, 3000);
  }
});

/* ------------------------------------------------------- init -- */

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

function escJs(s) {
  return (s || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

document.addEventListener("keydown", handleQueueKey);

document.addEventListener("click", (e) => {
  const row = e.target.closest(".queue-row");
  if (row) {
    queueIndex = Number(row.dataset.idx);
    renderQueue();
  }
});

function init() {
  connectSSE();
  loadQueue();
  loadGaps();
  loadSilence();
  loadKnowledge();
  loadCache();
  loadReport();
}

init();
