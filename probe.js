process.env.PIXIE_DB_PATH = ":memory:";
const db = require("./lib/db");
db.open(":memory:");

for (const u of ["U1", "U2", "U3"]) db.recordGap("HOW do i Submit   my project", u, "C1");
db.recordGapRejection("how do i submit my project");

const rej = db.handle().query("SELECT question FROM gap_rejections").all();
process.stdout.write("REJ=" + JSON.stringify(rej) + "\n");

const probe = db.handle().query(
  "SELECT LOWER(TRIM(REPLACE(REPLACE(question, X'09', X'20'), X'0A', X'20'))) AS q, COUNT(*) AS c FROM doc_gaps GROUP BY q"
).all();
process.stdout.write("PROBE=" + JSON.stringify(probe) + "\n");

const top = db.topGaps(10);
process.stdout.write("TOP=" + top.length + " q=" + top.map((g) => g.question).join("|") + "\n");

// Show what the SQL inside topGaps actually normalized to
const full = db.handle().query(
  "SELECT LOWER(TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(question, X'09', X'20'), X'0A', X'20'), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '))) AS q, COUNT(*) AS c FROM doc_gaps GROUP BY q"
).all();
process.stdout.write("FULL=" + JSON.stringify(full) + "\n");
