import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(root, "..", "db", "migrations");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: /sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
});

try {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`create table if not exists wizard_schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
    const applied = new Set((await client.query("select version from wizard_schema_migrations")).rows.map((row) => row.version));
    const files = (await readdir(migrationDir)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(path.join(migrationDir, file), "utf8"));
      await client.query("insert into wizard_schema_migrations (version) values ($1)", [file]);
      console.log(`applied ${file}`);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
