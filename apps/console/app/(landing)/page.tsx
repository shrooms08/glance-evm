import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { demoEmbed } from "@/lib/demoVideo";
import { DASHBOARD_PATH } from "@/lib/routes";

import { HeroStory } from "./HeroStory";

/**
 * The public home page (the approved design in design/landing/, rebuilt natively). Static and server-rendered; the only
 * client code is the hero story and its glyph canvas. Links into the console are plain <a> tags (a full page load), so
 * the console's own styles and wallet stack never mix with this page.
 */

const TITLE = "Glance · Talk to the stocks you read about";
const DESCRIPTION =
  "Glance is a voice agent for tokenized stocks. Hold Option+V on any page and ask: it answers out loud, points at what it means, and buys and sells from a vault only you control.";

export const metadata: Metadata = {
  metadataBase: new URL("https://glance-evm-console.vercel.app"),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: "/", siteName: "Glance" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const GITHUB = "https://github.com/shrooms08/glance-evm";
const X_URL = "https://x.com/shroomsgotsol";
const INSTALL = "/install";

const DOES = [
  ["01", "Reads", "Spots every stock on the page and prices it from Chainlink."],
  ["02", "Speaks", "Hold Option+V and ask. It answers out loud, starting on its first sentence."],
  ["03", "Shows", "Circles, underlines and chart marks on exactly what it's explaining, even on TradingView."],
  ["04", "Buys and sells", "Say 'buy $10 of Tesla' or 'sell half my Tesla'. Your vault checks every rule, then trades."],
] as const;

const LOOP = [
  ["01", "You speak", "Hold Option+V and ask."],
  ["02", "AssemblyAI", "Universal-Streaming, stock names as keyterms."],
  ["03", "Claude", "Numbers computed in code, Claude only narrates."],
  ["04", "Sienna voice", "Speaks from the first sentence."],
] as const;

const CANNOT = [
  "Withdraw your money or send it anywhere.",
  "Buy a token that isn't on your list.",
  "Spend past your caps.",
  "Trade on a stale price or past the slippage limit.",
  "Keep trading after you pause it or its access expires.",
] as const;

const GUARDS = [
  "$100 per trade",
  "$500 buys a day",
  "$500 sells a day",
  "Approved stocks only",
  "Fresh Chainlink price",
  "Max 1% slippage",
  "Agent access expires",
  "Owner can pause",
] as const;

const WEEKEND = [
  ["Per trade", "$100", "$25"],
  ["Buys per 24h", "$500", "$125"],
  ["Sells per 24h", "$500", "$125"],
  ["Max slippage", "1%", "0.5%"],
  ["Oldest price", "20 hours", "96 hours"],
] as const;

const VAULT_STEPS = ["Connect", "Network", "Approve", "Create", "Link"] as const;
const BUILT_WITH = ["Robinhood Chain", "Paxos USDG", "Chainlink", "AssemblyAI", "Claude", "Deepgram"] as const;

function Eyebrow({ children }: { children: string }) {
  return (
    <div className="lp-eyebrow">
      <span className="lp-dot" />
      {children}
    </div>
  );
}

function DemoVideo() {
  const embed = demoEmbed(process.env.NEXT_PUBLIC_DEMO_VIDEO_URL);
  if (embed)
    return (
      <div className="lp-video">
        {/* A YouTube or Loom player needs its own scripts and origin, so a sandbox would break it; the src is built by
            demoEmbed from a fixed https host, never taken as given. */}
        {/* eslint-disable-next-line react/iframe-missing-sandbox */}
        <iframe
          src={embed.src}
          title="Glance demo video"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  return (
    <div className="lp-video" data-testid="demo-placeholder">
      <div className="lp-video-play">
        <span />
      </div>
      <div className="lp-small-mono" style={{ letterSpacing: "0.12em" }}>
        DEMO VIDEO
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
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
              <Eyebrow>Voice agent for tokenized stocks</Eyebrow>
              <h1 className="lp-h1">
                Talk to the stocks you read about<span className="lp-lime">.</span>
              </h1>
              <p className="lp-lede">
                Glance lives on the page you&apos;re reading. Hold Option+V and ask. It answers out loud, points at what it means,
                and buys and sells from a vault only you control.
              </p>
              <div className="lp-cta-block">
                <div className="lp-cta-row">
                  <a href={INSTALL} className="lp-btn lp-btn-primary">
                    Get Glance
                  </a>
                  <a href="#demo" className="lp-btn lp-btn-ghost">
                    <span className="lp-play" />
                    Watch the demo
                  </a>
                </div>
                <div className="lp-small-mono">Chrome, Brave, Edge and Arc · Robinhood Chain testnet</div>
              </div>
            </div>
            <HeroStory />
          </div>
        </header>

        <section id="demo" className="lp-wrap" aria-label="Demo video" style={{ scrollMarginTop: 80 }}>
          <DemoVideo />
        </section>

        <section id="how" className="lp-wrap lp-section" style={{ scrollMarginTop: 40 }}>
          <div className="lp-head">
            <Eyebrow>What it does</Eyebrow>
            <h2 className="lp-h2">Reads. Speaks. Shows. Buys and sells<span className="lp-lime">.</span></h2>
          </div>
          <div className="lp-cards">
            {DOES.map(([n, title, body]) => (
              <div key={n} className="lp-card">
                <span className="lp-card-n">{n}</span>
                <span className="lp-card-title">{title}</span>
                <span className="lp-card-body">{body}</span>
              </div>
            ))}
          </div>
          <div className="lp-shots">
            <figure className="lp-shot lp-shot-wide">
              <div className="lp-shot-frame">
                <Image
                  src="/landing/tradingview-tsla.png"
                  alt="The Glance panel open over a TradingView chart of TSLA, priced from Chainlink"
                  fill
                  sizes="(max-width: 767px) 100vw, 780px"
                  style={{ objectFit: "cover", objectPosition: "right top" }}
                />
              </div>
              <figcaption>Over TradingView, pricing TSLA from Chainlink</figcaption>
            </figure>
            <figure className="lp-shot lp-shot-narrow">
              <div className="lp-shot-frame">
                <Image
                  src="/landing/panel-chart.png"
                  alt="The Glance panel with a live price chart"
                  fill
                  sizes="(max-width: 767px) 100vw, 400px"
                  style={{ objectFit: "cover", objectPosition: "center top" }}
                />
              </div>
              <figcaption>The panel, live price chart</figcaption>
            </figure>
          </div>
        </section>

        <section className="lp-wrap lp-section lp-section-last" aria-labelledby="loop-h">
          <div className="lp-head">
            <Eyebrow>The voice loop</Eyebrow>
            <h2 id="loop-h" className="lp-h2">
              Hold Option+V. Ask. Hear the answer<span className="lp-lime">.</span>
            </h2>
          </div>
          <div className="lp-flow">
            {LOOP.map(([n, title, body], i) => (
              <FlowStep key={n} n={n} title={title} body={body} last={i === LOOP.length - 1} />
            ))}
          </div>
          <div className="lp-stats">
            <div className="lp-stat">
              <span className="lp-stat-n">0.73s</span>
              <span className="lp-stat-label">to the first spoken word in our benchmark</span>
            </div>
            <div className="lp-stat">
              <span className="lp-stat-n">25/25</span>
              <span className="lp-stat-label">25 of 25 test commands understood, tickers included</span>
            </div>
          </div>
        </section>

        <section id="safety" className="lp-safety" aria-labelledby="safety-h">
          <div className="lp-wrap lp-safety-inner">
            <Eyebrow>Safety</Eyebrow>
            <h2 id="safety-h" className="lp-safety-h">
              Even if our servers were stolen, Glance still cannot:
            </h2>
            <ol className="lp-cannot">
              {CANNOT.map((line, i) => (
                <li key={line}>
                  <span className="lp-cannot-n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="lp-cannot-text">{line}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <div className="lp-wrap lp-after-safety">
          <p className="lp-note">
            On mainnet the vault reads Chainlink&apos;s feeds directly. On this testnet, Glance&apos;s keeper mirrors them.
          </p>
          <ul className="lp-chips" aria-label="The guards on every trade">
            {GUARDS.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
          <p className="lp-note">
            <strong>Drift guard:</strong> if the on-chain price falls behind the market by more than 2%, Glance won&apos;t trade.
          </p>
        </div>

        <section className="lp-wrap lp-weekend" aria-labelledby="weekend-h">
          <div className="lp-head">
            <Eyebrow>Weekend guard</Eyebrow>
            <h2 id="weekend-h" className="lp-h2">
              Closed market, shorter leash<span className="lp-lime">.</span>
            </h2>
          </div>
          <table className="lp-table">
            <colgroup>
              <col style={{ width: "39.4%" }} />
              <col style={{ width: "30.3%" }} />
              <col style={{ width: "30.3%" }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">LIMIT</th>
                <th scope="col" className="lp-open">
                  <span className="lp-th-state">
                    <span className="lp-dot" />
                    MARKET OPEN
                  </span>
                </th>
                <th scope="col" className="lp-closed">
                  <span className="lp-th-state">
                    <span className="lp-dot lp-closed-dot" />
                    MARKET CLOSED
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {WEEKEND.map(([label, open, closed]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td className="lp-open">{open}</td>
                  <td className="lp-closed">{closed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="lp-wrap lp-section" aria-labelledby="vault-h">
          <div className="lp-head">
            <Eyebrow>Your vault</Eyebrow>
            <h2 id="vault-h" className="lp-h2">
              Set up in five wallet prompts<span className="lp-lime">.</span>
            </h2>
          </div>
          <ol className="lp-steps">
            {VAULT_STEPS.map((s, i) => (
              <li key={s}>
                <span className="lp-card-n">{String(i + 1).padStart(2, "0")}</span>
                <strong>{s}</strong>
              </li>
            ))}
          </ol>
          <p className="lp-note">New wallets get starter gas and 20 Paxos USDG.</p>
          <div className="lp-dashboard">
            <Image
              src="/landing/console-dashboard.png"
              alt="The Glance console dashboard: vault balance, holdings and the guards on the agent"
              width={2000}
              height={1430}
              sizes="(max-width: 1248px) 100vw, 1152px"
            />
          </div>
        </section>

        <section className="lp-wrap lp-built" aria-label="Built with">
          <div className="lp-eyebrow">Built with</div>
          <ul className="lp-built-list">
            {BUILT_WITH.map((b, i) => (
              <li key={b}>
                {b}
                {i < BUILT_WITH.length - 1 ? <span aria-hidden="true"> ·</span> : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-wrap lp-closing" aria-labelledby="closing-h">
          <h2 id="closing-h" className="lp-closing-h">
            Buy from the headline<span className="lp-lime">.</span>
          </h2>
          <div className="lp-cta-row">
            <a href={INSTALL} className="lp-btn lp-btn-primary">
              Get Glance
            </a>
            <a href={DASHBOARD_PATH} className="lp-btn lp-btn-ghost">
              Open console
            </a>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <div className="lp-footer-note">
            <Image src="/landing/glance-mark.png" alt="" width={20} height={20} />
            <span>Testnet only. Prices on testnet mirror Chainlink mainnet feeds. Not financial advice.</span>
          </div>
          <div className="lp-foot-links">
            <a href={GITHUB}>GitHub</a>
            <a href={DASHBOARD_PATH}>Console</a>
            <a href={X_URL}>X @shroomsgotsol</a>
          </div>
        </div>
      </footer>
    </>
  );
}

function FlowStep({ n, title, body, last }: { n: string; title: string; body: string; last: boolean }) {
  return (
    <>
      <div className="lp-flow-step">
        <span className="lp-card-n">{n}</span>
        <span className="lp-flow-title">{title}</span>
        <span className="lp-flow-body">{body}</span>
      </div>
      {last ? null : (
        <span className="lp-flow-arrow" aria-hidden="true">
          <span className="lp-flow-arrow-right">→</span>
          <span className="lp-flow-arrow-down">↓</span>
        </span>
      )}
    </>
  );
}
