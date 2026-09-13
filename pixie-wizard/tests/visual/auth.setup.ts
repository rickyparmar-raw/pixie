import { test as setup } from "@playwright/test";

// One-time deterministic login for the visual matrix. Runs before the
// screenshot projects (see playwright.config.ts) and stores the resulting
// session so every screenshot test opens routes as an authenticated member
// instead of screenshotting login redirects.
setup("authenticate visual user", async ({ page, context }) => {
  await page.goto("/api/auth/dev-login");
  await page.waitForURL(/\/wizard(\?|$)/, { timeout: 15000 });
  await context.storageState({ path: "tests/visual/.auth.json" });
});
