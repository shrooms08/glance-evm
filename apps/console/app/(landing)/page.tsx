import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PATTERN_NAMES } from "@glance/core/candles";

import { demoWatchUrl } from "@/lib/demoVideo";
import { DASHBOARD_PATH } from "@/lib/routes";

import { HeroStory } from "./HeroStory";
import { Reveal } from "./Reveal";

/**
 * The public home page. Static and server-rendered; the only client code is the hero story (its glyph canvas) and the
 * scroll reveal. Links into the console are plain <a> tags (a full page load), so the console's own styles and wallet
 * stack never mix with this page.
 *
 * Every number here is from the repo: CONTRACT_TESTS is `forge test` (docs/audit.md), the line coverage is
 * docs/audit.md's coverage table, CANDLE_PATTERNS counts PATTERN_NAMES in packages/core/src/candles.ts, and the 25/25 is
 * the voice benchmark in README.md.
 */

const TITLE = "Glance · Your stock buddy";
const DESCRIPTION =
  "Reading about a stock? Hold Option+V and ask. Glance explains it out loud, points at the chart, and buys it when you say so, from a vault only you control.";

export const metadata: Metadata = {
  metadataBase: new URL("https://glance-evm-console.vercel.app"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: "/", siteName: "Glance" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const GITHUB = "https://github.com/shrooms08/glance-evm";
const SECURITY_NOTES = `${GITHUB}/blob/main/SECURITY.md`;
const INSTALL = "/install";

/** `forge test`: every contract test passes (docs/audit.md). */
const CONTRACT_TESTS = 180;
/** Candle formations Glance spots: every one the detector names (packages/core/src/candles.ts). */
const CANDLE_PATTERNS = Object.keys(PATTERN_NAMES).length;

const BUILT_ON = ["Built on Robinhood Chain", "Arbitrum Orbit", "Settled in Paxos USDG", "Prices from Chainlink"] as const;

const DOES = [
  ["Ask out loud", "Hold Option+V on any page and ask about the stock you're reading."],
  ["It points at the chart", `Glance draws on the chart on the page and spots ${CANDLE_PATTERNS} candle patterns.`],
  ["Buy when you say so", "Small trades in USDG, straight from your own vault."],
] as const;

const STEPS = [
  ["Add Glance to your browser", "Chrome, Brave, Edge or Arc. It takes a minute."],
  ["Set up your vault", "One click starts it. Answer your wallet's prompts, and the faucet sends test USDG so you can try it free."],
  ["Hold Option+V and ask", "On any page. Glance answers out loud and shows you what it means."],
] as const;

const RULES = [
  "Only you can withdraw your money.",
  "Glance only trades stocks on your list.",
  "Every trade and every day has a cap you can see.",
  "Smaller limits when the market is closed.",
  "Pause Glance or let its access expire, anytime.",
] as const;

const FAQ = [
  ["Is this real money?", "No. Glance runs on Robinhood Chain testnet with test USDG."],
  ["Can Glance take my money?", "No. Only you can withdraw, and every trade stays inside the limits you set."],
  ["Which browsers?", "Chrome, Brave, Edge and Arc."],
  ["Which wallet do I need?", "MetaMask, Rabby or Brave Wallet, or another wallet that can add Robinhood Chain. Phantom can't yet."],
] as const;

function Eyebrow({ children }: { children: string }) {
  return (
    <div className="lp-eyebrow">
      <span className="lp-dot" />
      {children}
    </div>
  );
}

function GetGlance() {
  return (
    <a href={INSTALL} className="lp-btn lp-btn-primary">
      Get Glance
    </a>
  );
}

export default function LandingPage() {
  const demo = demoWatchUrl(process.env.NEXT_PUBLIC_DEMO_VIDEO_URL);
  return (
    <>
      <Reveal />
      <nav className="lp-nav" aria-label="Main">
        <div className="lp-wrap lp-nav-row">
          <Link href="/" className="lp-brand">
            <Image src="/landing/glance-mark.png" alt="" width={28} height={28} priority />
            Glance
          </Link>
          <div className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#safety">Safety</a>
            <a href={GITHUB}>GitHub</a>
          </div>
          <div className="lp-nav-cta">
            <a href={DASHBOARD_PATH} className="lp-btn lp-btn-sm lp-btn-ghost lp-nav-console">
              Open console
            </a>
            <a href={INSTALL} className="lp-btn lp-btn-sm lp-btn-primary">
              Get Glance
            </a>
          </div>
        </div>
      </nav>

      <main>
        <header className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-copy">
              <Eyebrow>Your stock buddy</Eyebrow>
              <h1 className="lp-h1">
                Meet Glance, your stock buddy<span className="lp-lime">.</span>
              </h1>
              <p className="lp-lede">
                Reading about a stock? Hold Option+V and ask. Glance explains it out loud, points at the chart, and buys it when you
                say so, from a vault only you control.
              </p>
              <div className="lp-cta-block">
                <div className="lp-cta-row">
                  <GetGlance />
                  <a href={demo} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-ghost">
                    <span className="lp-play" />
                    Watch the demo
                  </a>
                </div>
                <div className="lp-small-mono">Free · Chrome, Brave, Edge and Arc · Robinhood Chain testnet</div>
              </div>
            </div>
            <HeroStory />
          </div>
        </header>

        <section className="lp-wrap lp-strip" aria-label="Built on">
          <ul>
            {BUILT_ON.map((b, i) => (
              <li key={b}>
                {b}
                {i < BUILT_ON.length - 1 ? <span aria-hidden="true"> ·</span> : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-wrap lp-section" aria-labelledby="does-h" data-reveal>
          <div className="lp-head">
            <Eyebrow>What Glance does</Eyebrow>
            <h2 id="does-h" className="lp-h2">
              Ask. Look. Buy<span className="lp-lime">.</span>
            </h2>
          </div>
          <div className="lp-cards">
            {DOES.map(([title, body]) => (
              <div key={title} className="lp-card">
                <span className="lp-card-title">{title}</span>
                <span className="lp-card-body">{body}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="lp-wrap lp-section" aria-labelledby="how-h" data-reveal>
          <div className="lp-head">
            <Eyebrow>How it works</Eyebrow>
            <h2 id="how-h" className="lp-h2">
              Three steps<span className="lp-lime">.</span>
            </h2>
          </div>
          <ol className="lp-steps">
            {STEPS.map(([title, body], i) => (
              <li key={title}>
                <span className="lp-step-n">{i + 1}</span>
                <span className="lp-card-title">{title}</span>
                <span className="lp-card-body">{body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section id="safety" className="lp-wrap lp-section" aria-labelledby="safety-h" data-reveal>
          <div className="lp-safety">
            <div className="lp-head">
              <Eyebrow>Safety</Eyebrow>
              <h2 id="safety-h" className="lp-h2">
                You set the rules. Your vault enforces them<span className="lp-lime">.</span>
              </h2>
            </div>
            <ul className="lp-rules">
              {RULES.map((line) => (
                <li key={line}>
                  <span className="lp-check" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p className="lp-note">
              On mainnet the vault reads Chainlink&apos;s feeds directly. On this testnet, Glance&apos;s keeper mirrors them. Read our{" "}
              <a href={SECURITY_NOTES} className="lp-link">
                security notes
              </a>
              .
            </p>
          </div>
        </section>

        <section className="lp-wrap lp-section" aria-label="In numbers" data-reveal>
          <div className="lp-stats">
            <div className="lp-stat">
              <span className="lp-stat-n">{CONTRACT_TESTS}</span>
              <span className="lp-stat-label">contract tests passing</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-n">100%</span>
              <span className="lp-stat-label">line coverage on the production contracts</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-n">25/25</span>
              <span className="lp-stat-label">voice test commands understood</span>
            </div>
            <a className="lp-stat lp-stat-link" href={GITHUB}>
              <span className="lp-stat-n">Open</span>
              <span className="lp-stat-label">source, on GitHub ↗</span>
            </a>
          </div>
        </section>

        <section className="lp-wrap lp-section" aria-labelledby="faq-h" data-reveal>
          <div className="lp-head">
            <Eyebrow>Questions</Eyebrow>
            <h2 id="faq-h" className="lp-h2">
              Good to know<span className="lp-lime">.</span>
            </h2>
          </div>
          <div className="lp-faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="lp-wrap lp-closing" aria-labelledby="closing-h" data-reveal>
          <h2 id="closing-h" className="lp-closing-h">
            Your stock buddy is one click away<span className="lp-lime">.</span>
          </h2>
          <GetGlance />
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <div className="lp-footer-note">
            <Image src="/landing/glance-mark.png" alt="" width={20} height={20} />
            <span>Glance</span>
          </div>
          <div className="lp-foot-links">
            <a href={GITHUB}>GitHub</a>
            <a href={SECURITY_NOTES}>Security</a>
            <span>Built for Arbitrum Open House Singapore</span>
          </div>
        </div>
      </footer>
    </>
  );
}
