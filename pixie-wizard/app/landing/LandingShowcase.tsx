"use client";

import React, { useState, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { SubtitleBrackets } from "./LandingIcons";

interface ShowcaseSlide {
  id: string;
  badge: string;
  badgeColor: string;
  title: string;
  subtitle: string;
  question: string;
  channel: string;
  outcome: "auto" | "handoff";
  confidence: number;
  sources: string[];
  replySnippet: string;
  helperName?: string;
  helperRole?: string;
}

const SLIDES: ShowcaseSlide[] = [
  {
    id: "showreel",
    badge: "Showreel",
    badgeColor: "#0ae448",
    title: "Pixie Showreel 2026",
    subtitle: "Watch real Slack threads resolve in under 4 seconds.",
    question: "How do I claim my High Seas grant domain voucher?",
    channel: "#high-seas-help",
    outcome: "auto",
    confidence: 0.98,
    sources: ["Voucher Policy 2026", "Domain Setup Guide §3"],
    replySnippet:
      "Vouchers are generated via `/grant-voucher` in Slack once your project repo passes automated tests. They expire after 30 days.",
  },
  {
    id: "px-104",
    badge: "Auto Resolution",
    badgeColor: "#00c5ff",
    title: "PX-104: Prize Distribution FAQ",
    subtitle: "Grounded in official shipping handbook; zero speculation.",
    question: "When are prizes shipped for Pixl season 1?",
    channel: "#pixl-help",
    outcome: "auto",
    confidence: 0.95,
    sources: ["Pixl Shipping Guide §4.2", "Organizer Announcement 12/04"],
    replySnippet:
      "Hardware batches ship on the 1st and 15th of each month via DHL Express with tracking sent directly to your signup email.",
  },
  {
    id: "px-1842",
    badge: "Human Handoff",
    badgeColor: "#ff8709",
    title: "PX-1842: Borderline PCB Waiver Request",
    subtitle: "Evidence threshold missed → escalated to Jamie with context.",
    question: "Can I submit a 4-layer PCB revision if my BOM exceeds $25 by $2?",
    channel: "#hardware-grants",
    outcome: "handoff",
    confidence: 0.54,
    sources: ["BOM Guidelines (stale: 2025)"],
    replySnippet:
      "Budget exceptions require organizer discretion. Escalating to @Jamie (Hardware Review lead) with your cart link attached.",
    helperName: "Jamie",
    helperRole: "Hardware Review Lead · 14 resolved this week",
  },
];

export function LandingShowcase() {
  const containerRef = useRef<HTMLElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [testQuestion, setTestQuestion] = useState("");
  const [simulatedState, setSimulatedState] = useState<null | {
    confidence: number;
    decision: "auto" | "handoff";
    message: string;
  }>(null);

  const currentSlide = SLIDES[currentIndex];

  const handlePrev = () => {
    setCurrentIndex((prev) => (prev === 0 ? SLIDES.length - 1 : prev - 1));
  };

  const handleNext = () => {
    setCurrentIndex((prev) => (prev === SLIDES.length - 1 ? 0 : prev + 1));
  };

  const runSimulation = (q: string) => {
    setTestQuestion(q);
    if (q.toLowerCase().includes("prize") || q.toLowerCase().includes("ship")) {
      setSimulatedState({
        confidence: 0.96,
        decision: "auto",
        message: "Grounded match found in Shipping FAQ §4. Auto-replying with tracking guidelines.",
      });
    } else if (q.toLowerCase().includes("ai") || q.toLowerCase().includes("rules")) {
      setSimulatedState({
        confidence: 0.91,
        decision: "auto",
        message: "Grounded match found in Hackathon Constitution §2: AI tools permitted with disclosure.",
      });
    } else {
      setSimulatedState({
        confidence: 0.48,
        decision: "handoff",
        message: "Confidence 0.48 < 0.82 bar. Refusing speculation. Opening ticket and routing to @Jamie.",
      });
    }
  };

  return (
    <section
      id="showcase"
      ref={containerRef}
      className="showcase-section relative py-32 bg-[#0e100f] text-[#fffce1] border-t border-[#fffce1]/10 overflow-hidden"
    >
      <div className="container mx-auto px-6 sm:px-12 max-w-6xl relative z-10">
        {/* Header with Eyebrow */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-16 gap-6">
          <div>
            <div className="mb-4">
              <SubtitleBrackets>Showcase</SubtitleBrackets>
            </div>
            <h2 className="text-3xl sm:text-5xl font-normal tracking-tight text-[#fffce1]">
              See Pixie in action.
            </h2>
          </div>

          {/* Carousel Arrows */}
          <div className="flex items-center gap-3">
            <button
              onClick={handlePrev}
              aria-label="Previous showcase card"
              className="w-12 h-12 rounded-full border border-[#fffce1]/20 hover:border-[#0ae448] text-[#fffce1] hover:text-[#0ae448] flex items-center justify-center transition-colors text-lg"
            >
              ←
            </button>
            <button
              onClick={handleNext}
              aria-label="Next showcase card"
              className="w-12 h-12 rounded-full border border-[#fffce1]/20 hover:border-[#0ae448] text-[#fffce1] hover:text-[#0ae448] flex items-center justify-center transition-colors text-lg"
            >
              →
            </button>
          </div>
        </div>

        {/* 3D Showcase Card Carousel */}
        <div className="relative rounded-3xl bg-[#141716] border border-[#fffce1]/15 p-6 sm:p-12 shadow-2xl overflow-hidden mb-16">
          {/* Ambient Glow */}
          <div
            className="absolute top-0 right-0 w-96 h-96 rounded-full blur-[130px] pointer-events-none opacity-20"
            style={{ backgroundColor: currentSlide.badgeColor }}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
            {/* Left 3D Visual Box */}
            <div className="lg:col-span-6 bg-[#0e100f] rounded-2xl p-6 border border-[#fffce1]/10 shadow-inner flex flex-col justify-between min-h-[340px]">
              {/* Slack Header */}
              <div className="flex items-center justify-between border-b border-[#fffce1]/10 pb-4 mb-4">
                <div className="flex items-center gap-3">
                  <img
                    src="/pixie-slack-app-icon.png"
                    alt="Pixie Avatar"
                    className="w-8 h-8 rounded-lg shadow"
                  />
                  <div>
                    <span className="font-bold text-sm text-[#fffce1]">Pixie</span>
                    <span className="text-[10px] bg-[#fffce1]/10 text-[#fffce1]/70 px-1.5 py-0.5 rounded ml-2 font-mono">
                      APP
                    </span>
                  </div>
                </div>
                <span className="text-xs font-mono text-[#fffce1]/40">{currentSlide.channel}</span>
              </div>

              {/* User Question */}
              <div className="mb-4 bg-[#1b1f1e] p-3.5 rounded-xl border border-[#fffce1]/5">
                <span className="text-[11px] font-mono text-[#fffce1]/50 block mb-1">Community Question</span>
                <p className="text-sm sm:text-base font-semibold text-[#fffce1]">
                  &quot;{currentSlide.question}&quot;
                </p>
              </div>

              {/* Pixie Decision Radar */}
              <div className="mb-4 flex items-center justify-between text-xs font-mono bg-[#161918] p-3 rounded-lg border border-[#fffce1]/10">
                <span className="text-[#fffce1]/60">Evidence Score:</span>
                <span
                  style={{ color: currentSlide.badgeColor }}
                  className="font-bold flex items-center gap-1.5"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full animate-pulse"
                    style={{ backgroundColor: currentSlide.badgeColor }}
                  />
                  {(currentSlide.confidence * 100).toFixed(0)}% Confidence
                </span>
                <span className="text-[#fffce1]/40">Threshold: ≥ 82%</span>
              </div>

              {/* Pixie Response */}
              <div className="bg-[#121514] p-4 rounded-xl border-l-4" style={{ borderColor: currentSlide.badgeColor }}>
                <p className="text-xs sm:text-sm text-[#fffce1]/90 leading-relaxed mb-3">
                  {currentSlide.replySnippet}
                </p>
                <div className="flex flex-wrap gap-2 text-[10px] font-mono text-[#fffce1]/50">
                  {currentSlide.sources.map((s) => (
                    <span key={s} className="bg-black/40 px-2 py-0.5 rounded border border-[#fffce1]/10">
                      📄 {s}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Card Meta & Details */}
            <div className="lg:col-span-6 flex flex-col items-start">
              <span
                style={{ color: currentSlide.badgeColor }}
                className="text-xs font-mono font-extrabold uppercase tracking-widest px-3 py-1 rounded-full bg-white/5 border border-white/10 mb-4"
              >
                {currentSlide.badge}
              </span>

              <h3 className="text-3xl sm:text-4xl font-bold tracking-tight text-[#fffce1] mb-3">
                {currentSlide.title}
              </h3>

              <p className="text-base text-[#fffce1]/70 mb-8 leading-relaxed">
                {currentSlide.subtitle}
              </p>

              {currentSlide.outcome === "handoff" && currentSlide.helperName && (
                <div className="w-full mb-8 p-4 rounded-xl bg-[#191d1b] border border-[#ff8709]/30 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-[#ff8709]/20 text-[#ff8709] font-bold font-mono flex items-center justify-center">
                    JM
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[#fffce1]">{currentSlide.helperName}</div>
                    <div className="text-xs text-[#fffce1]/60 font-mono">{currentSlide.helperRole}</div>
                  </div>
                </div>
              )}

              <a
                href="/api/auth/login"
                className="inline-flex items-center gap-2 border border-[#fffce1]/30 hover:border-[#0ae448] text-[#fffce1] hover:text-[#0ae448] text-sm sm:text-base font-semibold px-6 py-3 rounded-full transition-all duration-200"
              >
                Explore All Showcases
                <span aria-hidden>→</span>
              </a>
            </div>
          </div>
        </div>

        {/* Live Interactive Simulator Box */}
        <div className="rounded-3xl bg-[#121514] border border-[#fffce1]/10 p-8 sm:p-12">
          <div className="max-w-2xl mb-6">
            <span className="text-xs font-mono text-[#0ae448] uppercase tracking-wider block mb-2">
              Interactive Test Drive
            </span>
            <h3 className="text-2xl sm:text-3xl font-normal text-[#fffce1]">
              Try a question right now.
            </h3>
            <p className="text-sm text-[#fffce1]/60 mt-1">
              Click a sample question below to see how Pixie calculates confidence and decides to answer or hand off.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 mb-6">
            <button
              onClick={() => runSimulation("When are prizes shipped for season 1?")}
              className="text-xs bg-[#1a1e1c] hover:bg-[#232926] text-[#fffce1]/80 px-3.5 py-2 rounded-full border border-[#fffce1]/10 transition-colors"
            >
              &quot;When are prizes shipped?&quot;
            </button>
            <button
              onClick={() => runSimulation("Can I use external AI APIs in my submission?")}
              className="text-xs bg-[#1a1e1c] hover:bg-[#232926] text-[#fffce1]/80 px-3.5 py-2 rounded-full border border-[#fffce1]/10 transition-colors"
            >
              &quot;Can I use AI APIs?&quot;
            </button>
            <button
              onClick={() => runSimulation("Can I get special exemption to exceed the $25 budget?")}
              className="text-xs bg-[#1a1e1c] hover:bg-[#232926] text-[#fffce1]/80 px-3.5 py-2 rounded-full border border-[#fffce1]/10 transition-colors"
            >
              &quot;Can I exceed budget by $2?&quot;
            </button>
          </div>

          {simulatedState && (
            <div className="p-4 rounded-xl bg-[#0e100f] border border-[#fffce1]/15 font-mono text-xs flex flex-col gap-2 animate-in fade-in">
              <div className="flex items-center justify-between">
                <span className="text-[#fffce1]/50">Evaluating question: &quot;{testQuestion}&quot;</span>
                <span
                  className={`font-bold px-2 py-0.5 rounded ${
                    simulatedState.decision === "auto"
                      ? "bg-[#0ae448]/20 text-[#0ae448]"
                      : "bg-[#ff8709]/20 text-[#ff8709]"
                  }`}
                >
                  [{simulatedState.decision === "auto" ? "AUTO-REPLY GROUNDED" : "HUMAN ESCALATION"}]
                </span>
              </div>
              <div className="text-sm text-[#fffce1]">{simulatedState.message}</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
