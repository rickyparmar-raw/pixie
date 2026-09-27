import fs = require("node:fs");
import path = require("node:path");

function readSource(relativePath: string): string {
  const base = path.join(__dirname, relativePath.replace(/\.(?:js|ts)$/, ""));
  for (const ext of [".ts", ".js"]) {
    if (fs.existsSync(base + ext)) return fs.readFileSync(base + ext, "utf8");
  }
  throw new Error(`no source for ${relativePath}`);
}

export = { readSource };
