const knowledge = require("./knowledge");
const cache = require("./cache");
const db = require("./db");
const log = require("./log");
const lookup = require("./lookup");

const CYCLE_MS = 5 * 60 * 1000;
const PER_CYCLE = 4;
const SPACING_MS = 8000;

let timer: ReturnType<typeof setInterval> | null = null;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function warmOne(question: string, { refreshed = false }: { refreshed?: boolean } = {}) {
  const result = await lookup.answerOrChat(question, "");
  if (!result?.source) return false;

  if (refreshed) cache.put(question, result, { refreshed: true });
  return true;
}

function faqQuestions(): string[] {
  return knowledge
    .faqQuestions()
    .map((q: string) => (q || "").trim())
    .filter(Boolean);
}

async function warmFaq({ limit = 2, spacingMs = 15000 }: { limit?: number; spacingMs?: number } = {}) {
  const questions = faqQuestions().filter((q) => !cache.get(q)).slice(0, limit);
  if (questions.length === 0) {
    log.debug("warm", "faq already warm");
    return 0;
  }

  log.info("warm", `pre-warming ${questions.length} FAQ question(s)`);
  let warmed = 0;
  for (const question of questions) {
    try {
      if (await warmOne(question)) warmed += 1;
    } catch (error: unknown) {
      log.debug("warm", `could not pre-warm "${question.slice(0, 40)}": ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(spacingMs);
  }

  log.info("warm", `pre-warmed ${warmed}/${questions.length} FAQ answers`);
  return warmed;
}

async function refreshStale({ limit = PER_CYCLE, spacingMs = SPACING_MS }: { limit?: number; spacingMs?: number } = {}) {
  const stale = cache.staleCacheEntries(db.CACHE_FRESH_MS, limit);
  if (stale.length === 0) return 0;

  let refreshed = 0;
  for (const entry of stale) {
    try {
      if (await warmOne(entry.question, { refreshed: true })) {
        refreshed += 1;
        log.debug("warm", `refreshed "${entry.question.slice(0, 40)}" (asked ${entry.ask_count}x)`);
      }
    } catch (error: unknown) {
      log.debug("warm", `could not refresh "${entry.question.slice(0, 40)}": ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(spacingMs);
  }

  if (refreshed > 0) log.info("warm", `refreshed ${refreshed} cached answer(s)`);
  return refreshed;
}

function start({ cycleMs = CYCLE_MS }: { cycleMs?: number } = {}) {
  if (timer) return timer;

  warmFaq().catch((error: unknown) => log.error("warm", "faq pre-warm failed:", error instanceof Error ? error.message : String(error)));

  timer = setInterval(() => {
    refreshStale().catch((error: unknown) => log.error("warm", "refresh pass failed:", error instanceof Error ? error.message : String(error)));
  }, cycleMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export = { start, stop, warmFaq, refreshStale, warmOne, faqQuestions, CYCLE_MS, PER_CYCLE, SPACING_MS };
