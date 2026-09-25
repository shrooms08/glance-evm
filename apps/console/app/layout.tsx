import type { Viewport } from "next";
import type { ReactNode } from "react";

import { rootCss } from "@/lib/styles";
import { themeBootScript } from "@/lib/theme";

/**
 * The one root layout: the document, the theme (set before paint) and the design tokens. Its two groups add the rest:
 * (landing) is the public home page at "/", static and server-rendered; (console) wraps every console page in the
 * wallet stack and the console's shell.
 */
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <style dangerouslySetInnerHTML={{ __html: rootCss() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
