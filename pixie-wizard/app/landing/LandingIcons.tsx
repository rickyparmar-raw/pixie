"use client";

import React from "react";

/**
 * Authentic GSAP Curly Braces used across all sections
 */
export function BracketSVG({ className = "", flip = false }: { className?: string; flip?: boolean }) {
  return (
    <svg
      width="24"
      height="62"
      viewBox="0 0 24 62"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`inline-block select-none ${flip ? "rotate-180" : ""} ${className}`}
      aria-hidden="true"
    >
      <path
        d="M22 2C15.3726 2 10 7.37258 10 14V22C10 26.9706 5.97056 31 1 31C5.97056 31 10 35.0294 10 40V48C10 54.6274 15.3726 60 22 60"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Subtitle brackets wrapper: { text }
 */
export function SubtitleBrackets({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`inline-flex items-center gap-3 font-mono text-xs sm:text-sm tracking-wider uppercase text-[#fffce1]/70 ${className}`}>
      <BracketSVG className="text-[#0ae448] h-7 w-3" />
      <span>{children}</span>
      <BracketSVG flip className="text-[#0ae448] h-7 w-3" />
    </div>
  );
}

/**
 * Authentic GSAP Windmill / 4-petal flair
 */
export function WindmillFlair({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 137 135" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        d="M84.1148 67.3453H136.194C136.637 67.3453 137 67.7028 137 68.1397V134.043C137 134.484 136.633 134.845 136.186 134.841C99.0222 134.416 68.9737 104.827 68.502 68.2191V134.206C68.502 134.643 68.1392 135 67.6958 135H0.814284C0.366822 135 -2.06673e-05 134.639 0.00401052 134.198C0.439379 97.2879 30.9354 67.5042 68.498 67.5002H0.806238C0.362807 67.5002 0 67.1427 0 66.7057V0.802561C0 0.361644 0.366822 0.000171863 0.814284 0.00414409C37.9778 0.429172 68.0263 30.0183 68.498 66.6263V0.794617C68.498 0.357672 68.8608 0.000171819 69.3042 0.000171819H136.186C136.633 0.000171819 137 0.361644 136.996 0.802561C136.621 32.4969 114.079 58.94 83.9334 65.7802C83.0022 65.9907 83.1594 67.3453 84.1189 67.3453H84.1148Z"
        fill="url(#windmill-grad)"
      />
      <defs>
        <linearGradient id="windmill-grad" x1="-76" y1="-15" x2="165" y2="81" gradientUnits="userSpaceOnUse">
          <stop offset="0.3" stopColor="#FF8709" />
          <stop offset="0.75" stopColor="#F7BDF8" />
          <stop offset="1" stopColor="#9D95FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * Authentic GSAP Lightning Bolt SVG
 */
export function LightningBoltFlair({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 134 229" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M102.08 10C103.439 10 104.402 11.3264 103.982 12.6187L79.6746 87.3335C79.2542 88.6259 80.2175 89.9522 81.5765 89.9522H109.983C111.634 89.9522 112.574 91.8401 111.579 93.1577L11.2304 226L40.4408 124.708C40.8095 123.429 39.8499 122.154 38.5191 122.154H8.82733C7.44727 122.154 6.48193 120.789 6.94147 119.488L45.1353 11.334C45.4176 10.5346 46.1733 10 47.0211 10H102.08Z"
        fill="#0AE448"
      />
    </svg>
  );
}

/**
 * Authentic GSAP 3D Dome SVG
 */
export function HalfCircleDome({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 496 248" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M496 248C496 111.033 384.967 5.987e-06 248 0C111.033 -5.987e-06 5.987e-06 111.033 0 248L496 248Z"
        fill="url(#dome-radial)"
      />
      <defs>
        <radialGradient id="dome-radial" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(137 461) rotate(-54) scale(517 425)">
          <stop offset="0.38" stopColor="#D1FFBC" />
          <stop offset="0.73" stopColor="#0AE448" />
          <stop offset="1" stopColor="#0AA3E4" />
        </radialGradient>
      </defs>
    </svg>
  );
}

/**
 * Authentic GSAP Diamond Flair
 */
export function DiamondFlair({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 31 31" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        d="M14.793.707a1 1 0 0 1 1.414 0l14.086 14.086a1 1 0 0 1 0 1.414L16.207 30.293a1 1 0 0 1-1.414 0L.707 16.207a1 1 0 0 1 0-1.414L14.793.707Z"
        fill="url(#diamond-grad)"
      />
      <defs>
        <linearGradient id="diamond-grad" x1="-17" y1="-3" x2="37" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0.42" stopColor="#FF8709" />
          <stop offset="0.79" stopColor="#F7BDF8" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * Authentic GSAP Timer Hourglass Flair
 */
export function TimerHourglassFlair({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 31 31" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M16.436 14.799a1 1 0 0 0 0 1.402L29.326 29.3c.622.632.174 1.701-.713 1.701H2.387c-.887 0-1.335-1.07-.713-1.701L14.564 16.2a1 1 0 0 0 0-1.402L1.674 1.7C1.052 1.07 1.5 0 2.387 0h26.226c.887 0 1.335 1.07.713 1.701L16.436 14.8Z"
        fill="url(#timer-grad)"
      />
      <defs>
        <linearGradient id="timer-grad" x1="-2" y1="-1" x2="27" y2="41" gradientUnits="userSpaceOnUse">
          <stop offset="0.27" stopColor="#FEC5FB" />
          <stop offset="0.84" stopColor="#00BAE2" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * 8-pointed starburst flair
 */
export function HeroStar({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" className={className} aria-hidden="true">
      <path d="M50 0L59 34L95 24L72 50L95 76L59 66L50 100L41 66L5 76L28 50L5 24L41 34Z" />
    </svg>
  );
}

/**
 * Peace hand sticker (sign of the horns)
 */
export function PeaceHandSticker({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 100" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 45V15a6 6 0 0 1 12 0v24M34 26a6 6 0 0 1 12 0v14M46 32a6 6 0 0 1 12 0v16M58 40a6 6 0 0 1 12 0v20c0 20-14 32-34 32S10 80 10 60V42a6 6 0 0 1 12 0v18" />
    </svg>
  );
}
