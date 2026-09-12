import type { Metadata } from "next";
import { JetBrains_Mono, Inter, Poppins } from "next/font/google";
import "./globals.css";

// Three voices: Poppins for headings (matches the marketing site's display
// type), Inter for body/UI copy, JetBrains Mono for operational text.
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-heading" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });
const heading = Poppins({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-heading" });

export const metadata: Metadata = {
  title: "Pixie Wizard",
  description: "Set up hosted Pixie for your Hack Club program",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// Runs before paint so the stored/system theme applies without a flash of
// the wrong palette. Kept tiny and inline — this is the one script on the
// page that must not wait for hydration.
const themeInitScript = `(function(){try{var t=localStorage.getItem('pixie-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${sans.variable} ${heading.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
