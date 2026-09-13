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

for (const [name, route] of routes) {
  test(`${name} route has a stable screenshot baseline`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("pixie-theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    });
    await page.goto(route, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts?.ready);
    await expect(page).toHaveScreenshot(`${name}.png`, { animations: "disabled", caret: "hide", scale: "css" });
  });
}
