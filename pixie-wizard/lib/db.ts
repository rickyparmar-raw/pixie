// Postgres control-plane database (replaces the old Supabase client). Every
// hosted-program read/write goes through this pool. There is no PostgREST/
// anon layer any more — this connects with one full-access role, and every
// query is written and parameterized here in application code, so tenant
// isolation lives entirely in the WHERE clauses and the callers that build
// them (see lib/hostedPrograms.ts, lib/programClaim.ts, and the ownership
// checks in app/wizard/hostedActions.ts), never in database-side policies.
import { Pool, type QueryResultRow } from "pg";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// Created on first use, not at import time — Next evaluates this module
// while prerendering static pages where env vars may be absent.
let _pool: Pool | null = null;
let _localPool: ReturnType<ReturnType<typeof newDb>["adapters"]["createPg"]>["Pool"] | null = null;

function localPool() {
  if (!_localPool) {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    memory.registerExtension("pgcrypto", (schema) => {
      schema.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, implementation: randomUUID, impure: true });
    });
    memory.public.none(readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8"));
    const { Pool: MemoryPool } = memory.adapters.createPg();
    _localPool = new MemoryPool();
  }
  return _localPool;
}

function pool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") return localPool() as unknown as Pool;
    _pool = new Pool({
      connectionString: required("DATABASE_URL"),
      // Railway's private-network Postgres doesn't need or support TLS; a
      // public DATABASE_URL (e.g. local dev via the public proxy) does.
      ssl: /sslmode=require/.test(process.env.DATABASE_URL || "") ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    _pool.on("error", (err) => {
      console.warn("[wizard/db] idle client error:", err.message);
    });
  }
  return _pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[] }> {
  const res = await pool().query<T>(text, params);
  return { rows: res.rows };
}

// For call sites that need an explicit transaction (claim-then-insert races).
export async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

// Postgres unique_violation. Callers translate this into a friendly message
// the same way the old Supabase code checked error.code === "23505".
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}
