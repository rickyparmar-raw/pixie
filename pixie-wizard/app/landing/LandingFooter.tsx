"use client";

import React, { useState } from "react";

export function LandingFooter() {
  const [email, setEmail] = useState("");
  const [subscribed, setSubscribed] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      setSubscribed(true);
    }
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <footer className="footer-root w-full bg-[#0e100f] text-[#fffce1] border-t border-[#fffce1]/10">
      {/* 1. Multi-Column Navigation Directory */}
      <div className="container mx-auto px-6 sm:px-12 py-20 max-w-6xl">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-8 text-sm">
          {/* Column 1: Pixie */}
          <div className="flex flex-col gap-3">
            <span className="font-bold text-[#0ae448] uppercase tracking-wider text-xs">
              Pixie
            </span>
            <a href="#top" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Core Engine
            </a>
            <a href="#why" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Why Pixie
            </a>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Tools &amp; APIs
            </a>
            <a href="/api/auth/login" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Dashboard
            </a>
          </div>

          {/* Column 2: Slack */}
          <div className="flex flex-col gap-3">
            <span className="font-bold text-[#fffce1] uppercase tracking-wider text-xs">
              Slack
            </span>
            <a href="/api/auth/login" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Add to Slack
            </a>
            <a href="#showcase" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Channel Ingestion
            </a>
            <a href="#showcase" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Thread Resolvers
            </a>
            <a href="#showcase" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Bot Commands
            </a>
          </div>

          {/* Column 3: Evidence */}
          <div className="flex flex-col gap-3">
            <span className="font-bold text-[#ff8709] uppercase tracking-wider text-xs">
              Evidence
            </span>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Source Crawler
            </a>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Citation Engine
            </a>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Confidence Score
            </a>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Hallucination Guard
            </a>
          </div>

          {/* Column 4: Routing */}
          <div className="flex flex-col gap-3">
            <span className="font-bold text-[#00c5ff] uppercase tracking-wider text-xs">
              Routing
            </span>
            <a href="#showcase" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Smart Handoff
            </a>
            <a href="#showcase" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Helper Profiles
            </a>
            <a href="#showcase" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Escalation SLA
            </a>
            <a href="#showcase" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Resolution History
            </a>
          </div>

          {/* Column 5: Integrations */}
          <div className="flex flex-col gap-3">
            <span className="font-bold text-[#9d95ff] uppercase tracking-wider text-xs">
              Integrations
            </span>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              GitHub Sync
            </a>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Notion Grounding
            </a>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Linear Tickets
            </a>
            <a href="#tools" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Webhooks API
            </a>
          </div>

          {/* Column 6: Security */}
          <div className="flex flex-col gap-3">
            <span className="font-bold text-[#fffce1]/50 uppercase tracking-wider text-xs">
              Security
            </span>
            <a href="#why" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              No Training on DMs
            </a>
            <a href="#why" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Audit Logs
            </a>
            <a href="#why" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              GDPR Compliance
            </a>
            <a href="#why" className="text-[#fffce1]/70 hover:text-[#fffce1] transition-colors">
              Data Retention
            </a>
          </div>
        </div>
      </div>

      {/* 2. Warm Cream Newsletter Container */}
      <div className="w-full bg-[#fffce1] text-[#0e100f] py-20 px-6 sm:px-12 rounded-t-[40px] sm:rounded-t-[56px] shadow-2xl">
        <div className="container mx-auto max-w-6xl">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center mb-16">
            {/* Left Headline */}
            <div className="lg:col-span-7">
              <h2 className="text-3xl sm:text-5xl lg:text-6xl font-normal tracking-tight leading-[1.1] text-[#0e100f] mb-4">
                Keep in the loop with the Pixie® newsletter.
              </h2>
              <p className="text-base sm:text-lg text-[#0e100f]/70 max-w-lg">
                Fresh updates on grounded Slack assistance, knowledge matrix algorithms, and product guides.
              </p>
            </div>

            {/* Right Email Form */}
            <div className="lg:col-span-5">
              {subscribed ? (
                <div className="bg-[#0e100f] text-[#0ae448] p-5 rounded-full text-center font-bold text-sm">
                  ✓ You&apos;re in the loop! Thanks for subscribing.
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="flex items-center relative">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email Address"
                    className="w-full bg-white border border-[#0e100f]/15 rounded-full py-4 pl-6 pr-14 text-sm sm:text-base text-[#0e100f] placeholder-[#0e100f]/40 focus:outline-none focus:border-[#0e100f] shadow-sm"
                  />
                  <button
                    type="submit"
                    aria-label="Subscribe to newsletter"
                    className="absolute right-2 w-10 h-10 rounded-full bg-[#0e100f] text-[#fffce1] hover:bg-[#0ae448] hover:text-[#0e100f] flex items-center justify-center transition-colors text-lg"
                  >
                    →
                  </button>
                </form>
              )}
            </div>
          </div>

          {/* Bottom Bar in Cream container */}
          <div className="pt-10 border-t border-[#0e100f]/10 flex flex-col sm:flex-row items-center justify-between gap-6 text-xs sm:text-sm font-medium text-[#0e100f]/70">
            <div className="flex items-center gap-6">
              <span className="font-black text-xl text-[#0e100f] tracking-tight">pixie.</span>
              <span>© 2026 Pixie Support, Inc. All rights reserved.</span>
            </div>

            <div className="flex items-center gap-6">
              <a href="https://github.com" target="_blank" rel="noreferrer" className="hover:text-[#0e100f]">
                GitHub
              </a>
              <a href="https://slack.com" target="_blank" rel="noreferrer" className="hover:text-[#0e100f]">
                Slack
              </a>
              <a href="/privacy" className="hover:text-[#0e100f]">
                Privacy
              </a>
              <a href="/terms" className="hover:text-[#0e100f]">
                Terms
              </a>
              <button
                onClick={scrollToTop}
                className="w-8 h-8 rounded-full border border-[#0e100f]/20 flex items-center justify-center text-xs hover:border-[#0e100f] transition-colors"
                aria-label="Scroll to top"
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
