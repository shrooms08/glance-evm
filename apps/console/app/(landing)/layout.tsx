import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";

import { landingVariables } from "@glance/design";

import "./landing.css";

// Self-hosted at build time with a size-adjusted fallback, so the fonts never shift the layout.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

/** The public home page: static, server-rendered, outside the console's wallet stack. */
export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* The page's palette, from @glance/design (the only place a colour is written). */}
      <style dangerouslySetInnerHTML={{ __html: `:root {\n  ${landingVariables()}\n}` }} />
      <div className={`landing ${geist.variable} ${geistMono.variable}`}>{children}</div>
    </>
  );
}
