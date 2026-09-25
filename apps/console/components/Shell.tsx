"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { env } from "@/lib/env";
import { useExtensionInstalled } from "@/lib/extensionPresence";
import { trackInputModality } from "@/lib/inputModality";
import { useTheme } from "@/lib/theme";
import { useHref } from "@/lib/vault";

import { Connect } from "./Connect";
import { Mark } from "./Mark";
import { VaultSwitcher } from "./VaultSwitcher";

const NAV = [
  { path: "/dashboard", label: "Dashboard" },
  { path: "/limits", label: "Limits" },
  { path: "/activity", label: "Activity" },
  { path: "/prices", label: "Prices" },
  { path: "/start", label: "Get started" },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const href = useHref();
  const { theme, toggle } = useTheme();
  const installed = useExtensionInstalled();
  // Focus rings for keyboard users only (see globals.css).
  useEffect(() => trackInputModality(), []);
  return (
    <div className="shell">
      <header className="top">
        <div className="top-row">
          <Link href={href("/dashboard")} className="brand" aria-label="Glance console home">
            <Mark size={28} />
            <span className="brand-name">Glance</span>
            <span className="brand-sub">console</span>
          </Link>
          <div className="top-tools">
            <VaultSwitcher />
            <button className="btn btn-ghost btn-icon" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`${theme === "dark" ? "Light" : "Dark"} mode`}>
              <span className="theme-glyph" data-theme-glyph={theme} aria-hidden />
            </button>
            <Connect />
          </div>
        </div>
        <nav className="nav" aria-label="Console">
          {NAV.map((n) => (
            <Link key={n.path} href={href(n.path)} className="nav-link" aria-current={pathname === n.path ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
          {/* Until Glance is detected in this browser. */}
          {!installed && (
            <Link href="/install" className="nav-link text-accent" aria-current={pathname === "/install" ? "page" : undefined}>
              Get Glance
            </Link>
          )}
        </nav>
      </header>
      <main className="main">{children}</main>
      <footer className="foot meta">
        <span>Robinhood Chain testnet · chain 46630</span>
        <span>
          Reads from the Glance API at <span className="mono">{env.apiUrl}</span>. Writes go only through your own wallet: the console never
          holds a key.
        </span>
      </footer>
    </div>
  );
}
