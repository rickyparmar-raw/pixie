// Migrate a legacy dedicated Pixie SQLite database into a shared hosted
// Core database. Idempotent: re-running skips rows that already arrived
// (tickets by (workspace, thread), facts/gaps by normalized question).
//
//   bun scripts/migrate-to-shared.js inspect --source ./legacy.db
//   bun scripts/migrate-to-shared.js export --source ./legacy.db --out ./mig.json
//   bun scripts/migrate-to-shared.js validate --source ./legacy.db --target ./pixie.db --workspace T1
//   bun scripts/migrate-to-shared.js import --source ./legacy.db --target ./pixie.db --workspace T1 [--live]
//   bun scripts/migrate-to-shared.js verify --target ./pixie.db
//   bun scripts/migrate-to-shared.js cutover --target ./pixie.db --program hwy
//   bun scripts/migrate-to-shared.js rollback --target ./pixie.db --backup ./pixie.db.bak-20240101
//
// Imports land in shadow mode unless --live: the shared Core evaluates but
// sends nothing until explicit cutover, so the legacy bot never double-replies.
// Never shuts anything down; cutover flips one flag after YOU stop legacy.
const { Database } = require("bun:sqlite");
const fs = require("fs");

function args() {
  const out = { _: [] };
  const raw = process.argv.slice(2);
  let i = 0;
  while (i < raw.length) {
    const a = raw[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 2;
      } else {
        out[key] = true;
        i += 1;
      }
    } else {
      out._.push(a);
      i += 1;
    }
  }
  return out;
}

function open(path, readonly = false) {
  if (!fs.existsSync(path)) throw new Error(`database not found: ${path}`);
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function tables(db) {
  return new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

function count(db, table, where = "", ...params) {
  if (!tables(db).has(table)) return 0;
  return db.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params).n;
}

function norm(q) {
  return String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function inspect(source) {
  const db = open(source, true);
  const progs = tables(db).has("programs")
    ? db.query("SELECT id, name, help_channel, channels FROM programs").all()
    : [];
  console.log(JSON.stringify({
    source,
    programs: progs,
    approvedFacts: count(db, "learned_facts", "WHERE status = 'approved'"),
    pendingFacts: count(db, "learned_facts", "WHERE status = 'pending'"),
    docGaps: count(db, "doc_gaps"),
    tickets: count(db, "tickets"),
    sourceCache: count(db, "source_cache"),
  }, null, 2));
  db.close();
}

function collect(source) {
  const db = open(source, true);
  const t = tables(db);
  const data = { version: 1, exportedAt: new Date().toISOString(), programs: [], facts: [], gaps: [], tickets: [], events: [], notes: [] };
  if (t.has("programs")) {
    data.programs = db.query("SELECT * FROM programs").all().map((r) => ({
      id: r.id,
      name: r.name,
      posture: r.posture || "active",
      scope: r.scope || "program",
      helpChannel: r.help_channel,
      channels: r.channels ? JSON.parse(r.channels) : [],
      helperGroup: r.helper_group,
      sources: r.sources ? JSON.parse(r.sources) : [],
      milestones: r.milestones ? JSON.parse(r.milestones) : [],
      guides: r.guides ? JSON.parse(r.guides) : [],
      links: r.links ? JSON.parse(r.links) : {},
    }));
  }
  if (t.has("learned_facts")) {
    data.facts = db.query("SELECT question, answer, author_id, status, source_ts, channel, program_id, category FROM learned_facts WHERE status IN ('approved','pending')").all();
  }
  if (t.has("doc_gaps")) {
    const cols = db.query("PRAGMA table_info(doc_gaps)").all().map((c) => c.name);
    const prog = cols.includes("program_id") ? ", program_id" : "";
    data.gaps = db.query(`SELECT question, user_id, channel, message_ts ${prog}, created_at FROM doc_gaps`).all();
  }
  if (t.has("tickets")) {
    data.tickets = db.query("SELECT * FROM tickets").all();
    if (t.has("ticket_events")) data.events = db.query("SELECT * FROM ticket_events").all();
    if (t.has("ticket_notes")) data.notes = db.query("SELECT * FROM ticket_notes").all();
  }
  db.close();
  return data;
}

function validateTarget(target, workspace, data) {
  const db = open(target);
  const issues = [];
  const existingPrograms = new Set(db.query("SELECT id FROM programs").all().map((r) => r.id));
  for (const p of data.programs) {
    if (existingPrograms.has(p.id)) issues.push(`program ${p.id} already exists in target (will merge, not duplicate)`);
    const channels = [...(p.helpChannel ? [p.helpChannel] : []), ...(p.channels || [])];
    for (const ch of channels) {
      const owner = tables(db).has("program_channels")
        ? db.query("SELECT program_id FROM program_channels WHERE workspace_id = ? AND channel_id = ?").get(workspace, ch)
        : null;
      if (owner && owner.program_id !== p.id) issues.push(`channel ${ch} owned by ${owner.program_id} — claim would fail`);
    }
    for (const ticket of data.tickets.filter((x) => (x.program_id || p.id) === p.id)) {
      const clash = db.query("SELECT id FROM tickets WHERE thread_ts = ? AND (workspace_id = ? OR workspace_id IS NULL) LIMIT 1").get(ticket.thread_ts, workspace);
      if (clash) issues.push(`ticket thread ${ticket.thread_ts} already in target as #${clash.id} (will skip)`);
    }
  }
  db.close();
  return issues;
}

function importData(target, workspace, data, { live = false } = {}) {
  // The target may predate hosted columns; migrate it in place first. This
  // never wipes caches or starts background work — see ensureSchema.
  require("../lib/db").ensureSchema(target);
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "")}`;
  {
    const tmp = open(target);
    tmp.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    tmp.close();
  }
  console.log(`target backed up to ${backup}`);
  const db = open(target);
  const now = Date.now();
  const summary = { programs: 0, claims: 0, facts: 0, gaps: 0, tickets: 0, events: 0, notes: 0, skippedTickets: 0 };
  const ticketIdMap = new Map();
  const tx = db.transaction(() => {
    for (const p of data.programs) {
      const exists = db.query("SELECT 1 FROM programs WHERE id = ?").get(p.id);
      const row = {
        name: p.name, posture: p.posture, scope: p.scope, workspace_id: workspace,
        deployment_mode: "hosted_shared", support_name: null, icon_url: null,
        ai_answers: 1, tickets_enabled: 1, auto_escalate: 1, sensitive_categories: null,
        support_active: 1, auto_assign: 0, shadow_mode: live ? 0 : 1,
        help_channel: p.helpChannel || null, channels: p.channels ? JSON.stringify(p.channels) : null,
        helper_group: p.helperGroup || null, sources: p.sources ? JSON.stringify(p.sources) : null,
        milestones: p.milestones ? JSON.stringify(p.milestones) : null,
        guides: p.guides ? JSON.stringify(p.guides) : null, links: p.links ? JSON.stringify(p.links) : null,
        sla_unassigned_ms: null, sla_assigned_ms: null, sla_waiting_ms: null, sla_target_ms: null, sla_notify_channel: null,
        retention_context_days: null, retention_tickets_days: null, retention_notes_days: null,
        retention_traces_days: null, retention_analytics_days: null, retention_audit_days: null,
        updated_at: now,
      };
      const cols = Object.keys(row);
      if (exists) {
        db.query(`UPDATE programs SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => row[c]), p.id);
      } else {
        db.query(`INSERT INTO programs (id, ${cols.join(", ")}, created_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?)`)
          .run(p.id, ...cols.map((c) => row[c]), now);
      }
      summary.programs += 1;
      const channels = [...(p.helpChannel ? [{ id: p.helpChannel, kind: "help" }] : []), ...(p.channels || []).filter((c) => c !== p.helpChannel).map((c) => ({ id: c, kind: "discussion" }))];
      for (const ch of channels) {
        const r = db.query("INSERT OR IGNORE INTO program_channels (workspace_id, channel_id, program_id, kind, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(workspace, ch.id, p.id, ch.kind, now);
        summary.claims += r.changes;
      }
    }
    for (const f of data.facts) {
      const q = norm(f.question);
      const dupe = db.query("SELECT 1 FROM learned_facts WHERE (program_id = ? OR (program_id IS NULL AND ? IS NULL)) AND LOWER(TRIM(question)) = ? LIMIT 1").get(f.program_id, f.program_id, q);
      if (dupe) continue;
      db.query("INSERT INTO learned_facts (question, answer, author_id, status, source_ts, channel, program_id, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(f.question, f.answer, f.author_id, f.status, f.source_ts, f.channel, f.program_id, f.category || null, now);
      summary.facts += 1;
    }
    for (const g of data.gaps) {
      const dupe = db.query("SELECT 1 FROM doc_gaps WHERE (program_id = ? OR (program_id IS NULL AND ? IS NULL)) AND LOWER(TRIM(question)) = ? AND user_id IS ? LIMIT 1").get(g.program_id || null, g.program_id || null, norm(g.question), g.user_id);
      if (dupe) continue;
      db.query("INSERT INTO doc_gaps (question, user_id, channel, message_ts, program_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(norm(g.question), g.user_id, g.channel, g.message_ts, g.program_id || null, g.created_at || now);
      summary.gaps += 1;
    }
    for (const t of data.tickets) {
      const clash = db.query("SELECT id FROM tickets WHERE thread_ts = ? AND (workspace_id = ? OR workspace_id IS NULL) LIMIT 1").get(t.thread_ts, workspace);
      if (clash) {
        ticketIdMap.set(t.id, clash.id);
        summary.skippedTickets += 1;
        continue;
      }
      const r = db.query(
        `INSERT INTO tickets (program_id, workspace_id, channel, thread_ts, card_ts, requester_id, question, category, priority, summary, status, assignee_id, resolution, created_at, claimed_at, resolved_at, reopen_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(t.program_id, workspace, t.channel, t.thread_ts, t.card_ts || null, t.requester_id, t.question,
        t.category || null, t.priority || null, t.summary || null, t.status || "open", t.assignee_id || null,
        t.resolution || null, t.created_at || now, t.claimed_at || null, t.resolved_at || null, t.reopen_count || 0, now);
      ticketIdMap.set(t.id, Number(r.lastInsertRowid));
      summary.tickets += 1;
    }
    for (const e of data.events) {
      const nid = ticketIdMap.get(e.ticket_id);
      if (!nid) continue;
      db.query("INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(nid, e.program_id, e.actor_id || null, e.event_type, e.detail || null, e.created_at || now);
      summary.events += 1;
    }
    for (const n of data.notes) {
      const nid = ticketIdMap.get(n.ticket_id);
      if (!nid) continue;
      db.query("INSERT INTO ticket_notes (ticket_id, program_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(nid, n.program_id, n.author_id, n.body, n.created_at || now);
      summary.notes += 1;
    }
  });
  tx();
  db.close();
  return summary;
}

async function main() {
  const a = args();
  const cmd = a._[0];
  try {
    if (cmd === "inspect") {
      inspect(a.source);
    } else if (cmd === "export") {
      const data = collect(a.source);
      const out = JSON.stringify(data, null, 2);
      if (a.out) fs.writeFileSync(a.out, out);
      else console.log(out);
      console.error(`exported ${data.programs.length} programs, ${data.facts.length} facts, ${data.gaps.length} gaps, ${data.tickets.length} tickets`);
    } else if (cmd === "validate") {
      const data = collect(a.source);
      const issues = validateTarget(a.target, a.workspace || "default", data);
      console.log(issues.length === 0 ? "VALID: no conflicts" : `ISSUES:\n- ${issues.join("\n- ")}`);
      if (issues.length > 0 && !a["dry-run"]) process.exitCode = 2;
    } else if (cmd === "import") {
      const data = a.file ? JSON.parse(fs.readFileSync(a.file, "utf8")) : collect(a.source);
      const summary = importData(a.target, a.workspace || "default", data, { live: !!a.live });
      console.log(JSON.stringify({ summary, mode: a.live ? "live" : "shadow" }, null, 2));
    } else if (cmd === "verify") {
      const db = open(a.target, true);
      console.log(JSON.stringify({
        integrity: db.query("PRAGMA integrity_check").get(),
        programs: count(db, "programs"),
        claims: count(db, "program_channels"),
        approvedFacts: count(db, "learned_facts", "WHERE status = 'approved'"),
        candidates: count(db, "learned_facts", "WHERE status = 'candidate'"),
        tickets: count(db, "tickets"),
        shadowPrograms: count(db, "programs", "WHERE shadow_mode = 1"),
      }, null, 2));
      db.close();
    } else if (cmd === "cutover") {
      const db = open(a.target);
      const row = db.query("SELECT shadow_mode FROM programs WHERE id = ?").get(a.program);
      if (!row) throw new Error(`program ${a.program} not found in target`);
      db.query("UPDATE programs SET shadow_mode = 0, updated_at = ? WHERE id = ?").run(Date.now(), a.program);
      db.query("INSERT INTO audit_events (program_id, actor_id, action, entity_type, entity_id, created_at) VALUES (?, ?, 'program.cutover', 'program', ?, ?)")
        .run(a.program, null, a.program, Date.now());
      console.log(`program ${a.program} is LIVE (shadow off). Stop the legacy bot now if you have not already.`);
      db.close();
    } else if (cmd === "rollback") {
      if (!a.backup || !a.target) throw new Error("rollback needs --backup and --target; stop Core first");
      fs.copyFileSync(a.backup, a.target);
      const db = open(a.target, true);
      const integrity = db.query("PRAGMA integrity_check").get();
      db.close();
      console.log(JSON.stringify({ restored: a.target, integrity }));
    } else {
      console.error("usage: migrate-to-shared.js <inspect|export|validate|import|verify|cutover|rollback> [options]");
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`failed: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
