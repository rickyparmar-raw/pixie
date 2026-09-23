"use client";

import React, { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { SubtitleBrackets, HeroStar } from "./LandingIcons";

export function LandingWhy() {
  const sectionRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      // Scrub word highlighting as user scrolls through the section
      const words = gsap.utils.toArray<HTMLElement>(".scrub-word");

      gsap.fromTo(
        words,
        { opacity: 0.28, y: 8 },
        {
          opacity: 1,
          y: 0,
          stagger: 0.12,
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top 75%",
            end: "bottom 60%",
            scrub: 0.8,
          },
        }
      );

      // Rotating decorative flairs
      gsap.to(".why-flair-star", {
        rotation: 360,
        repeat: -1,
        duration: 30,
        ease: "none",
      });

      gsap.to(".why-flair-ring", {
        scale: 1.15,
        opacity: 0.7,
        repeat: -1,
        yoyo: true,
        duration: 3.5,
        ease: "sine.inOut",
      });
    },
    { scope: sectionRef }
  );

  return (
    <section
      id="why"
      ref={sectionRef}
      className="home-why relative py-32 sm:py-48 bg-[#0e100f] text-[#fffce1] overflow-hidden border-t border-[#fffce1]/10"
    >
      {/* Background radial glow */}
      <div className="absolute top-1/2 right-1/4 w-[500px] h-[500px] bg-[#0ae448]/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Decorative floating shapes on the right */}
      <div className="absolute right-8 sm:right-24 top-24 w-28 sm:w-48 h-28 sm:h-48 pointer-events-none opacity-80">
        <div className="why-flair-star w-full h-full">
          <HeroStar className="w-full h-full text-[#ff8709]" />
        </div>
      </div>

      <div className="absolute right-16 sm:right-40 bottom-16 w-16 sm:w-28 h-16 sm:h-28 pointer-events-none opacity-50">
        <div className="why-flair-ring w-full h-full border border-dashed border-[#9d95ff] rounded-full flex items-center justify-center">
          <div className="w-3 h-3 rounded-full bg-[#fec5fb]" />
        </div>
      </div>

      <div className="container mx-auto px-6 sm:px-12 max-w-6xl relative z-10">
        {/* Eyebrow in brackets */}
        <div className="mb-12">
          <SubtitleBrackets>Why Pixie®</SubtitleBrackets>
        </div>

        {/* High-impact paragraph mirroring GSAP's why statement */}
        <div className="max-w-5xl">
          <h2 className="text-[clamp(2.4rem,5.5vw,5.2rem)] font-normal tracking-tight leading-[1.12] text-[#fffce1]/95">
            <span className="scrub-word inline-block mr-3">Pixie</span>
            <span className="scrub-word inline-block mr-3">allows</span>
            <span className="scrub-word inline-block mr-3">you</span>
            <span className="scrub-word inline-block mr-3">to</span>
            <span className="scrub-word inline-block mr-3 font-semibold text-[#0ae448] underline decoration-[#0ae448]/40 underline-offset-8">
              effortlessly
            </span>
            <span className="scrub-word inline-block mr-3 font-semibold text-[#0ae448]">
              answer
            </span>
            <span className="scrub-word inline-block mr-3">anything</span>
            <span className="scrub-word inline-block mr-3">your</span>
            <span className="scrub-word inline-block mr-3">community</span>
            <span className="scrub-word inline-block mr-3">asks</span>
            <span className="scrub-word inline-block mr-3">in</span>
            <span className="scrub-word inline-block mr-3 text-[#fec5fb] font-semibold">
              Slack.
            </span>
            <span className="scrub-word inline-block mr-3">Delivering</span>
            <span className="scrub-word inline-block mr-3 font-semibold text-transparent bg-clip-text bg-gradient-to-r from-[#0ae448] to-[#abff84]">
              silky-smooth
            </span>
            <span className="scrub-word inline-block mr-3 font-semibold text-transparent bg-clip-text bg-gradient-to-r from-[#abff84] to-[#00bae2]">
              resolution
            </span>
            <span className="scrub-word inline-block mr-3">and</span>
            <span className="scrub-word inline-block mr-3 font-semibold text-[#ff8709]">
              unmatched
            </span>
            <span className="scrub-word inline-block mr-3 font-semibold text-[#ff8709]">
              verified
            </span>
            <span className="scrub-word inline-block mr-3 font-semibold text-[#fec5fb]">
              support
            </span>
            <span className="scrub-word inline-block mr-3">so</span>
            <span className="scrub-word inline-block mr-3">you</span>
            <span className="scrub-word inline-block mr-3">can</span>
            <span className="scrub-word inline-block mr-3">focus</span>
            <span className="scrub-word inline-block mr-3">on</span>
            <span className="scrub-word inline-block mr-3">the</span>
            <span className="scrub-word inline-block mr-3 font-extrabold text-[#9d95ff] italic">
              fun stuff.
            </span>
          </h2>
        </div>
      </div>
    </section>
  );
}
