import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import "./globals.css";

// Two voices: Inter for body/UI copy, JetBrains Mono for operational text.
// The third — the pixel display face — is `public/pixelify.woff2`, declared as
// "Pixie Pixel" in globals.css and shared with the landing page and the setup
// wizard, so there is no third font file to load here.
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-heading" });
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });

// Night is the default palette (see globals.css), so a returning day-mode user
// would otherwise get a flash of the night ground before React hydrates. Stamp
// the stored choice onto <html> before the first paint instead. Static string,
// wrapped in try/catch because localStorage throws outright in some privacy
// modes — and a blocked read just means "no preference", which is night.
const themeStamp = `try{var t=localStorage.getItem("pixie-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}`;

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
    <html lang="en" className={`${mono.variable} ${sans.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeStamp }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
