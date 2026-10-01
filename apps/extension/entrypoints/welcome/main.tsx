/**
 * Welcome: opened once, on install (and again from Settings, "Show welcome again"). First a spoken intro (./Intro.tsx:
 * the orb, one caption at a time, then "Set me up" or "Replay intro"); then the setup steps, the structure of GLANCE by
 * Heylana's first run, with this product's facts (lib/welcome.ts):
 *   Hey. I'm Glance.   pick a wallet: the console's Get started page opens (the "Glance tab")
 *   Fund the vault.    Setup 1 of 2: an amount to start with
 *   Set my leash.      Setup 2 of 2: the vault's limits; "Let's go" opens Get started again
 *   Almost there       waits for the console's report (this page updates by itself)
 *   All set            how to glance and talk; "That's a glance." after the first answer
 * Everything the wallet signs happens on the console's own page: this page only reads what the console reported.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";

import { Orb } from "../../components/Orb";
import { introStart } from "../../lib/intro";
import { Intro, webIntroPlayer } from "./Intro";
import { api } from "../../lib/api";
import { mountPageStyles } from "../../lib/extensionPage";
import { keyLabel } from "../../lib/hotkeys";
import { openConsolePage } from "../../lib/linking";
import { setupComplete, setupProgress } from "../../lib/readiness";
import { consoleUrl, hotkeyLetter, voiceKeyLetter } from "../../lib/settings";
import { celebrate, firstAnswerAt, WALLET_DOWNLOAD_URL, WELCOME, welcomeStage } from "../../lib/welcome";

const openStart = () => void openConsolePage("start");

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="g-meta" style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>
      {children}
    </span>
  );
}

function Tile({ selected, onClick, children }: { selected?: boolean; onClick?(): void; children: ReactNode }) {
  return (
    <button className="g-chip" aria-pressed={selected} onClick={onClick} disabled={!onClick} style={{ fontFamily: "var(--g-font)", justifyContent: "center", padding: "12px 8px", opacity: 1 }}>
      {children}
    </button>
  );
}

function Stage({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 12, animation: "g-in var(--g-panel) var(--g-ease)" }}>{children}</div>;
}

function Heading({ children, level = 2 }: { children: ReactNode; level?: 1 | 2 }) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <H className="g-heading" style={{ margin: 0 }}>
      {children}
    </H>
  );
}

function SignIn({ welcome, opened, onOpen }: { welcome: boolean; opened: boolean; onOpen(): void }) {
  const w = WELCOME.signIn;
  return (
    <Stage>
      <Heading level={1}>{w.heading}</Heading>
      <p className="g-body" style={{ margin: 0, color: "var(--g-mute)" }}>
        {welcome ? w.installed : ""}
        {w.intro}
      </p>
      <section className="g-card">
        <div className="g-section">
          {!opened ? (
            <>
              <Eyebrow>{w.step1}</Eyebrow>
              <span className="g-ui">{w.pick}</span>
              <button className="g-btn g-btn-primary" onClick={onOpen}>
                {w.wallet}
              </button>
              <button className="g-btn" onClick={() => void browser.tabs.create({ url: WALLET_DOWNLOAD_URL })}>
                {w.noWallet}
              </button>
            </>
          ) : (
            <>
              <Eyebrow>{w.step2}</Eyebrow>
              <div className="g-between" style={{ border: "1px solid var(--g-line-strong)", borderRadius: "var(--g-r-md)", padding: "10px 12px" }}>
                <span className="g-mono g-meta">{w.tabOpen}</span>
                <span className="g-state">{w.waiting}</span>
              </div>
              <span className="g-ui">{w.approve}</span>
              <span className="g-meta">{w.updates}</span>
            </>
          )}
        </div>
      </section>
    </Stage>
  );
}

function Setup({ symbols, vaultFound }: { symbols: string[]; vaultFound: boolean }) {
  const [stage, setStage] = useState<"fund" | "leash" | "console">("fund");
  const [fund, setFund] = useState(50);
  if (stage === "fund") {
    const w = WELCOME.fund;
    return (
      <Stage>
        <Eyebrow>{w.eyebrow}</Eyebrow>
        <Heading>{w.heading}</Heading>
        <p className="g-body" style={{ margin: 0, color: "var(--g-mute)" }}>
          {w.body}
        </p>
        <div role="group" aria-label="Amount to add" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {w.tiles.map((v) => (
            <Tile key={v} selected={fund === v} onClick={() => setFund(v)}>
              ${v}
            </Tile>
          ))}
        </div>
        <button className="g-btn g-btn-primary" onClick={() => setStage("leash")}>
          {w.button(fund)}
        </button>
        <span className="g-mono g-meta">{w.note}</span>
      </Stage>
    );
  }
  if (stage === "leash") {
    const w = WELCOME.leash;
    return (
      <Stage>
        <Eyebrow>{w.eyebrow}</Eyebrow>
        <Heading>{w.heading}</Heading>
        <p className="g-body" style={{ margin: 0, color: "var(--g-mute)" }}>
          {w.body}
        </p>
        <div role="group" aria-label="Your leash" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {w.tiles.map((t) => (
            <Tile key={t} selected>
              {t}
            </Tile>
          ))}
        </div>
        <button
          className="g-btn g-btn-primary"
          onClick={() => {
            setStage("console");
            openStart();
          }}
        >
          {w.button}
        </button>
        <span className="g-mono g-meta">{w.note}</span>
      </Stage>
    );
  }
  const w = WELCOME.almost;
  return (
    <Stage>
      <Eyebrow>{w.eyebrow}</Eyebrow>
      <Heading>{w.heading}</Heading>
      <p className="g-body" style={{ margin: 0, color: "var(--g-mute)" }}>
        {w.body(fund, symbols)}
      </p>
      <section className="g-card">
        <div className="g-section">
          <span className="g-ui">{vaultFound ? w.found : w.waiting}</span>
        </div>
      </section>
      <button className="g-btn" onClick={openStart}>
        {w.reopen}
      </button>
      <button className="g-btn g-btn-ghost g-mono g-meta" onClick={() => setStage("fund")}>
        {w.change}
      </button>
    </Stage>
  );
}

function TryIt({ glanceKey, voiceKey, example, celebrated, onDone }: { glanceKey: string; voiceKey: string; example: string; celebrated: boolean; onDone(): void }) {
  const w = WELCOME.tryIt;
  const [before, gKey, middle, vKey, after] = w.body(glanceKey, voiceKey, example);
  return (
    <Stage>
      {celebrated ? <Confetti /> : null}
      <Eyebrow>{w.eyebrow}</Eyebrow>
      <Heading>{celebrated ? w.celebrated : w.heading}</Heading>
      <p className="g-body" style={{ margin: 0, color: "var(--g-mute)" }}>
        {celebrated ? (
          w.done
        ) : (
          <>
            {before}
            <kbd className="g-kbd">{gKey}</kbd>
            {middle}
            <kbd className="g-kbd">{vKey}</kbd>
            {after}
          </>
        )}
      </p>
      <button className="g-btn" onClick={onDone}>
        {w.button}
      </button>
    </Stage>
  );
}

/** The first answer's celebration: 24 pieces falling once (none under reduced motion). */
function Confetti() {
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return null;
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden" }} data-testid="confetti">
      {Array.from({ length: 24 }, (_, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            top: 0,
            left: `${(i * 37) % 100}%`,
            width: 6,
            height: 8,
            borderRadius: 2,
            background: i % 3 === 0 ? "var(--g-lime)" : i % 3 === 1 ? "var(--g-text)" : "var(--g-mute)",
            animation: `g-fall ${1.6 + (i % 5) * 0.2}s cubic-bezier(.2,.7,.3,1) ${(i % 7) * 0.08}s forwards`,
          }}
        />
      ))}
      <style>{"@keyframes g-fall{to{transform:translateY(110vh) rotate(360deg);opacity:.2}}"}</style>
    </div>
  );
}

function Welcome() {
  const params = new URLSearchParams(location.search);
  const welcome = params.has("installed");
  // First the spoken intro (on install, from Settings, or before setup); "Set me up" leads to the setup steps.
  const [view, setView] = useState<"loading" | "intro" | "setup">("loading");
  const [autoplay, setAutoplay] = useState(false);
  const player = useMemo(() => webIntroPlayer((path) => browser.runtime.getURL(path as "/welcome.html")), []);
  const [openedAt] = useState(() => Date.now());
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<{ wallet: boolean; vault: boolean } | null>(null);
  const [opened, setOpened] = useState(false);
  const [firstAt, setFirstAt] = useState<number | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [example, setExample] = useState("Tesla");
  const [keys, setKeys] = useState({ glance: keyLabel("G"), voice: keyLabel("V") });

  useEffect(() => {
    // Read only: what the console reported, whether Glance is set up, and the first answer.
    void setupComplete.getValue().then((done) => {
      setComplete(done);
      setAutoplay(introStart({ installed: welcome, askedForIntro: params.has("intro"), setupComplete: done }) === "play");
      setView("intro");
    });
    void setupProgress.getValue().then((p) => setProgress(p));
    void firstAnswerAt.getValue().then(setFirstAt);
    void Promise.all([hotkeyLetter.getValue(), voiceKeyLetter.getValue()]).then(([g, v]) => setKeys({ glance: keyLabel(g), voice: keyLabel(v) }));
    const unwatch = [setupComplete.watch((v) => setComplete(Boolean(v))), setupProgress.watch((p) => setProgress(p)), firstAnswerAt.watch((v) => setFirstAt(v ?? null))];
    void api.catalog().then((r) => {
      if (!r.ok) return;
      setSymbols(r.data.stocks.map((s) => s.symbol));
      const first = r.data.stocks[0];
      if (first) setExample(first.name);
    });
    return () => unwatch.forEach((u) => u());
  }, []);

  const stage = welcomeStage({ setupComplete: complete, wallet: Boolean(progress?.wallet) });
  const onDone = () => void consoleUrl.getValue().then((base) => browser.tabs.create({ url: `${base.replace(/\/+$/, "")}/dashboard` }));

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
      <header className="g-head">
        <Orb state="idle" size={28} markUrl="/glance-mark.png" />
        <span className="g-ui">{WELCOME.title}</span>
      </header>
      {view === "intro" && <Intro autoplay={autoplay} player={player} onSetUp={() => setView("setup")} />}
      {view === "setup" && (
      <main style={{ width: "100%", maxWidth: 420, margin: "0 auto", padding: "40px 24px 64px", boxSizing: "border-box" }}>
        {stage === "signin" && (
          <SignIn
            welcome={welcome}
            opened={opened}
            onOpen={() => {
              setOpened(true);
              openStart();
            }}
          />
        )}
        {stage === "account" && <Setup symbols={symbols} vaultFound={Boolean(progress?.vault)} />}
        {stage === "tryit" && <TryIt glanceKey={keys.glance} voiceKey={keys.voice} example={example} celebrated={celebrate(firstAt, openedAt)} onDone={onDone} />}
      </main>
      )}
    </div>
  );
}

mountPageStyles();
createRoot(document.getElementById("root")!).render(<Welcome />);
