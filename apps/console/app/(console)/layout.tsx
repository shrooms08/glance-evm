import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ClientRoot } from "@/components/ClientRoot";

import "./globals.css";

export const metadata: Metadata = {
  title: "Glance console",
  description: "See and control your Glance vault: balances, the guards on your agent, every trade and every refusal.",
  // The Glance extension looks for this to know it's on the console (and marks itself installed here).
  other: { "glance-console": "1" },
};

/** Every console page: the wallet stack (in the browser only) and the console's shell. */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <ClientRoot>{children}</ClientRoot>;
}
