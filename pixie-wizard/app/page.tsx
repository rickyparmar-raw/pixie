"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// Marketing home. Ported from the Claude Design canvas (pixie-landing-prototype).
// This is a committed light-mode brand artifact — like most marketing pages, it
// does not follow the dashboard's dark/light toggle. Wired to the real Slack
// OAuth entry points (`/api/auth/login`, `/api/auth/dev-login`) so the CTAs
// actually take a visitor into the product, not back to `/`.
//
// Two layouts live in this file: the pixel-precise desktop composition
// (`Hero` / `HowItWorks` / `ClosingCta`, hidden below `lg`) and a plain
// normal-flow mobile layout (`MobileLanding`, hidden at `lg` and up) — the
// fixed 1920px canvas does not reflow, so phones get a fresh, simple layout
// with the same copy and colors instead of a shrunk, unusable version of it.

const HEAD_FONT = "var(--font-heading), 'Poppins', -apple-system, BlinkMacSystemFont, sans-serif";
const SCRIBBLE_FONT = "'Architects Daughter', cursive";
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080 + 1600 + 420;
const LOGIN_HREF = "/api/auth/login";

function useScale() {
  // Always starts at 1 so the client's first render matches the server-
  // rendered HTML exactly (Next prerenders this page); the effect corrects
  // it to the real viewport width immediately after mount.
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const update = () => setScale(window.innerWidth / DESIGN_WIDTH);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return scale;
}

const smooth = (p: number) => p * p * (3 - 2 * p);

function reveal(progress: number, threshold: number, span = 0.09) {
  const local = Math.max(0, Math.min(1, (progress - threshold) / span));
  const eased = smooth(local);
  return { opacity: eased, offset: (1 - eased) * 26 };
}

function useSectionProgress() {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setProgress(1);
      return;
    }
    let raf: number | null = null;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        const total = rect.height + vh * 0.55;
        const p = (vh - rect.top) / total;
        setProgress(Math.max(0, Math.min(1, p)));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return [ref, progress] as const;
}

function Arrow({ color }: { color?: string }) {
  return (
    <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true" style={{ flex: "none" }}>
      <path d="M1 6H15M10 1.5L15.2 6L10 10.5" fill="none" stroke={color ?? "currentColor"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Slack({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
      <g fill="#36C5F0"><rect x="6.9" width="4.8" height="5" rx="2.4" /><rect x="6.9" y="2.6" width="2.4" height="2.4" /><rect y="5.9" width="11.7" height="5.1" rx="2.55" /></g>
      <g fill="#2EB67D"><rect x="12.8" width="5.1" height="11.4" rx="2.55" /><rect x="19.1" y="6.1" width="4.9" height="5" rx="2.45" /><rect x="19.1" y="6.1" width="2.45" height="2.45" /></g>
      <g fill="#E01E5A"><rect y="12.5" width="4.9" height="5.1" rx="2.45" /><rect x="2.45" y="12.5" width="2.45" height="2.45" /><rect x="6.1" y="12.5" width="5.1" height="11.1" rx="2.55" /></g>
      <g fill="#ECB22E"><rect x="12.3" y="12.5" width="11.7" height="5.1" rx="2.55" /><rect x="12.3" y="18.5" width="5.1" height="5.1" rx="2.55" /><rect x="12.3" y="18.5" width="2.55" height="2.55" /></g>
    </svg>
  );
}

function Doc({ color = "#1a1a1a", size = 19 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size * (22 / 19)} viewBox="0 0 18 22" aria-hidden="true" style={{ flex: "none" }}>
      <path d="M2 1.2h8.2L16 6.8v14H2zM10.2 1.4v5.6H15.8" fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function Check({ stroke = "#0D2114", size = 20 }: { stroke?: string; size?: number }) {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 20 16" aria-hidden="true">
      <path d="M2 8.4L7.2 13.5L18 2.6" fill="none" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HeroBackdrop() {
  return (
    <svg width="1672" height="941" viewBox="0 0 1672 941" style={{ position: "absolute", top: 0, left: 0 }} aria-hidden="true">
      <path d="M1600 -30 C1500 40 1560 130 1470 200 C1350 292 1130 250 960 300 C850 332 800 368 825 412 C852 458 970 448 1075 495 C1210 555 1270 605 1360 660 C1440 708 1550 728 1700 715" fill="none" stroke="#A6E263" strokeWidth="120" strokeLinecap="round" />
      <path d="M1672 25 C1590 65 1560 150 1562 225 C1564 300 1608 348 1672 358 Z" fill="#A6E263" />
      <path d="M178 519 C216 501 264 498 304 503" fill="none" stroke="#93DB4F" strokeWidth="11" strokeLinecap="round" />
      <path d="M172 509 C208 499 248 496 284 498" fill="none" stroke="#93DB4F" strokeWidth="6" strokeLinecap="round" />
      <path d="M786 240 C776 278 800 316 836 331" fill="none" stroke="#111" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M836 331 L822 322 M836 331 L826 315" fill="none" stroke="#111" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M1132 272 C1124 245 1145 218 1190 206" fill="none" stroke="#111" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M1190 206 L1175 204 M1190 206 L1181 217" fill="none" stroke="#111" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M779 556 C776 600 812 630 860 629" fill="none" stroke="#A98BE8" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M860 629 L845 622 M860 629 L846 636" fill="none" stroke="#A98BE8" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M1206 626 L1252 626" fill="none" stroke="#A98BE8" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M1252 626 L1243 620 M1252 626 L1243 632" fill="none" stroke="#A98BE8" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M994 266 L1000 284 M1016 262 L1014 280 M976 286 L992 296 M1040 290 L1024 298 M1036 316 L1020 312" fill="none" stroke="#111" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M1592 496 L1606 484 M1587 517 L1603 511 M1591 538 L1603 530" fill="none" stroke="#111" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M1600 124 C1603 140 1607 144 1621 148 C1607 152 1603 156 1600 172 C1597 156 1593 152 1579 148 C1593 144 1597 140 1600 124 Z" fill="#8FD94F" />
    </svg>
  );
}

function Hero({ devBypass }: { devBypass: boolean }) {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: 1672, height: 941, transform: "scale(1.14833)", transformOrigin: "top left" }}>
      <HeroBackdrop />

      <div style={{ position: "absolute", left: 116, top: 22, display: "flex", alignItems: "baseline", gap: 3 }}>
        <span style={{ fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 33, letterSpacing: "-0.03em", color: "#0E2416" }}>pixie</span>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#84cc16", display: "block", transform: "translateY(-6px)" }} />
      </div>
      <div style={{ position: "absolute", left: 270, top: 33, display: "flex", gap: 32, fontSize: 15.5, color: "#1A1A1A" }}>
        <a href="#how-it-works">How it works</a>
      </div>
      <a href={LOGIN_HREF} style={{ position: "absolute", left: 1303, top: 33, fontSize: 15.5, color: "#1A1A1A" }}>Sign in</a>
      <a href={LOGIN_HREF} style={{ position: "absolute", left: 1385, top: 19, width: 172, height: 45, borderRadius: 23, background: "#0B0B0B", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 15.5, fontWeight: 600 }}>
        <span>Open Pixie</span>
        <Arrow color="#fff" />
      </a>

      <div style={{ position: "absolute", left: 96, top: 128, fontSize: 11.5, letterSpacing: "0.305em", fontWeight: 600, color: "#33493A" }}>SUPPORT THAT UNDERSTANDS YOUR WORLD</div>
      <h1 style={{ position: "absolute", left: 92, top: 152, margin: 0, fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 106, lineHeight: "110px", letterSpacing: "-0.03em", color: "#0D2114" }}>Support,<br />without the<br />guessing.</h1>

      <p style={{ position: "absolute", left: 96, top: 545, margin: 0, width: 420, fontSize: 18.5, lineHeight: "25px", color: "#1A1A1A" }}>
        <strong style={{ fontWeight: 700 }}>Pixie</strong> answers <strong style={{ fontWeight: 700 }}>support</strong> questions in Slack<br />
        using your program&apos;s own docs. If the<br />
        evidence isn&apos;t there, it stays <strong style={{ fontWeight: 700 }}>quiet and<br />gets a human.</strong>
      </p>

      <div style={{ position: "absolute", left: 96, top: 671, display: "flex", gap: 12, alignItems: "center" }}>
        <a href={LOGIN_HREF} style={{ width: 174, height: 51, borderRadius: 26, background: "#0B0B0B", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 13, fontSize: 16, fontWeight: 700 }}>
          <span>Open Pixie</span>
          <Arrow color="#fff" />
        </a>
        <a href="#how-it-works" style={{ width: 192, height: 51, borderRadius: 26, background: "#FBF9F2", border: "1.5px solid #12261A", color: "#12261A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700 }}>See how it works</a>
        {devBypass && (
          <a href="/api/auth/dev-login" style={{ fontSize: 13, color: "#6E6E68" }}>Dev sign-in</a>
        )}
      </div>

      <div style={{ position: "absolute", left: 96, top: 756, display: "flex", alignItems: "center", gap: 31, fontSize: 13.5, color: "#1A1A1A" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}><Slack /><span>Works in Slack</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}><Doc /><span>Uses your docs</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden="true"><circle cx="9.5" cy="6" r="4.4" fill="#1A1A1A" /><circle cx="19" cy="7" r="3.4" fill="#1A1A1A" /><path d="M1.5 19c0-4.2 3.6-6.6 8-6.6s8 2.4 8 6.6z" fill="#1A1A1A" /><path d="M19.4 12.2c3.3.2 5.4 2.3 5.4 5.2v1.6h-5.2z" fill="#1A1A1A" /></svg>
          <span>Built for communities</span>
        </div>
      </div>

      <div style={{ position: "absolute", left: 840, top: 300, width: 158, height: 122, borderRadius: 16, background: "#2B2B2B" }} />
      <div style={{ position: "absolute", left: 866, top: 293, width: 142, height: 135, borderRadius: 14, background: "#fff", boxShadow: "0 10px 26px rgba(20,30,15,0.10)" }}>
        <div style={{ position: "absolute", left: 14, top: 14, display: "flex", alignItems: "center", gap: 9, fontSize: 14, fontWeight: 600, color: "#1A1A1A" }}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="#1A1A1A" strokeWidth="1.5" /><circle cx="8" cy="8" r="2.4" fill="#1A1A1A" /></svg>
          <span>Program Guide</span>
        </div>
        <div style={{ position: "absolute", left: 20, top: 100, display: "flex", alignItems: "center", gap: 9, fontSize: 14, color: "#B7B7B1" }}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="1" width="12" height="14" rx="2" fill="none" stroke="#C3C3BD" strokeWidth="1.5" /><path d="M5 5.5h6 M5 8.5h6 M5 11.5h4" stroke="#C3C3BD" strokeWidth="1.4" strokeLinecap="round" /></svg>
          <span>FAQ</span>
        </div>
      </div>
      <div style={{ position: "absolute", left: 880, top: 340, width: 164, height: 41, borderRadius: 10, background: "#fff", transform: "rotate(-2deg)", boxShadow: "0 10px 22px rgba(20,30,15,0.16)", display: "flex", alignItems: "center", gap: 9, paddingLeft: 12, boxSizing: "border-box", fontSize: 14.5, color: "#1A1A1A" }}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="1" width="12" height="14" rx="2" fill="none" stroke="#2EB67D" strokeWidth="1.5" /><path d="M5 5.5h6 M5 8.5h6 M5 11.5h4" stroke="#2EB67D" strokeWidth="1.4" strokeLinecap="round" /></svg>
        <span>Submission Docs</span>
      </div>
      <div style={{ position: "absolute", left: 822, top: 368, width: 44, height: 44, borderRadius: "50%", background: "#8FD94F", display: "flex", alignItems: "center", justifyContent: "center" }}><Check stroke="#0D2114" size={20} /></div>

      <div style={{ position: "absolute", left: 1211, top: 210, width: 42, height: 34, borderRadius: 17, background: "#fff", boxShadow: "0 6px 14px rgba(20,30,15,0.14)", display: "flex", alignItems: "center", justifyContent: "center" }}><Check stroke="#5AA02C" size={17} /></div>

      <div style={{ position: "absolute", left: 1073, top: 272, width: 279, height: 140, borderRadius: 18, background: "#E3F6D2" }}>
        <div style={{ position: "absolute", left: 15, top: 30, width: 38, height: 38, borderRadius: "50%", background: "#14301C", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true"><path d="M7 11a3 3 0 010-4l2-2a3 3 0 014 4l-1 1" fill="none" stroke="#8FD94F" strokeWidth="1.7" strokeLinecap="round" /><path d="M11 7a3 3 0 010 4l-2 2a3 3 0 01-4-4l1-1" fill="none" stroke="#8FD94F" strokeWidth="1.7" strokeLinecap="round" /></svg>
        </div>
        <div style={{ position: "absolute", left: 62, top: 16, fontSize: 16.5, lineHeight: "24px", color: "#14301C" }}>You can submit it from<br />the Projects page.</div>
        <div style={{ position: "absolute", left: 66, top: 76, width: 200, height: 48, borderRadius: 10, background: "#fff", boxShadow: "0 6px 16px rgba(20,30,15,0.08)" }}>
          <svg width="17" height="20" viewBox="0 0 18 22" style={{ position: "absolute", left: 14, top: 14 }} aria-hidden="true"><path d="M2 1.2h8.2L16 6.8v14H2z" fill="none" stroke="#3C3C3C" strokeWidth="1.5" strokeLinejoin="round" /><path d="M10.2 1.4v5.6H15.8" fill="none" stroke="#3C3C3C" strokeWidth="1.5" strokeLinejoin="round" /></svg>
          <div style={{ position: "absolute", left: 43, top: 8, fontSize: 12.5, color: "#7B7B75" }}>Program Guide</div>
          <div style={{ position: "absolute", left: 43, top: 25, fontSize: 14, fontWeight: 700, color: "#1A1A1A" }}>Submitting projects</div>
          <svg width="9" height="14" viewBox="0 0 9 14" style={{ position: "absolute", right: 14, top: 17 }} aria-hidden="true"><path d="M1.5 1L7 7l-5.5 6" fill="none" stroke="#5A5A55" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <svg width="24" height="30" viewBox="0 0 24 30" style={{ position: "absolute", left: -14, top: 56 }} aria-hidden="true"><path d="M24 3 C11 8 1 16 3 23 C5 29 15 30 24 27 Z" fill="#E3F6D2" /></svg>
      </div>

      <div style={{ position: "absolute", left: 735, top: 474, width: 281, height: 72, borderRadius: 14, background: "#fff", boxShadow: "0 10px 26px rgba(20,30,15,0.10)" }}>
        <div style={{ position: "absolute", left: 20, top: 20 }}><Slack size={26} /></div>
        <div style={{ position: "absolute", left: 63, top: 21, display: "flex", alignItems: "baseline", gap: 9 }}><span style={{ fontWeight: 700, fontSize: 15 }}>jamie</span><span style={{ fontSize: 12.5, color: "#8A8A84" }}>11:03 AM</span></div>
        <div style={{ position: "absolute", left: 63, top: 41, fontSize: 16.5, color: "#1A1A1A", whiteSpace: "nowrap" }}>can i change this after review?</div>
      </div>

      <div style={{ position: "absolute", left: 876, top: 578, width: 332, height: 88, borderRadius: 18, background: "rgba(240,239,232,0.92)" }}>
        <div style={{ position: "absolute", left: 19, top: 17, width: 44, height: 44, borderRadius: 12, background: "#E2E1DA", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="22" height="16" viewBox="0 0 24 18" aria-hidden="true"><rect x="1.2" y="2" width="21.6" height="14" rx="6" fill="none" stroke="#9E9E97" strokeWidth="1.6" /><circle cx="8" cy="9" r="1.5" fill="#9E9E97" /><circle cx="12" cy="9" r="1.5" fill="#9E9E97" /><circle cx="16" cy="9" r="1.5" fill="#9E9E97" /></svg>
        </div>
        <div style={{ position: "absolute", left: 83, top: 19, fontSize: 16, fontWeight: 700, color: "#4A4A45" }}>No verified answer.</div>
        <div style={{ position: "absolute", left: 83, top: 42, fontSize: 13.5, lineHeight: "18px", color: "#77776F", whiteSpace: "nowrap" }}>Pixie stayed quiet and created a ticket<br />for a human helper.</div>
      </div>

      <div style={{ position: "absolute", left: 1270, top: 565, width: 250, height: 121, borderRadius: 14, background: "#E6DCFB" }}>
        <div style={{ position: "absolute", left: 21, top: 16, fontSize: 13, fontWeight: 700, color: "#3A3358" }}>#1842</div>
        <div style={{ position: "absolute", left: 185, top: 13, width: 45, height: 17, borderRadius: 4, background: "#CBB6F3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.06em", color: "#3A3358" }}>OPEN</div>
        <div style={{ position: "absolute", left: 21, top: 37, fontSize: 16, fontWeight: 700, color: "#1C1830" }}>Review question</div>
        <div style={{ position: "absolute", left: 21, top: 58, fontSize: 13, color: "#5E5878" }}>Needs a human</div>
        <div style={{ position: "absolute", left: 21, top: 82, display: "flex", alignItems: "center" }}>
          <div style={{ width: 23, height: 23, borderRadius: "50%", background: "#B9A184", border: "2px solid #E6DCFB" }} />
          <div style={{ width: 23, height: 23, borderRadius: "50%", background: "#8E9BB0", border: "2px solid #E6DCFB", marginLeft: -6 }} />
          <div style={{ width: 23, height: 23, borderRadius: "50%", background: "#C89A8E", border: "2px solid #E6DCFB", marginLeft: -6 }} />
          <div style={{ height: 19, padding: "0 7px", borderRadius: 10, background: "#D6C8F5", display: "flex", alignItems: "center", fontSize: 11, fontWeight: 700, color: "#3A3358", marginLeft: 4 }}>+2</div>
        </div>
        <div style={{ position: "absolute", right: 16, top: 82 }}><Arrow color="#3A3358" /></div>
      </div>
    </div>
  );
}

const BLOB_PADDING = 34;
const BLOB_PATHS: Record<string, string> = {
  blue: "M717.4,179.0 C711.3,209.2 659.9,235.9 620.4,263.7 C581.0,291.6 544.2,332.5 480.6,346.0 C416.9,359.4 305.8,357.0 238.6,344.4 C171.4,331.7 118.4,297.8 77.5,270.3 C36.5,242.7 -10.0,208.4 -6.9,179.0 C-3.8,149.6 51.9,116.8 96.1,93.8 C140.3,70.8 197.5,50.1 258.4,40.8 C319.3,31.6 395.0,31.3 461.5,38.3 C528.0,45.2 614.5,58.9 657.2,82.3 C699.8,105.8 723.5,148.8 717.4,179.0 Z",
  peach: "M699.3,179.0 C706.6,211.6 657.0,260.2 606.4,285.7 C555.8,311.2 465.9,328.8 395.8,332.1 C325.6,335.4 250.0,321.4 185.4,305.5 C120.8,289.5 42.0,267.6 8.1,236.3 C-25.7,204.9 -45.4,149.4 -17.7,117.3 C10.1,85.2 104.5,62.1 174.6,43.7 C244.8,25.2 338.3,-1.2 403.0,6.5 C467.6,14.2 513.2,61.0 562.6,89.8 C612.0,118.5 692.0,146.4 699.3,179.0 Z",
  green: "M633.6,184.0 C635.8,219.5 676.7,268.7 643.5,292.8 C610.3,316.9 504.7,317.1 434.5,328.5 C364.2,339.9 288.4,367.1 222.0,361.1 C155.6,355.1 69.0,321.8 36.0,292.2 C3.1,262.7 19.5,218.3 24.6,184.0 C29.6,149.7 30.8,112.1 66.4,86.6 C102.0,61.1 175.8,40.5 238.1,31.2 C300.4,21.9 374.8,22.7 440.2,30.8 C505.7,38.8 598.6,54.2 630.9,79.7 C663.1,105.3 631.5,148.5 633.6,184.0 Z",
};

function Blob({ tint, fill, left, top, width, height, opacity }: { tint: string; fill: string; left: number; top: number; width: number; height: number; opacity: number }) {
  const w = width + BLOB_PADDING * 2;
  const h = height + BLOB_PADDING * 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: left - BLOB_PADDING, top: top - BLOB_PADDING, opacity }} aria-hidden="true">
      <path d={BLOB_PATHS[tint]} fill={fill} />
    </svg>
  );
}

function ArrowDoodle({ style }: { style?: CSSProperties }) {
  return (
    <svg width="60" height="40" viewBox="0 0 60 40" style={style} aria-hidden="true">
      <path d="M4 4C14 20 26 28 46 30" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" />
      <path d="M46 30L36 27M46 30L42 20" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HowItWorks() {
  const [sectionRef, progress] = useSectionProgress();
  const ribbonDraw = Math.max(0, Math.min(1, progress / 0.55));
  const branchDraw = Math.max(0, Math.min(1, (progress - 0.45) / 0.4));
  const ribbonOffset = 1000 * (1 - ribbonDraw);
  const branchOffset = 1000 * (1 - branchDraw);
  const b1 = reveal(progress, 0.03);
  const b2 = reveal(progress, 0.2);
  const b3 = reveal(progress, 0.38);
  const b4 = reveal(progress, 0.56);
  const b4b = reveal(progress, 0.6);

  return (
    <div id="how-it-works" ref={sectionRef} style={{ position: "relative", width: 1920, height: 1600, background: "#F7F4E9" }}>
      <svg width="1920" height="1600" viewBox="0 0 1920 1600" style={{ position: "absolute", top: 0, left: 0 }} aria-hidden="true">
        <path d="M1850,0 C1700,119 1550,155 1400,219 C1150,320 950,302 800,421 C650,539 620,640 700,731 C760,804 860,832 920,923" fill="none" stroke="#A6E263" strokeWidth="140" strokeLinecap="round" pathLength="1000" strokeDasharray="1000" strokeDashoffset={ribbonOffset} />
        <path d="M920,923 C860,1000 750,1050 600,1080 C400,1120 200,1160 150,1230 C120,1280 140,1340 200,1380 C300,1420 450,1440 600,1460" fill="none" stroke="#A6E263" strokeWidth="140" strokeLinecap="round" pathLength="1000" strokeDasharray="1000" strokeDashoffset={ribbonOffset} />
        <path d="M920,923 C1020,1000 1150,1040 1280,1080 C1380,1110 1430,1140 1450,1190" fill="none" stroke="#C9AEF0" strokeWidth="100" strokeLinecap="round" pathLength="1000" strokeDasharray="1000" strokeDashoffset={branchOffset} />
      </svg>

      <div style={{ position: "absolute", left: 120, top: 24, fontSize: 12, letterSpacing: "0.28em", fontWeight: 600, color: "#33493A" }}>HOW IT WORKS</div>
      <div style={{ position: "absolute", left: 120, top: 56, width: 480, fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 52, lineHeight: "58px", letterSpacing: "-0.02em", color: "#0D2114" }}>A question &rarr;<br />a better answer.</div>
      <svg width="180" height="14" viewBox="0 0 180 14" style={{ position: "absolute", left: 120, top: 170 }} aria-hidden="true"><path d="M4 8C40 4 120 12 176 6" fill="none" stroke="#8FD94F" strokeWidth="9" strokeLinecap="round" /></svg>
      <div style={{ position: "absolute", left: 1300, top: 64, width: 420, fontSize: 17, lineHeight: "25px", color: "#33493A" }}>Pixie follows a simple process to give you helpful, accurate answers.</div>

      <div style={{ position: "absolute", left: 120, top: 230, width: 64, height: 64, borderRadius: "50%", background: "#8FD94F", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 26, color: "#0D2114", opacity: b1.opacity, transform: `translateY(${b1.offset}px)` }}>1</div>
      <div style={{ position: "absolute", left: 210, top: 222, width: 340, fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 38, lineHeight: "44px", letterSpacing: "-0.02em", color: "#0D2114", opacity: b1.opacity, transform: `translateY(${b1.offset}px)` }}>Ask in Slack</div>
      <div style={{ position: "absolute", left: 210, top: 282, width: 340, fontSize: 18, lineHeight: "26px", color: "#1A1A1A", opacity: b1.opacity, transform: `translateY(${b1.offset}px)` }}>Ask your question in your program&apos;s Slack, just like you normally would.</div>
      <div style={{ position: "absolute", left: 70, top: 400, transform: "rotate(-6deg)", fontFamily: SCRIBBLE_FONT, fontSize: 18, lineHeight: "26px", letterSpacing: "0.02em", color: "#111", opacity: b1.opacity }}>SAME PLACE.<br />SAME FLOW.</div>
      <ArrowDoodle style={{ position: "absolute", left: 80, top: 465, opacity: b1.opacity }} />

      <div style={{ position: "absolute", left: 740, top: 150, width: 400, height: 225, borderRadius: 16, background: "#fff", boxShadow: "0 14px 34px rgba(20,30,15,0.14)", overflow: "hidden", transform: `translateY(${b1.offset}px) rotate(-1.5deg)`, opacity: b1.opacity }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 44, height: 225, background: "#1A1A1A" }}>
          <div style={{ position: "absolute", left: 13, top: 16, width: 18, height: 18, borderRadius: 5, background: "#8FD94F" }} />
          <div style={{ position: "absolute", left: 13, top: 44, width: 18, height: 18, borderRadius: 5, background: "#3A3A3A" }} />
          <div style={{ position: "absolute", left: 13, top: 72, width: 18, height: 18, borderRadius: 5, background: "#3A3A3A" }} />
          <div style={{ position: "absolute", left: 13, top: 100, width: 18, height: 18, borderRadius: 5, background: "#3A3A3A" }} />
        </div>
        <div style={{ position: "absolute", left: 60, top: 14, fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>#pixl-help</div>
        <div style={{ position: "absolute", right: 16, top: 16, display: "flex", gap: 9 }}>
          <div style={{ width: 16, height: 16, borderRadius: "50%", border: "1.5px solid #C7C7C0" }} />
          <div style={{ width: 16, height: 16, borderRadius: "50%", border: "1.5px solid #C7C7C0" }} />
          <div style={{ width: 16, height: 16, borderRadius: "50%", border: "1.5px solid #C7C7C0" }} />
        </div>
        <div style={{ position: "absolute", left: 60, top: 53, height: 1, width: 326, background: "#EEEDE6" }} />
        <div style={{ position: "absolute", left: 60, top: 66, display: "flex", alignItems: "baseline", gap: 8 }}><span style={{ fontWeight: 700, fontSize: 15, color: "#1A1A1A" }}>riley</span><span style={{ fontSize: 12, color: "#8A8A84" }}>10:14 AM</span></div>
        <div style={{ position: "absolute", left: 60, top: 88, fontSize: 15.5, color: "#1A1A1A" }}>is there a deadline for milestone 2?</div>
        <div style={{ position: "absolute", left: 60, top: 132, display: "flex", alignItems: "baseline", gap: 8 }}><span style={{ fontWeight: 700, fontSize: 15, color: "#1A1A1A" }}>pixie</span><span style={{ fontSize: 9, padding: "2px 5px", borderRadius: 4, background: "#EFEFE8", color: "#8A8A84" }}>APP</span><span style={{ fontSize: 12, color: "#8A8A84" }}>10:14 AM</span></div>
        <div style={{ position: "absolute", left: 60, top: 154, fontSize: 15.5, color: "#5A5A55" }}>Checking your program docs&hellip;</div>
        <div style={{ position: "absolute", left: 60, top: 184, width: 210, height: 34, borderRadius: 9, background: "#F0EEE4", display: "flex", alignItems: "center", gap: 8, paddingLeft: 10, boxSizing: "border-box" }}>
          <svg width="14" height="16" viewBox="0 0 18 22" aria-hidden="true"><path d="M2 1.2h8.2L16 6.8v14H2z" fill="none" stroke="#5A5A55" strokeWidth="1.6" strokeLinejoin="round" /></svg>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#3C3C3C" }}>Program Guide</span>
        </div>
      </div>
      <div style={{ position: "absolute", left: 1105, top: 225, width: 110, height: 110, borderRadius: "50%", background: "radial-gradient(circle,rgba(166,226,99,0.5) 0%,rgba(166,226,99,0) 70%)", display: "flex", alignItems: "center", justifyContent: "center", opacity: b1.opacity, transform: `translateY(${b1.offset}px)` }}>
        <img src="/pixie-hero.png" alt="Pixie" className="pixel-art" style={{ width: 78, height: 78, objectFit: "contain" }} />
      </div>

      <Blob tint="blue" fill="#D3ECFA" left={1230} top={492} width={650} height={290} opacity={b2.opacity} />
      <div style={{ position: "absolute", left: 1300, top: 570, width: 64, height: 64, borderRadius: "50%", background: "#BEE3F7", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 26, color: "#0D2114", opacity: b2.opacity, transform: `translateY(${b2.offset}px)` }}>2</div>
      <div style={{ position: "absolute", left: 1390, top: 562, width: 420, fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 38, lineHeight: "44px", letterSpacing: "-0.02em", color: "#0D2114", opacity: b2.opacity, transform: `translateY(${b2.offset}px)` }}>Check your<br />sources</div>
      <div style={{ position: "absolute", left: 1390, top: 660, width: 420, fontSize: 18, lineHeight: "26px", color: "#1A1A1A", opacity: b2.opacity, transform: `translateY(${b2.offset}px)` }}>Pixie searches your program docs, guides, and past answers to find the most relevant information.</div>

      <Blob tint="peach" fill="#FBDDC7" left={-20} top={772} width={610} height={290} opacity={b3.opacity} />
      <div style={{ position: "absolute", left: 120, top: 850, width: 64, height: 64, borderRadius: "50%", background: "#F6B896", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 26, color: "#0D2114", opacity: b3.opacity, transform: `translateY(${b3.offset}px)` }}>3</div>
      <div style={{ position: "absolute", left: 210, top: 842, width: 360, fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 38, lineHeight: "44px", letterSpacing: "-0.02em", color: "#0D2114", opacity: b3.opacity, transform: `translateY(${b3.offset}px)` }}>Verify<br />the evidence</div>
      <div style={{ position: "absolute", left: 210, top: 938, width: 360, fontSize: 18, lineHeight: "26px", color: "#1A1A1A", opacity: b3.opacity, transform: `translateY(${b3.offset}px)` }}>Pixie checks if the sources actually support the answer. If they don&apos;t, it won&apos;t guess.</div>

      <div style={{ position: "absolute", left: 770, top: 864, width: 340, height: 190, borderRadius: 18, background: "#FBDDC7", opacity: b3.opacity, transform: `translateY(${b3.offset}px)` }}>
        <div style={{ position: "absolute", left: 20, top: 20, display: "flex", alignItems: "center", gap: 10, fontSize: 16, fontWeight: 700, color: "#7A3E1D" }}>
          <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#7A3E1D" strokeWidth="1.8" /><path d="M12.4 12.4L16 16" stroke="#7A3E1D" strokeWidth="1.8" strokeLinecap="round" /></svg>
          Checking evidence&hellip;
        </div>
        <div style={{ position: "absolute", left: 20, top: 64, display: "flex", alignItems: "center", gap: 10, fontSize: 14.5, color: "#7A3E1D" }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#3E7A3E" /><path d="M4.5 8.2L6.8 10.4L11.5 5.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Found relevant section
        </div>
        <div style={{ position: "absolute", left: 20, top: 98, display: "flex", alignItems: "center", gap: 10, fontSize: 14.5, color: "#7A3E1D" }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#3E7A3E" /><path d="M4.5 8.2L6.8 10.4L11.5 5.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Matches your question
        </div>
        <div style={{ position: "absolute", left: 20, top: 132, display: "flex", alignItems: "center", gap: 10, fontSize: 14.5, color: "#B5806A" }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="#C99373" strokeWidth="1.6" /></svg>
          No conflicting info
        </div>
      </div>

      <Blob tint="green" fill="#E3F6D2" left={-20} top={1080} width={610} height={300} opacity={b4.opacity} />
      <div style={{ position: "absolute", left: 120, top: 1130, width: 64, height: 64, borderRadius: "50%", background: "#8FD94F", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 26, color: "#0D2114", opacity: b4.opacity, transform: `translateY(${b4.offset}px)` }}>4</div>
      <div style={{ position: "absolute", left: 210, top: 1122, width: 360, fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 38, lineHeight: "44px", letterSpacing: "-0.02em", color: "#0D2114", opacity: b4.opacity, transform: `translateY(${b4.offset}px)` }}>Answer<br />or hand off</div>
      <div style={{ position: "absolute", left: 210, top: 1218, width: 380, fontSize: 18, lineHeight: "26px", color: "#1A1A1A", opacity: b4.opacity, transform: `translateY(${b4.offset}px)` }}>If Pixie finds a clear answer, you&apos;ll get a helpful reply with a source. If not, Pixie stays quiet and a human helper takes over.</div>

      <div style={{ position: "absolute", left: 790, top: 1080, width: 184, height: 32, borderRadius: 16, background: "#A6E263", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", color: "#0D2114", opacity: b4.opacity, transform: `translateY(${b4.offset}px) rotate(-2deg)` }}>GROUNDED ANSWER</div>
      <div style={{ position: "absolute", left: 700, top: 1118, width: 330, height: 190, borderRadius: 18, background: "#fff", boxShadow: "0 10px 26px rgba(20,30,15,0.10)", opacity: b4.opacity, transform: `translateY(${b4.offset}px)` }}>
        <div style={{ position: "absolute", left: 18, top: 18, width: 36, height: 36, borderRadius: 9, overflow: "hidden" }}><img src="/pixie-hero.png" alt="Pixie" className="pixel-art" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
        <div style={{ position: "absolute", left: 64, top: 24, display: "flex", alignItems: "baseline", gap: 8 }}><span style={{ fontWeight: 700, fontSize: 15 }}>pixie</span><span style={{ fontSize: 9.5, padding: "2px 5px", borderRadius: 4, background: "#EFEFE8", color: "#8A8A84" }}>APP</span><span style={{ fontSize: 12, color: "#8A8A84" }}>9:28 AM</span></div>
        <div style={{ position: "absolute", left: 18, top: 58, width: 294, fontSize: 15.5, lineHeight: "22px", color: "#1A1A1A" }}>Milestone 2 is due by end of day, Friday June 6th.</div>
        <div style={{ position: "absolute", left: 18, top: 138, width: 294, height: 38, borderRadius: 9, background: "#D9EEFB", display: "flex", alignItems: "center", padding: "0 12px", boxSizing: "border-box", gap: 9 }}>
          <svg width="14" height="16" viewBox="0 0 18 22" aria-hidden="true"><path d="M2 1.2h8.2L16 6.8v14H2z" fill="none" stroke="#123B4F" strokeWidth="1.6" strokeLinejoin="round" /></svg>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#123B4F" }}>Program Guide</div>
            <div style={{ fontSize: 10.5, color: "#3E6A82" }}>Section 3.2 &middot; Milestones</div>
          </div>
        </div>
      </div>

      <div style={{ position: "absolute", left: 1120, top: 1048, width: 190, height: 32, borderRadius: 16, background: "#E6DCFB", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", color: "#3A3358", opacity: b4b.opacity, transform: `translateY(${b4b.offset}px) rotate(2deg)` }}>NO CLEAR ANSWER</div>
      <div style={{ position: "absolute", left: 1130, top: 1088, width: 330, height: 150, borderRadius: 18, background: "#fff", boxShadow: "0 10px 26px rgba(20,30,15,0.10)", opacity: b4b.opacity, transform: `translateY(${b4b.offset}px)` }}>
        <div style={{ position: "absolute", left: 18, top: 18, width: 36, height: 36, borderRadius: 9, overflow: "hidden" }}><img src="/pixie-hero.png" alt="Pixie" className="pixel-art" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
        <div style={{ position: "absolute", left: 64, top: 24, display: "flex", alignItems: "baseline", gap: 8 }}><span style={{ fontWeight: 700, fontSize: 15 }}>pixie</span><span style={{ fontSize: 9.5, padding: "2px 5px", borderRadius: 4, background: "#EFEFE8", color: "#8A8A84" }}>APP</span></div>
        <div style={{ position: "absolute", left: 18, top: 56, width: 294, fontSize: 15, lineHeight: "21px", color: "#1A1A1A" }}>I couldn&apos;t find a verified answer for this. I&apos;ve created a ticket for a human helper to take a look!</div>
      </div>
      <div style={{ position: "absolute", left: 1130, top: 1256, width: 290, height: 74, borderRadius: 14, background: "#E6DCFB", opacity: b4b.opacity, transform: `translateY(${b4b.offset}px)` }}>
        <div style={{ position: "absolute", left: 18, top: 14, fontSize: 13, fontWeight: 700, color: "#3A3358" }}>Ticket #4821</div>
        <div style={{ position: "absolute", left: 18, top: 38, fontSize: 13, color: "#5E5878" }}>Sent to a Pixl helper</div>
      </div>
      <div style={{ position: "absolute", left: 1490, top: 1300, transform: "rotate(-4deg)", fontFamily: SCRIBBLE_FONT, fontSize: 18, lineHeight: "26px", letterSpacing: "0.02em", color: "#111", opacity: b4b.opacity }}>A REAL HUMAN<br />TAKES OVER.</div>
    </div>
  );
}

function ClosingCta() {
  return (
    <div style={{ position: "relative", width: 1920, height: 420, background: "#F7F4E9", overflow: "hidden" }}>
      <svg width="1920" height="420" viewBox="0 0 1920 420" style={{ position: "absolute", top: 0, left: 0 }} aria-hidden="true"><path d="M0,70 C420,10 900,100 1920,30 L1920,420 L0,420 Z" fill="#E3F1CB" /></svg>
      <div style={{ position: "absolute", left: 240, top: 150, width: 520, fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 56, lineHeight: "62px", letterSpacing: "-0.02em", color: "#0D2114" }}>Knows when <span style={{ color: "#5AA02C" }}>not to<br />answer.</span></div>
      <div style={{ position: "absolute", left: 840, top: 172, width: 440, fontSize: 17, lineHeight: "25px", color: "#1A1A1A" }}>Pixie only answers when it&apos;s confident and can back it up. When it&apos;s not sure, it stays quiet and gets a real human to help. That&apos;s better support for everyone.</div>
      <a href="#how-it-works" style={{ position: "absolute", left: 840, top: 274, width: 172, height: 52, borderRadius: 26, background: "#0B0B0B", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 15.5, fontWeight: 700 }}>
        <span>Learn more</span>
        <Arrow color="#fff" />
      </a>
      <svg width="30" height="30" viewBox="0 0 30 30" style={{ position: "absolute", left: 1660, top: 330 }} aria-hidden="true"><path d="M15 0L18 12L30 15L18 18L15 30L12 18L0 15L12 12Z" fill="#2E4A32" /></svg>
      <div style={{ position: "absolute", left: 70, top: 388, fontSize: 12.5, color: "#5A6B57" }}>Made by Ricky</div>
    </div>
  );
}

// Bridges the Hero/HowItWorks seam: each section draws its background in its
// own clipped SVG, so a shape that should read as one continuous form (not
// two shapes that happen to abut) has to actually live here instead, as a
// single path that bleeds across the boundary unclipped.
function SeamConnector() {
  return (
    <svg
      width="720"
      height="260"
      viewBox="0 0 720 260"
      style={{ position: "absolute", top: 920, left: 0 }}
      aria-hidden="true"
    >
      <path
        d="M0,260 L0,140 C15,55 130,5 270,20 C380,32 460,60 500,95 C525,117 515,140 480,150 C430,163 340,150 260,155 C180,159 90,180 0,195 Z"
        fill="#CDB8F7"
      />
    </svg>
  );
}

// Bridges Hero's decorative green swoosh (which gets clipped at Hero's
// bottom-right corner) with the how-it-works ribbon that starts just below
// it, so the two read as one continuous green form instead of two ribbons
// that happen to be near each other.
// A bold, deliberately different-colored blob dropped ON TOP of both green
// ribbons (Hero's swoosh and the how-it-works ribbon start) — not trying to
// color-match and hide the seam between them, just covering it with its own
// confident shape. Rendered after HowItWorks in the tree so it paints above
// that section's ribbon too, while its `top` still targets the seam area.
function RibbonCover() {
  return (
    <svg
      width="520"
      height="520"
      viewBox="0 0 520 520"
      style={{ position: "absolute", top: 840, left: 1780 }}
      aria-hidden="true"
    >
      <path
        d="M520,140 C540,250 470,370 360,430 C250,490 120,470 55,380 C-10,290 15,150 120,75 C225,0 360,-20 450,30 C495,55 510,90 520,140 Z"
        fill="#CDB8F7"
      />
    </svg>
  );
}

function DesktopLanding({ devBypass }: { devBypass: boolean }) {
  const scale = useScale();
  return (
    <div className="hidden lg:block" style={{ position: "relative", width: "100%", height: DESIGN_HEIGHT * scale, overflow: "hidden", background: "#F7F4E9" }}>
      <div style={{ position: "relative", width: DESIGN_WIDTH, transform: `scale(${scale})`, transformOrigin: "top left", fontFamily: "'Helvetica Neue',Helvetica,Arial,sans-serif", color: "#101010" }}>
        <div style={{ position: "relative", width: 1920, height: 1080, overflow: "hidden" }}><Hero devBypass={devBypass} /></div>
        <SeamConnector />
        <HowItWorks />
        <RibbonCover />
        <ClosingCta />
      </div>
    </div>
  );
}

const MOBILE_STEPS = [
  { n: 1, tone: "#8FD94F", title: "Ask in Slack", body: "Ask your question in your program’s Slack, just like you normally would." },
  { n: 2, tone: "#BEE3F7", title: "Check your sources", body: "Pixie searches your program docs, guides, and past answers to find the most relevant information." },
  { n: 3, tone: "#F6B896", title: "Verify the evidence", body: "Pixie checks if the sources actually support the answer. If they don’t, it won’t guess." },
  { n: 4, tone: "#8FD94F", title: "Answer or hand off", body: "If Pixie finds a clear answer, you’ll get a helpful reply with a source. If not, a human helper takes over." },
];

function MobileButton({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        height: 48,
        borderRadius: 24,
        fontSize: 15,
        fontWeight: 700,
        background: primary ? "#0B0B0B" : "#FBF9F2",
        color: primary ? "#fff" : "#12261A",
        border: primary ? "none" : "1.5px solid #12261A",
      }}
    >
      {children}
    </a>
  );
}

function MobileLanding({ devBypass }: { devBypass: boolean }) {
  return (
    <div className="lg:hidden" style={{ background: "#F7F4E9", color: "#101010", fontFamily: "'Helvetica Neue',Helvetica,Arial,sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px" }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
          <span style={{ fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 22, letterSpacing: "-0.03em", color: "#0E2416" }}>pixie</span>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#84cc16", transform: "translateY(-4px)" }} />
        </span>
        <a href={LOGIN_HREF} style={{ height: 38, padding: "0 16px", borderRadius: 19, background: "#0B0B0B", color: "#fff", display: "flex", alignItems: "center", fontSize: 13.5, fontWeight: 700 }}>Open Pixie</a>
      </header>

      <section style={{ padding: "12px 20px 40px" }}>
        <p style={{ fontSize: 10.5, letterSpacing: "0.28em", fontWeight: 600, color: "#33493A", margin: "0 0 14px" }}>SUPPORT THAT UNDERSTANDS YOUR WORLD</p>
        <h1 style={{ fontFamily: HEAD_FONT, fontWeight: 800, fontSize: "clamp(38px,10vw,52px)", lineHeight: 1.05, letterSpacing: "-0.03em", color: "#0D2114", margin: "0 0 16px" }}>Support, without the guessing.</h1>
        <p style={{ fontSize: 16, lineHeight: 1.5, color: "#1A1A1A", margin: "0 0 24px" }}>
          <strong>Pixie</strong> answers <strong>support</strong> questions in Slack using your program&apos;s own docs. If the evidence isn&apos;t there, it stays <strong>quiet and gets a human.</strong>
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <MobileButton href={LOGIN_HREF} primary>Open Pixie <Arrow color="#fff" /></MobileButton>
          <MobileButton href="#how-it-works-m">See how it works</MobileButton>
          {devBypass && <a href="/api/auth/dev-login" style={{ fontSize: 12.5, color: "#6E6E68", textAlign: "center", marginTop: 2 }}>Dev sign-in</a>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 20px", marginTop: 26, fontSize: 13 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Slack size={18} />Works in Slack</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Doc size={16} />Uses your docs</span>
          <span>Built for communities</span>
        </div>
      </section>

      <section id="how-it-works-m" style={{ padding: "36px 20px", background: "#fff" }}>
        <p style={{ fontSize: 10.5, letterSpacing: "0.24em", fontWeight: 600, color: "#33493A", margin: "0 0 10px" }}>HOW IT WORKS</p>
        <h2 style={{ fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 26, lineHeight: 1.15, color: "#0D2114", margin: "0 0 24px" }}>A question &rarr; a better answer.</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {MOBILE_STEPS.map((step) => (
            <div key={step.n} style={{ display: "flex", gap: 14 }}>
              <span style={{ flex: "none", width: 36, height: 36, borderRadius: "50%", background: step.tone, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 15, color: "#0D2114" }}>{step.n}</span>
              <div>
                <h3 style={{ fontFamily: HEAD_FONT, fontWeight: 700, fontSize: 17, color: "#0D2114", margin: "0 0 4px" }}>{step.title}</h3>
                <p style={{ fontSize: 14.5, lineHeight: 1.45, color: "#1A1A1A", margin: 0 }}>{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ padding: "36px 20px 44px", background: "#E3F1CB" }}>
        <h2 style={{ fontFamily: HEAD_FONT, fontWeight: 800, fontSize: 26, lineHeight: 1.2, color: "#0D2114", margin: "0 0 12px" }}>
          Knows when <span style={{ color: "#5AA02C" }}>not to answer.</span>
        </h2>
        <p style={{ fontSize: 15, lineHeight: 1.5, color: "#1A1A1A", margin: "0 0 20px" }}>
          Pixie only answers when it&apos;s confident and can back it up. When it&apos;s not sure, it stays quiet and gets a real human to help.
        </p>
        <MobileButton href={LOGIN_HREF} primary>Learn more <Arrow color="#fff" /></MobileButton>
        <p style={{ marginTop: 20, fontSize: 12.5, color: "#5A6B57" }}>Made by Ricky</p>
      </section>
    </div>
  );
}

export default function LandingPage() {
  const devBypass = process.env.NODE_ENV !== "production";
  return (
    <>
      <DesktopLanding devBypass={devBypass} />
      <MobileLanding devBypass={devBypass} />
    </>
  );
}
