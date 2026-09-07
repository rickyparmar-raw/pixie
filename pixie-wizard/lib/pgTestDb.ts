// In-memory Postgres double for tests (replaces the old Supabase fake).
// pg-mem emulates real Postgres SQL — constraints, jsonb, transactions,
// error codes (23505 for unique_violation) — closely enough that the exact
// SQL in lib/hostedPrograms.ts and lib/programClaim.ts runs against it
// unmodified. Every test file needing "@/lib/db" MUST register its own
// fresh instance via mock.module — bun applies module mocks process-wide,
// so two test files sharing one instance would see each other's rows (the
// supabaseFake.ts lesson, carried forward).
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import type { PoolClient } from "pg";

// Resolved from this file's own location, not process.cwd() — bun test can
// run from the monorepo root (recursing into this package) as easily as
// from here directly, and cwd differs between those.
const moduleDir = fileURLToPath(new URL(".", import.meta.url));

export interface TestDb {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  isUniqueViolation: (err: unknown) => boolean;
}

export function createTestDb(): TestDb {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.registerExtension("pgcrypto", (schema) => {
    schema.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, implementation: randomUUID, impure: true });
  });
  const schemaSql = readFileSync(join(moduleDir, "..", "db", "schema.sql"), "utf8");
  mem.public.none(schemaSql);

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  return {
    query: async (text, params = []) => {
      const res = await pool.query(text, params);
      return { rows: res.rows };
    },
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client as unknown as PoolClient);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => null);
        throw err;
      } finally {
        client.release();
      }
    },
    isUniqueViolation: (err) => !!err && typeof err === "object" && (err as { code?: string }).code === "23505",
  };
}
