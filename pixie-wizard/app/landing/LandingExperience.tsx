"use client";

import React, { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { LandingHero } from "./LandingHero";
import { LandingWhy } from "./LandingWhy";
import { LandingKinetic } from "./LandingKinetic";
import { LandingTools } from "./LandingTools";
import { LandingCommunities } from "./LandingCommunities";
import { LandingShowcase } from "./LandingShowcase";
import { LandingFooter } from "./LandingFooter";
import "./landing.css";

gsap.registerPlugin(ScrollTrigger, useGSAP);

export function LandingExperience() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add("(prefers-reduced-motion: no-preference)", () => {
        // Refresh ScrollTrigger after elements mount
        ScrollTrigger.refresh();
      });

      return () => media.revert();
    },
    { scope: rootRef }
  );

  const handleExplore = () => {
    const whyEl = document.getElementById("why");
    if (whyEl) {
      whyEl.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <div
      ref={rootRef}
      className="landing-root bg-[#0e100f] text-[#fffce1] selection:bg-[#0ae448] selection:text-[#0e100f] min-h-screen overflow-x-hidden font-sans"
    >
      {/* 1. Hero Section with Top Announcement & Floating Navbar */}
      <LandingHero onExploreClick={handleExplore} />

      {/* 2. { Why Pixie® } Section with Scrub Highlighting */}
      <LandingWhy />

      {/* 3. Kinetic Typography Horizontal Scroll & Bezier Graph */}
      <LandingKinetic />

      {/* 4. { Pixie® Tools } Section (Slack Ingestion, Evidence Engine, Smart Handoff, Knowledge Matrix) */}
      <LandingTools />

      {/* 5. { Communities using Pixie® } Logos & Metrics */}
      <LandingCommunities />

      {/* 6. Showcase 3D Card Carousel with Live Interactive Sandbox */}
      <LandingShowcase />

      {/* 7. Footer: 6-Column Directory & Warm Cream Newsletter */}
      <LandingFooter />
    </div>
  );
}
