import fs = require("node:fs");
import path = require("node:path");

// Some tests pin wiring by reading a module's source. Modules move from .js
// to .ts one at a time, so look for either.
function readSource(relativePath: string): string {
  const base = path.join(__dirname, relativePath.replace(/\.(?:js|ts)$/, ""));
  for (const ext of [".ts", ".js"]) {
    if (fs.existsSync(base + ext)) return fs.readFileSync(base + ext, "utf8");
  }
  throw new Error(`no source for ${relativePath}`);
}

export = { readSource };
