"use client";

import React, { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { SubtitleBrackets } from "./LandingIcons";

interface CommunityBrand {
  name: string;
  category: string;
  customLogo: React.ReactNode;
}

const COMMUNITIES: CommunityBrand[] = [
  {
    name: "Hack Club",
    category: "Global Maker Network",
    customLogo: (
      <div className="flex items-center gap-2 font-black tracking-tighter text-2xl uppercase">
        <span className="bg-[#ec3750] text-white px-2 py-0.5 rounded-lg text-lg tracking-normal font-sans">
          HC
        </span>
        <span className="text-[#fffce1]">HACK CLUB</span>
      </div>
    ),
  },
  {
    name: "Pixl",
    category: "Hardware Grants",
    customLogo: (
      <div className="flex items-center gap-1 font-black text-2xl tracking-tight text-[#0ae448]">
        <span>pixl</span>
        <span className="text-xs bg-[#0ae448]/20 border border-[#0ae448]/40 px-1.5 py-0.5 rounded font-mono text-[#0ae448]">
          v2
        </span>
      </div>
    ),
  },
  {
    name: "YSWS",
    category: "You Ship We Ship",
    customLogo: (
      <div className="font-mono font-black text-2xl tracking-widest text-[#fffce1] border-b-2 border-[#fffce1]/40 pb-0.5">
        YSWS
      </div>
    ),
  },
  {
    name: "High Seas",
    category: "Coding Adventure",
    customLogo: (
      <div className="flex items-center gap-2 font-serif font-black text-2xl italic text-[#fec5fb]">
        <span>⚓</span>
        <span>High Seas</span>
      </div>
    ),
  },
  {
    name: "Blueprint",
    category: "Hackathon Circuit",
    customLogo: (
      <div className="font-mono text-xl tracking-tight text-[#00c5ff] font-bold">
        &lt;blueprint/&gt;
      </div>
    ),
  },
  {
    name: "Sprig",
    category: "Handheld Consoles",
    customLogo: (
      <div className="flex items-center gap-1.5 font-sans font-black text-2xl tracking-tight text-[#fffce1]">
        <span className="text-xl">🎮</span>
        <span>sprig</span>
      </div>
    ),
  },
];

export function LandingCommunities() {
  const containerRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      // Subtle float on brand logos
      gsap.fromTo(
        ".community-logo-item",
        { opacity: 0.5, y: 12 },
        {
          opacity: 1,
          y: 0,
          stagger: 0.08,
          duration: 0.6,
          ease: "power2.out",
          scrollTrigger: {
            trigger: containerRef.current,
            start: "top 85%",
          },
        }
      );
    },
    { scope: containerRef }
  );

  return (
    <section
      id="communities"
      ref={containerRef}
      className="communities-section relative py-24 bg-[#0e100f] text-[#fffce1] border-t border-[#fffce1]/10 overflow-hidden"
    >
      <div className="container mx-auto px-6 sm:px-12 max-w-6xl relative z-10">
        {/* Eyebrow in brackets */}
        <div className="mb-12">
          <SubtitleBrackets>Communities using Pixie®</SubtitleBrackets>
        </div>

        {/* Clean 1:1 Horizontal Brand Row like GSAP frame 44 */}
        <div className="flex flex-wrap items-center justify-between gap-8 sm:gap-12 py-8 px-4 rounded-2xl bg-[#141716]/60 border border-[#fffce1]/10 mb-20">
          {COMMUNITIES.map((c) => (
            <div
              key={c.name}
              className="community-logo-item group transition-all duration-300 hover:scale-105 opacity-80 hover:opacity-100 cursor-pointer flex flex-col items-center"
              title={`${c.name} - ${c.category}`}
            >
              {c.customLogo}
              <span className="text-[10px] font-mono text-[#fffce1]/40 mt-1 group-hover:text-[#0ae448] transition-colors">
                {c.category}
              </span>
            </div>
          ))}
        </div>

        {/* Metrics Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 pt-10 border-t border-[#fffce1]/10">
          <div className="p-6 rounded-2xl bg-[#121514] border border-[#fffce1]/5 hover:border-[#0ae448]/30 transition-colors">
            <div className="text-3xl sm:text-4xl font-extrabold text-[#0ae448] tracking-tight mb-1 font-mono">
              28,400+
            </div>
            <div className="text-xs uppercase tracking-widest text-[#fffce1]/60 font-semibold">
              Questions answered
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-[#121514] border border-[#fffce1]/5 hover:border-[#fec5fb]/30 transition-colors">
            <div className="text-3xl sm:text-4xl font-extrabold text-[#fec5fb] tracking-tight mb-1 font-mono">
              94.2%
            </div>
            <div className="text-xs uppercase tracking-widest text-[#fffce1]/60 font-semibold">
              Grounded precision
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-[#121514] border border-[#fffce1]/5 hover:border-[#ff8709]/30 transition-colors">
            <div className="text-3xl sm:text-4xl font-extrabold text-[#ff8709] tracking-tight mb-1 font-mono">
              0
            </div>
            <div className="text-xs uppercase tracking-widest text-[#fffce1]/60 font-semibold">
              Hallucinations allowed
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-[#121514] border border-[#fffce1]/5 hover:border-[#9d95ff]/30 transition-colors">
            <div className="text-3xl sm:text-4xl font-extrabold text-[#9d95ff] tracking-tight mb-1 font-mono">
              3.8 min
            </div>
            <div className="text-xs uppercase tracking-widest text-[#fffce1]/60 font-semibold">
              Escalation handoff time
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
