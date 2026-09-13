// Chunk stage: raw sections -> bounded, headed, domain-tagged chunks.
// Chunks below MIN read as fragments with no context; above MAX they stop being
// selective, which is the problem being solved. Prose paragraphs in the Pixl
// docs sit comfortably inside this band.
const MIN_CHUNK = 100;
const MAX_CHUNK = 900;

const SOFTWARE_TERMS = new Set([
  "software", "code", "coding", "repo", "github", "app", "website", "web",
  "frontend", "backend", "script", "npm", "deploy", "hosting", "git",
  "python", "javascript", "typescript", "html", "css", "api", "cli",
  "library", "bot", "pr", "commit", "developer", "browser", "extension"
]);

const HARDWARE_TERMS = new Set([
  "hardware", "pcb", "circuit", "wiring", "wire", "cad", "schematic",
  "breadboard", "soldering", "gerber", "component", "3d", "kicad",
  "step", "stl", "electronics", "enclosure", "bom", "resistor",
  "microcontroller", "devboard", "macropad", "fusion360", "easyeda"
]);

function detectDomain(text) {
  const lowered = String(text || "").toLowerCase();
  const hasHardware =
    /\b(?:hardware|pcb|wiring\s+diagram|gerber|breadboard|soldering|schematic|cad\b|3d\s+model|\.step\b|\.stl\b|kicad|easyeda|devboard|macropad|circuit|resistor)\b/i.test(lowered);
  const hasSoftware =
    /\b(?:software|web\s+app|website|mobile\s+app|playable\s+url|browser\s+extension|frontend|backend|npm|pypi|github\s+repo)\b/i.test(lowered);

  if (hasHardware && !hasSoftware) return "hardware";
  if (hasSoftware && !hasHardware) return "software";
  return "general";
}

// Splits on blank lines first, then merges neighbours that are too small to
// stand alone. Markdown headings start a new chunk and are repeated into it, so
// a chunk retrieved on its own still says what it is about.
function chunkSection(name, rawText) {
  const normalized = String(rawText || "")
    .replace(/([^\n])\n(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/([.?!])\n([A-Z0-9*-])/g, "$1\n\n$2")
    .trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let heading = null;
  let buffer = "";

  const flush = () => {
    const body = buffer.trim();
    buffer = "";
    if (!body) return;
    const alreadyHasHeading = heading && (body.startsWith(heading) || body.startsWith("#") || body.includes(heading));
    const fullText = heading && !alreadyHasHeading ? `${heading}\n${body}` : body;
    chunks.push({
      source: name,
      heading,
      domain: detectDomain(fullText),
      text: fullText,
    });
  };

  for (const paragraph of paragraphs) {
    const headingMatch = paragraph.match(/^#{1,6}\s+(.+)$/m);
    // A heading starts a new chunk when it opens the paragraph.
    if (headingMatch && paragraph.startsWith("#")) {
      flush();
      heading = headingMatch[1].trim();
    }

    // Something far past the cap on its own can't be merged into anything; split
    // it on sentence ends or line breaks so no chunk is cut mid-thought.
    if (paragraph.length > MAX_CHUNK) {
      flush();
      let piece = "";
      for (const sentence of paragraph.split(/(?<=[.!?])\s+|\n+/)) {
        if (piece && piece.length + sentence.length > MAX_CHUNK) {
          buffer = piece;
          flush();
          piece = "";
        }
        piece = piece ? `${piece}\n${sentence}` : sentence;
      }
      buffer = piece;
      flush();
      continue;
    }

    // Avoid clumping distinct paragraphs:
    // If buffer already holds a complete thought (not an introductory lead-in ending with a colon),
    // or if merging would cross domain boundaries (software vs hardware),
    // flush the buffer first so each distinct paragraph stands on its own.
    if (buffer && shouldFlushBeforeMerge(buffer, paragraph)) {
      flush();
    }

    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > MAX_CHUNK) {
      flush();
      buffer = paragraph;
    } else {
      buffer = candidate;
      const isLeadIn = /:\s*$/.test(buffer);
      if (!isLeadIn && buffer.length >= MIN_CHUNK) {
        flush();
      }
    }
  }

  flush();
  return chunks;
}

function shouldFlushBeforeMerge(buffer, paragraph) {
  const bufDomain = detectDomain(buffer);
  const paraDomain = detectDomain(paragraph);
  const domainConflict =
    (bufDomain === "software" && paraDomain === "hardware") ||
    (bufDomain === "hardware" && paraDomain === "software");
  if (domainConflict) return true;
  if (/:\s*$/.test(buffer)) return false;
  if (/[.?!]\s*$/.test(buffer) && buffer.length >= 60) return true;
  return buffer.length + paragraph.length > MAX_CHUNK;
}

function chunkSections(sections) {
  return sections.flatMap(([name, text]) => chunkSection(name, text));
}

module.exports = {
  MIN_CHUNK,
  MAX_CHUNK,
  SOFTWARE_TERMS,
  HARDWARE_TERMS,
  detectDomain,
  chunkSection,
  chunkSections,
  shouldFlushBeforeMerge,
};
