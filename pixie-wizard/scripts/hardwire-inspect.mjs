// READ-ONLY inspection of control-plane Postgres before the Hardwire onboarding.
import { Pool } from "pg";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const pool = new Pool({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
const q = (t, p = []) => pool.query(t, p).then((r) => r.rows);
const HARDWIRE_CHANNELS = ["C0BK9C320KH", "C0BV468JJMV", "C0BF8115UJK", "C0BKNPFMK54"];

for (const tbl of ["hosted_programs", "hosted_program_channels", "hosted_program_helpers", "hosted_audit_events"]) {
  const cols = await q(
    `select column_name, data_type, column_default, is_nullable from information_schema.columns where table_name = $1 order by ordinal_position`,
    [tbl],
  );
  console.log(`\n=== columns: ${tbl} ===`);
  console.table(cols);
}

console.log("\n=== hosted_programs rows (all cols) ===");
console.log(JSON.stringify(await q(`select * from hosted_programs order by created_at`), null, 2));

console.log("\n=== channel claims (workspace T0266FRGM or Hardwire channels) ===");
console.table(
  await q(
    `select workspace_id, channel_id, program_id, kind, claimed_by_hca_id from hosted_program_channels where channel_id = any($1) or workspace_id = 'T0266FRGM' order by program_id, kind`,
    [HARDWIRE_CHANNELS],
  ),
);

console.log("\n=== helpers ===");
console.table(await q(`select program_id, slack_user_id, role, helper_source, active from hosted_program_helpers order by program_id, role`));

await pool.end();
