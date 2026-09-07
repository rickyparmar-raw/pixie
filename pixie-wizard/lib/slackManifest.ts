// Mirrors lib/brand.js slug(): Slack rejects spaces and uppercase in command
// names, so a display name has to be slugified before it can become one. Kept in
// sync deliberately — if this diverges, the manifest and the listeners diverge.
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "pixie"
  );
}
