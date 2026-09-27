"use client";

import React, { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { BracketSVG, WindmillFlair, LightningBoltFlair, HeroStar } from "./LandingIcons";

interface LandingHeroProps {
  onExploreClick?: () => void;
}

export function LandingHero({ onExploreClick }: LandingHeroProps) {
  const containerRef = useRef<HTMLElement>(null);
  const lettersRef = useRef<(HTMLSpanElement | null)[]>([]);

  useGSAP(
    () => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out", duration: 0.8 } });

      // Clean staggered entrance matching GSAP site
      tl.from(".hero-char", {
        y: 50,
        opacity: 0,
        stagger: 0.03,
        duration: 0.7,
      })
        .from(
          ".hero-flair",
          {
            scale: 0,
            rotation: -45,
            opacity: 0,
            stagger: 0.08,
            duration: 0.8,
            ease: "back.out(1.8)",
          },
          "-=0.4"
        )
        .from(
          ".hero-subtitle-box",
          {
            y: 20,
            opacity: 0,
            duration: 0.5,
          },
          "-=0.3"
        )
        .from(
          ".hero-cta-btn",
          {
            scale: 0.9,
            opacity: 0,
            duration: 0.5,
          },
          "-=0.3"
        );

      // Continuous subtle idle rotation for windmill
      gsap.to(".hero-windmill-flair", {
        rotation: 360,
        duration: 35,
        repeat: -1,
        ease: "none",
      });

      // Smooth idle wiggle for 3D worm
      gsap.to(".hero-worm-flair", {
        y: 8,
        rotation: 3,
        duration: 2.4,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });

      // Ambient starburst spin
      gsap.to(".hero-star-flair", {
        rotation: -360,
        scale: 1.12,
        duration: 18,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
    },
    { scope: containerRef }
  );

  const handleCharHover = (e: React.MouseEvent<HTMLSpanElement>) => {
    gsap.to(e.currentTarget, {
      scale: 1.18,
      y: -8,
      rotation: gsap.utils.random(-5, 5),
      color: gsap.utils.random(["#0ae448", "#fec5fb", "#ff8709", "#9d95ff"]),
      duration: 0.2,
      yoyo: true,
      repeat: 1,
      ease: "power2.out",
    });
  };

  const line1 = ["A", "n", "s", "w", "e", "r"];
  const line2 = ["a", "n", "y", "t", "h", "!", "n", "g"];

  return (
    <section
      ref={containerRef}
      className="home-hero relative min-h-screen flex flex-col justify-between pt-28 pb-12 overflow-hidden select-none bg-[#0e100f] text-[#fffce1]"
      style={{ fontFamily: "sans-serif" }}
    >
      {/* Top Banner */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-[#0ae448] text-[#0e100f] px-4 py-2 text-center text-xs sm:text-sm font-semibold tracking-tight shadow-sm flex items-center justify-center gap-2">
        <span className="text-base">📢</span>
        <span>
          <strong>Pixie is completely free</strong>&nbsp;for Hack Club programs &amp; Slack workspaces!
        </span>
        <a href="#why" className="underline font-bold hover:text-black ml-1">
          See why &rarr;
        </a>
      </div>

      {/* Global Navbar */}
      <header className="fixed top-8 left-0 right-0 z-40 bg-[#0e100f]/90 backdrop-blur-md border-b border-[#fffce1]/10 px-6 sm:px-12 py-3.5 flex items-center justify-between">
        <a href="#top" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-full bg-[#0ae448] flex items-center justify-center font-black text-[#0e100f] text-base group-hover:scale-110 transition-transform">
            ⚡
          </div>
          <span className="text-2xl sm:text-3xl font-bold tracking-tighter text-[#fffce1]">
            pixie<span className="text-[#0ae448]">.</span>
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-[#fffce1]/80">
          <a href="#tools" className="hover:text-[#0ae448] transition-colors">
            Tools
          </a>
          <a href="#showcase" className="hover:text-[#0ae448] transition-colors">
            Showcase
          </a>
          <a href="#communities" className="hover:text-[#0ae448] transition-colors">
            Community
          </a>
          <a href="#why" className="hover:text-[#0ae448] transition-colors">
            Why Pixie
          </a>
          <a href="#tools" className="hover:text-[#0ae448] transition-colors">
            Docs
          </a>
          <a href="#showcase" className="hover:text-[#0ae448] transition-colors">
            Demos
          </a>
        </nav>

        <div className="flex items-center gap-4">
          <a
            href="/api/auth/login"
            className="text-xs sm:text-sm font-medium text-[#fffce1]/70 hover:text-[#fffce1] transition-colors hidden sm:inline"
          >
            Login/Create Account
          </a>
          <a
            href="/api/auth/login"
            className="text-xs sm:text-sm font-semibold border border-[#fffce1] text-[#fffce1] rounded-full px-5 py-2 hover:bg-[#0ae448] hover:text-[#0e100f] hover:border-[#0ae448] transition-all"
          >
            Get Pixie
          </a>
        </div>
      </header>

      {/* Hero Headline Content */}
      <div className="container mx-auto px-6 sm:px-12 pt-16 sm:pt-24 flex-1 flex flex-col justify-center relative z-10 max-w-6xl">
        <h1 className="flex flex-col items-start font-semibold tracking-[-0.05em] text-[clamp(4.2rem,11.5vw,10.8rem)] text-[#fffce1] leading-[0.84] relative">
          {/* Row 1: Answer with authentic GSAP Windmill Flair atop 'A' */}
          <div className="relative flex items-center flex-nowrap whitespace-nowrap">
            {/* Windmill Flair */}
            <div className="hero-flair hero-windmill-flair absolute -top-16 sm:-top-28 left-0 sm:left-2 w-20 sm:w-36 h-20 sm:h-36 pointer-events-none drop-shadow-xl z-20">
              <WindmillFlair className="w-full h-full" />
            </div>

            {line1.map((char, index) => (
              <span
                key={`l1-${index}`}
                ref={(el) => {
                  lettersRef.current[index] = el;
                }}
                onMouseEnter={handleCharHover}
                className="hero-char inline-block cursor-pointer transition-colors duration-150 origin-bottom"
              >
                {char}
              </span>
            ))}
          </div>

          {/* Row 2: anyth!ng with authentic 3D worm PNG and starburst */}
          <div className="relative flex items-center flex-nowrap whitespace-nowrap mt-[-0.06em]">
            {line2.map((char, index) => {
              const charIdx = line1.length + index;

              if (char === "!") {
                return (
                  <span
                    key={`l2-${index}`}
                    ref={(el) => {
                      lettersRef.current[charIdx] = el;
                    }}
                    onMouseEnter={handleCharHover}
                    className="hero-char relative inline-block cursor-pointer origin-bottom"
                  >
                    <span className="text-[#0ae448]">!</span>
                    {/* Official 3D Lavender Worm PNG beneath 'th!' */}
                    <div className="hero-flair hero-worm-flair absolute -bottom-16 sm:-bottom-24 -left-6 sm:-left-8 w-14 sm:w-24 pointer-events-none z-[-1] drop-shadow-2xl">
                      <img src="/worm.png" alt="" className="w-full h-auto object-contain" />
                    </div>
                  </span>
                );
              }

              return (
                <span
                  key={`l2-${index}`}
                  ref={(el) => {
                    lettersRef.current[charIdx] = el;
                  }}
                  onMouseEnter={handleCharHover}
                  className="hero-char inline-block cursor-pointer transition-colors duration-150 origin-bottom"
                >
                  {char}
                </span>
              );
            })}

            {/* Starburst on right side */}
            <div className="hero-flair hero-star-flair absolute -right-14 sm:-right-24 bottom-2 sm:bottom-4 w-12 sm:w-20 h-12 sm:h-20 pointer-events-none text-[#ff8709]">
              <HeroStar className="w-full h-full" />
            </div>
          </div>
        </h1>

        {/* Hero Footer Bar: Subtitle in Curly Brackets + Pill Button */}
        <div className="mt-14 sm:mt-24 flex flex-col md:flex-row md:items-end justify-between gap-8 pt-8 border-t border-[#fffce1]/10">
          <div className="hero-subtitle-box flex items-center gap-3 text-sm sm:text-base font-normal text-[#fffce1]/85 max-w-xl">
            <BracketSVG className="text-[#fffce1]/60 flex-shrink-0" />
            <p className="leading-relaxed">
              Pixie &ndash; A wildly robust Slack support bot built for communities, powered by your docs with verified evidence.
            </p>
            <BracketSVG flip className="text-[#fffce1]/60 flex-shrink-0" />
          </div>

          <div className="hero-cta-btn flex-shrink-0">
            <a
              href="#why"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("why")?.scrollIntoView({ behavior: "smooth" });
                onExploreClick?.();
              }}
              className="group inline-flex items-center gap-3 px-7 py-3.5 rounded-full border border-[#0ae448] text-[#fffce1] hover:text-[#0e100f] hover:bg-[#0ae448] transition-all duration-300 shadow-[0_0_20px_rgba(10,228,72,0.2)] hover:shadow-[0_0_30px_rgba(10,228,72,0.5)] font-semibold text-sm sm:text-base"
            >
              <span>Get Pixie</span>
              <span className="w-5 h-5 rounded-full border border-current flex items-center justify-center text-xs group-hover:translate-y-0.5 transition-transform">
                &darr;
              </span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
