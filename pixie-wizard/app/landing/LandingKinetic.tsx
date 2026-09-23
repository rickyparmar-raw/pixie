"use client";

import React, { useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  HalfCircleDome,
  DiamondFlair,
  TimerHourglassFlair,
  HeroStar,
  PeaceHandSticker,
  WindmillFlair,
} from "./LandingIcons";

interface BezierPreset {
  name: string;
  p1: [number, number];
  p2: [number, number];
  desc: string;
}

const BEZIER_PRESETS: BezierPreset[] = [
  { name: "Instant", p1: [20, 100], p2: [180, 20], desc: "Fast grounded answers" },
  { name: "Smooth", p1: [40, 110], p2: [160, 10], desc: "Gentle human handoff" },
  { name: "Step", p1: [90, 110], p2: [110, 10], desc: "Threshold escalation" },
];

export function LandingKinetic() {
  const pinSectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [activePreset, setActivePreset] = useState(0);

  const currentPreset = BEZIER_PRESETS[activePreset];

  useGSAP(
    () => {
      const track = trackRef.current;
      const pinSec = pinSectionRef.current;
      if (!track || !pinSec) return;

      const media = gsap.matchMedia();

      media.add("(min-width: 768px)", () => {
        const scrollDist = track.scrollWidth - window.innerWidth + 200;

        gsap.to(track, {
          x: () => -scrollDist,
          ease: "none",
          scrollTrigger: {
            trigger: pinSec,
            start: "top top",
            end: () => `+=${scrollDist * 1.1}`,
            scrub: 0.6,
            pin: true,
            anticipatePin: 1,
            invalidateOnRefresh: true,
          },
        });
      });

      // Ambient 3D floating motions
      gsap.to(".bento-ring", {
        rotation: 360,
        y: -12,
        repeat: -1,
        yoyo: true,
        duration: 8,
        ease: "sine.inOut",
      });

      gsap.to(".bento-flower", {
        rotation: 360,
        repeat: -1,
        duration: 30,
        ease: "none",
      });

      return () => media.revert();
    },
    { scope: pinSectionRef }
  );

  return (
    <div className="kinetic-module bg-[#0e100f] text-[#fffce1]" style={{ fontFamily: "'PP Mori', sans-serif" }}>
      {/* 1. Bento Intro: "Answer Anything / That's right, Anything" */}
      <section className="bento-intro-section py-32 border-t border-[#fffce1]/10 relative overflow-hidden">
        <div className="container mx-auto px-6 sm:px-12 max-w-6xl relative z-10">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
            {/* Left Column: Pill Tags & Mission */}
            <div className="lg:col-span-7 flex flex-col items-start">
              <div className="flex flex-col items-start gap-2.5 mb-8">
                <span className="inline-block bg-[#fec5fb] text-[#0e100f] font-semibold text-lg sm:text-2xl px-5 py-2 rounded-full tracking-tight shadow-lg shadow-[#fec5fb]/10">
                  Answer Anything
                </span>
                <span className="inline-block bg-[#ff8709] text-[#0e100f] font-bold italic text-lg sm:text-2xl px-6 py-2 rounded-full tracking-tight translate-x-4 sm:translate-x-8 shadow-lg shadow-[#ff8709]/10">
                  That&apos;s right, Anything
                </span>
              </div>

              <p className="text-xl sm:text-2xl text-[#fffce1]/85 font-normal leading-relaxed max-w-xl">
                Whether you&apos;re fielding questions about shipping deadlines, grant submissions,
                or API keys, Pixie delivers grounded clarity with zero hallucination.
              </p>

              <div className="mt-8 flex items-center gap-3 text-xs sm:text-sm text-[#fffce1]/50 font-mono">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-[#0ae448] animate-ping" />
                <span>Slack Socket Live · 200+ docs ingested</span>
              </div>
            </div>

            {/* Right Column: Authentic 3D GSAP Composition */}
            <div className="lg:col-span-5 relative h-72 sm:h-96 flex items-center justify-center">
              <div className="absolute w-80 h-80 bg-[#0ae448]/12 rounded-full blur-[100px] pointer-events-none" />

              {/* Official 3D Torus Ring PNG */}
              <div className="bento-ring absolute top-2 left-6 w-24 sm:w-28 h-24 sm:h-28 pointer-events-none drop-shadow-2xl">
                <img src="/circle.png" alt="" className="w-full h-full object-contain" />
              </div>

              {/* Floating Diamond Flair */}
              <div className="absolute top-10 right-10 w-9 h-9">
                <DiamondFlair className="w-full h-full" />
              </div>

              {/* Floating Hourglass Timer */}
              <div className="absolute left-6 bottom-16 w-8 h-8">
                <TimerHourglassFlair className="w-full h-full" />
              </div>

              {/* Authentic Half Circle Dome */}
              <div className="absolute bottom-0 w-80 h-40 flex items-end justify-center pointer-events-none drop-shadow-2xl">
                <HalfCircleDome className="w-full h-full" />
              </div>

              {/* Authentic Windmill Flower floating above dome */}
              <div className="bento-flower absolute bottom-24 w-36 h-36 pointer-events-none drop-shadow-xl z-20">
                <WindmillFlair className="w-full h-full" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Full-Viewport Pinned Horizontal Kinetic Typography Section */}
      <section
        ref={pinSectionRef}
        className="kinetic-pin-section h-screen w-full flex items-center overflow-hidden border-t border-[#fffce1]/10 bg-[#0e100f] relative"
      >
        <div
          ref={trackRef}
          className="kinetic-track flex items-center whitespace-nowrap pl-8 sm:pl-20 gap-16 sm:gap-24 will-change-transform"
        >
          {/* Segment 1: [Nice and] with tilted [Easy] & [Accurate] */}
          <div className="flex items-center gap-6">
            <div className="bg-[#0ae448] text-[#0e100f] px-8 sm:px-14 py-4 sm:py-6 rounded-2xl shadow-2xl flex items-center">
              <span className="text-[clamp(3.8rem,9vw,8rem)] font-bold tracking-tight leading-none">
                Nice and
              </span>
            </div>
            <div className="flex flex-col gap-2 -rotate-6">
              <span className="bg-[#9d95ff] text-[#0e100f] text-base sm:text-2xl font-bold px-4 py-1.5 rounded-lg shadow">
                Easy
              </span>
              <span className="bg-[#fec5fb] text-[#0e100f] text-base sm:text-2xl font-bold px-4 py-1.5 rounded-lg shadow translate-x-3">
                Accurate
              </span>
            </div>
          </div>

          {/* Segment 2: "Add context to your" with Rock-on Hand Sticker */}
          <div className="flex items-center gap-6">
            <div className="relative flex flex-col items-center">
              <div className="absolute -top-16 sm:-top-20 w-12 sm:w-16 h-16 sm:h-20 text-[#fffce1]/80">
                <PeaceHandSticker className="w-full h-full" />
              </div>
              <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#fffce1] leading-none">
                Add context
              </span>
            </div>
            <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#fffce1] leading-none">
              to your
            </span>
          </div>

          {/* Segment 3: "Slack with a huge" */}
          <div className="flex items-center gap-6">
            <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#0ae448] leading-none">
              Slack
            </span>
            <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#fffce1] leading-none">
              with a huge
            </span>
          </div>

          {/* Segment 4: "variety of" + [Super] / [Grounded] + Starburst + Bezier Graph */}
          <div className="flex items-center gap-8">
            <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#fffce1] leading-none">
              variety of
            </span>

            <div className="flex flex-col gap-2 -rotate-3">
              <span className="bg-[#0ae448] text-[#0e100f] text-xl sm:text-3xl font-black px-4 py-1.5 rounded-lg shadow">
                Super
              </span>
              <span className="bg-[#fec5fb] text-[#0e100f] text-xl sm:text-3xl font-black px-4 py-1.5 rounded-lg shadow translate-x-3">
                Grounded
              </span>
              <div className="w-12 h-12 text-[#fec5fb] mt-2 ml-4 animate-spin" style={{ animationDuration: "14s" }}>
                <HeroStar className="w-full h-full" />
              </div>
            </div>

            {/* Interactive Bezier Curve Display */}
            <div className="px-8 py-6 bg-[#141716] border border-[#fffce1]/15 rounded-3xl shadow-2xl flex items-center gap-8">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-mono text-[#0ae448] uppercase tracking-wider font-bold">
                  Confidence Curve
                </span>
                <span className="text-xs text-[#fffce1]/60 font-mono">
                  {currentPreset.desc}
                </span>
                <div className="flex gap-2 mt-2">
                  {BEZIER_PRESETS.map((p, idx) => (
                    <button
                      key={p.name}
                      onClick={() => setActivePreset(idx)}
                      className={`text-xs font-mono px-3 py-1 rounded-full border transition-all ${
                        activePreset === idx
                          ? "bg-[#0ae448] text-[#0e100f] border-[#0ae448] font-bold"
                          : "border-[#fffce1]/20 text-[#fffce1]/70 hover:border-[#fffce1]/50"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bezier SVG */}
              <div className="w-48 h-28 bg-[#0e100f] border border-[#fffce1]/10 rounded-xl p-2.5 flex items-center justify-center">
                <svg viewBox="0 0 200 120" className="w-full h-full overflow-visible">
                  <line x1="20" y1="20" x2="180" y2="20" stroke="#fffce1" strokeOpacity="0.08" strokeDasharray="3 3" />
                  <line x1="20" y1="100" x2="180" y2="100" stroke="#fffce1" strokeOpacity="0.08" strokeDasharray="3 3" />
                  <line x1="20" y1="100" x2={currentPreset.p1[0]} y2={currentPreset.p1[1]} stroke="#0ae448" strokeOpacity="0.4" strokeDasharray="2 2" />
                  <line x1="180" y1="20" x2={currentPreset.p2[0]} y2={currentPreset.p2[1]} stroke="#0ae448" strokeOpacity="0.4" strokeDasharray="2 2" />

                  <path
                    d={`M 20 100 C ${currentPreset.p1[0]} ${currentPreset.p1[1]}, ${currentPreset.p2[0]} ${currentPreset.p2[1]}, 180 20`}
                    fill="none"
                    stroke="#fffce1"
                    strokeWidth="3.5"
                    className="transition-all duration-500 ease-out"
                  />
                  <circle cx="20" cy="100" r="5" fill="#0ae448" />
                  <circle cx="180" cy="20" r="5" fill="#0ae448" />
                  <rect x={currentPreset.p1[0] - 4} y={currentPreset.p1[1] - 4} width="8" height="8" fill="#0ae448" />
                  <rect x={currentPreset.p2[0] - 4} y={currentPreset.p2[1] - 4} width="8" height="8" fill="#0ae448" />
                </svg>
              </div>
            </div>

            <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#fffce1] leading-none">
              sources
            </span>
          </div>

          {/* Segment 5: [Choreograph] [support] in a snap */}
          <div className="flex items-center gap-6">
            <span className="bg-[#fec5fb] text-[#0e100f] text-4xl sm:text-7xl font-bold px-8 py-3 rounded-2xl shadow">
              Choreograph
            </span>
            <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#fffce1] leading-none">
              handoffs
            </span>
            <span className="text-[clamp(4.5rem,11vw,10.5rem)] font-bold tracking-tight text-[#0ae448] leading-none">
              in a snap.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
