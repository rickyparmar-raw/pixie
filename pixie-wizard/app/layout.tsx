import type { Metadata } from "next";
import { JetBrains_Mono, Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

// Three voices: Space Grotesk for headings (distinctive, technical, pairs
// with mono), Inter for body/UI copy, JetBrains Mono for operational text.
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-heading" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });
const heading = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-heading" });

export const metadata: Metadata = {
  title: "Pixie Wizard",
  description: "Set up hosted Pixie for your Hack Club program",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable} ${heading.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
