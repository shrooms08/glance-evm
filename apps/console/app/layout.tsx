import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ClientRoot } from "@/components/ClientRoot";
import { rootCss } from "@/lib/styles";
import { themeBootScript } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: "Glance console",
  description: "See and control your Glance vault: balances, the guards on your agent, every trade and every refusal.",
  // The Glance extension looks for this to know it's on the console (and marks itself installed here).
  other: { "glance-console": "1" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <style dangerouslySetInnerHTML={{ __html: rootCss() }} />
      </head>
      <body>
        <ClientRoot>{children}</ClientRoot>
      </body>
    </html>
  );
}
