"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "./icons";

// Night is the product's default palette, so "no stored preference" resolves to
// dark — there is no `prefers-color-scheme` branch, and no flash of the wrong
// theme either: layout.tsx stamps data-theme from localStorage before paint,
// and this component only mirrors that stamp into React state.

type Theme = "light" | "dark";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  // The sprite names the theme you are IN, not the one you would switch to: a
  // crescent reads as "night" at 16px, while the sun sprite is a small disc
  // ringed by hard pixels that sits next to Settings and the incidents bell as
  // a fourth gear. The button's label still names the ACTION ("Switch to light
  // mode"), so state and affordance never contradict each other.
  //
  // Until the effect has read the stamp, fall back to night: it is the default
  // palette, so the server HTML and the first client render already agree —
  // crescent + "Switch to light mode" — and nothing has to be patched. Reading
  // the attribute in a state initialiser instead would put "light" in the server
  // HTML of a day-theme page, which React would then have to patch — or, with
  // suppressHydrationWarning, leave showing the wrong icon all day.
  const active: Theme = theme ?? "dark";

  function toggle() {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem("pixie-theme", next);
    } catch {
      // Storage blocked: the stamp still applies for this page view.
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={active === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className={`pixie-icon-button ${className}`}
    >
      {active === "dark" ? <IconMoon size={16} /> : <IconSun size={16} />}
    </button>
  );
}
