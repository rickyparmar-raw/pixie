import { test, expect } from "@playwright/test";

const routes = [
  ["landing", "/"],
  ["wizard", "/wizard?mode=hosted"],
  ["overview", "/overview"],
  ["programs", "/programs"],
  ["program", "/programs/visual-program"],
  ["settings", "/programs/visual-program/settings"],
  ["tickets", "/programs/visual-program/tickets"],
  ["knowledge", "/programs/visual-program/knowledge"],
  ["gaps", "/programs/visual-program/gaps"],
  ["macros", "/programs/visual-program/macros"],
  ["helpers", "/programs/visual-program/helpers"],
  ["people", "/programs/visual-program/people"],
  ["analytics", "/programs/visual-program/analytics"],
  ["usage", "/programs/visual-program/usage"],
  ["incidents", "/programs/visual-program/incidents"],
  ["audit", "/programs/visual-program/audit"],
  ["radar", "/programs/visual-program/radar"],
  ["retention", "/programs/visual-program/retention"],
] as const;

const FROZEN_TIME_MS = Date.parse("2026-01-15T10:00:00.000Z");

for (const [name, route] of routes) {
  test(`${name} route has a stable screenshot baseline`, async ({ page }, testInfo) => {
    const theme = testInfo.project.use.colorScheme === "dark" ? "dark" : "light";
    await page.addInitScript(({ theme, frozenTime }) => {
      localStorage.setItem("pixie-theme", theme);
      const RealDate = Date;
      globalThis.Date = class extends RealDate {
        constructor(value?: string | number) {
          super(value === undefined ? frozenTime : value);
        }
        static now() {
          return frozenTime;
        }
      } as unknown as DateConstructor;
    }, { theme, frozenTime: FROZEN_TIME_MS });
    await page.goto(route, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts?.ready);
    // Fail loudly on auth redirects instead of screenshotting the login page.
    await expect(page).not.toHaveURL(/\/api\/auth\/login/, { timeout: 5000 }).catch(() => {
      throw new Error(`visual route ${route} redirected to login; is the auth setup project running and dev-login reachable?`);
    });
    // Fail loudly on an unseeded database instead of baselining empty states.
    if (route === "/programs" || route.startsWith("/programs/visual-program")) {
      await expect(page.getByText("Visual Program").first()).toBeVisible({ timeout: 10000 });
    }
    await expect(page).toHaveScreenshot(`${name}.png`, { animations: "disabled", caret: "hide", scale: "css" });
  });
}
