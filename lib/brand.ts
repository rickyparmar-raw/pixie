const DEFAULT_NAME = "pixie";

const DEFAULT_SLUG = "pixie";

const NON_SLUG_CHARS = /[^a-z0-9-]+/g;
const EDGE_DASHES = /^-+|-+$/g;

function envValue(name: string): string | null {
  return (process.env[name] || "").trim();
}

function name() {
  return envValue("PIXIE_BOT_NAME") || DEFAULT_NAME;
}

function rawSlug() {
  return envValue("PIXIE_BOT_SLUG") || envValue("PIXIE_BOT_NAME") || DEFAULT_SLUG;
}

function slug() {
  const cleaned = rawSlug().toLowerCase().replace(NON_SLUG_CHARS, "-").replace(EDGE_DASHES, "");

  return cleaned || DEFAULT_SLUG;
}

function cmd(suffix: string = ""): string {
  return suffix ? `/${slug()}-${suffix}` : `/${slug()}`;
}

function id(suffix: unknown) {
  return `${slug().replace(/-/g, "_")}_${suffix}`;
}

export = { name, slug, cmd, id, DEFAULT_NAME, DEFAULT_SLUG };
