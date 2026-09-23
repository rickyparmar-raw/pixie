import type { Metadata } from "next";
import { JetBrains_Mono, Inter, Poppins } from "next/font/google";
import "./globals.css";

// Three voices: Poppins for headings (matches the marketing site's display
// type), Inter for body/UI copy, JetBrains Mono for operational text.
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-heading" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });
const heading = Poppins({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-heading" });

export const metadata: Metadata = {
  title: "Pixie — grounded support for programs",
  description: "Pixie keeps support questions visible, grounded, and routed to the right person when needed.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable} ${heading.variable}`} suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
