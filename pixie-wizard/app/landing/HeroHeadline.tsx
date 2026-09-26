"use client";

import { useRef } from "react";
import gsap from "gsap";

// Experimental gsap.com-style hover: the letter under the cursor leaps,
// squashes as it lands and bounces; its neighbours in the same line ripple
// with smaller, later hops.
const LINES = [
  { text: "stop answering", accent: false },
  { text: "the same question", accent: false },
  { text: "40 times.", accent: true },
];

const RIPPLE = [
  { offset: 0, height: 34, delay: 0 },
  { offset: 1, height: 16, delay: 0.05 },
  { offset: 2, height: 6, delay: 0.1 },
];

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function HeroHeadline() {
  const letters = useRef<(HTMLSpanElement | null)[][]>(LINES.map(() => []));
  const hops = useRef(new Map<HTMLSpanElement, gsap.core.Timeline>());

  const hop = (el: HTMLSpanElement, height: number, delay: number) => {
    hops.current.get(el)?.kill();
    const tl = gsap.timeline({ delay });
    tl.to(el, { yPercent: -height, scaleX: 0.94, scaleY: 1.08, duration: 0.22, ease: "power2.out" })
      .to(el, { yPercent: 0, scaleX: 1, scaleY: 1, duration: 0.28, ease: "power2.in" })
      .to(el, { scaleX: 1.14, scaleY: 0.84, duration: 0.07, ease: "power1.out" })
      .to(el, { yPercent: -height * 0.18, scaleX: 1, scaleY: 1, duration: 0.16, ease: "power2.out" })
      .to(el, { yPercent: 0, duration: 0.32, ease: "bounce.out" });
    hops.current.set(el, tl);
  };

  const onEnter = (line: number, index: number) => {
    if (prefersReducedMotion()) return;
    const row = letters.current[line];
    for (const { offset, height, delay } of RIPPLE) {
      for (const i of offset === 0 ? [index] : [index - offset, index + offset]) {
        const el = row[i];
        if (el) hop(el, height, delay);
      }
    }
  };

  return (
    <h1 id="landing-title" aria-label={LINES.map((l) => l.text).join(" ")}>
      {LINES.map((line, lineIndex) => {
        let letterIndex = 0;
        return (
          <span key={line.text} className={`px-hero-line${line.accent ? " px-accent" : ""}`} aria-hidden="true">
            {Array.from(line.text).map((char, charIndex) => {
              if (char === " ") return " ";
              const index = letterIndex++;
              return (
                <span
                  key={charIndex}
                  ref={(el) => {
                    letters.current[lineIndex][index] = el;
                  }}
                  className="px-hero-char"
                  onPointerEnter={() => onEnter(lineIndex, index)}
                >
                  {char}
                </span>
              );
            })}
          </span>
        );
      })}
    </h1>
  );
}
