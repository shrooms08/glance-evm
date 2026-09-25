/**
 * The assistant panel. "compact" floats beside the orb on the page; "tall" fills the docked side panel. Same content:
 * the orb's state and reply, the active card, companies found on the page, the weekend badge, a command box, and the
 * floating / docked switch.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { keyLabel } from "../lib/hotkeys";
import { isAddress } from "../lib/settings";
import { checklistRows, dismissChecklist } from "../lib/onboarding";
import { Checklist, EmptyPage } from "./Onboarding";
import { useChecklist } from "./useChecklist";
import type { PageContext } from "../lib/journal";
import { LostBanner, RelinkNotice, SetupCard } from "./Setup";
import { setupRows } from "../lib/readiness";
import { CompanyCard, WeekendBadge } from "./CompanyCard";
import { PortfolioCard } from "./Portfolio";
import { BasketsCard } from "./Baskets";
import { CompareCard } from "./CompareCard";
import { WhyCard } from "./Why";
import { LINES } from "@glance/core/persona";
import { marketClosed, useGlance } from "./context";
import { Orb, ORB_LABELS } from "./Orb";
import type { useAssistant } from "./useAssistant";
import { useOrbMotion } from "./useOrbMotion";

export interface PageCompany {
  symbol: string;
  name: string;
  mentions: number;
}

interface Props {
  layout: "compact" | "tall";
  assistant: ReturnType<typeof useAssistant>;
  host: string;
  companies: PageCompany[];
  onRevealCompany?(symbol: string): void;
  onSwitchMode(): void;
  onClose?(): void;
  /** Focus the command box on open (keyboard users). */
  autoFocusInput?: boolean;
  /** The page a buy from this panel is placed from, for the headline journal (null: none). */
  pageContext?(symbol: string): Promise<PageContext | null> | PageContext | null;
  /**
   * The full price chart (the chart library is loaded on first use: lib/chartLoader.ts). In the tall side panel it also
   * sits above a company's card.
   */
  renderChart?(symbol: string, onClose?: () => void, range?: import("@glance/core/chart").ChartRange): ReactNode;
}

export function Panel({ layout, assistant, host, companies, onRevealCompany, onSwitchMode, onClose, autoFocusInput, pageContext, renderChart }: Props) {
  const g = useGlance();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { closed, freshestAgeSeconds } = marketClosed(g.health);
  // ⌥G: the browser command's key when it has one (the browser's keyboard shortcuts for extensions), else the in-page
  // key. ⌥V: always the in-page key, held to speak and released to send.
  const glanceLabel = g.shortcuts?.glance || keyLabel(g.glanceKey);
  const voiceLabel = keyLabel(g.voiceKey);

  useEffect(() => {
    if (autoFocusInput) input.current?.focus();
  }, [autoFocusInput]);

  const checklistState = useChecklist();
  const idleLine = LINES.idle(voiceLabel);
  const cardSymbol = assistant.card?.kind === "company" ? assistant.card.symbol : null;
  const line = g.orb.state === "idle" && !g.orb.line ? idleLine : g.orb.line || idleLine;
  const meta = g.orb.meta || (host ? `Reading ${host} · ${companies.length} ${companies.length === 1 ? "name" : "names"} found` : "");

  return (
    <div
      className="g-card"
      style={{ display: "flex", flexDirection: "column", height: layout === "tall" ? "100%" : undefined, maxHeight: "inherit", borderRadius: layout === "tall" ? 0 : undefined, border: layout === "tall" ? 0 : undefined }}
      role="dialog"
      aria-label="Glance assistant"
      // The last voice command's latency from key release (transcript, intent, speaking), for checks and demos.
      data-voice-latency={assistant.timing ? JSON.stringify(assistant.timing) : undefined}
    >
      <div className="g-head">
        {layout === "tall" && <PanelOrb />}
        <div className="g-head-title">
          <span className="g-ui">Glance</span>
          <span className="g-state" data-state={g.orb.state} aria-live="polite">
            {ORB_LABELS[g.orb.state]}
          </span>
        </div>
        <span className="g-kbd" title={`Tap ${glanceLabel} to glance at the page`}>{glanceLabel}</span>
        <span className="g-kbd" title={`Hold ${voiceLabel} to talk`}>{voiceLabel}</span>
        {onClose && (
          <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close Glance" onClick={onClose}>
            ×
          </button>
        )}
      </div>

      {g.gated !== false ? (
        // Not set up yet: the setup card, and nothing else (no prices, charts, voice, Show me or trades).
        <div className="g-scroll" style={{ flex: 1 }}>
          {g.gated === null ? (
            <div className="g-section" aria-busy="true" style={{ gap: 8 }}>
              <span className="g-skeleton" style={{ width: "70%" }} />
              <span className="g-skeleton" style={{ width: "50%" }} />
            </div>
          ) : (
            <SetupCard rows={setupRows(g.readiness, g.setupProgress)} onSetUp={g.openSetup} />
          )}
        </div>
      ) : (
      <>
      <div className="g-scroll" style={{ flex: 1 }}>
        <div className="g-section" style={{ gap: 6, minHeight: 64 }}>
          <span className="g-body" aria-live="polite">
            {line}
          </span>
          {assistant.listening && assistant.heard ? <span className="g-transcript">“{assistant.heard}”</span> : meta ? <span className="g-data">{meta}</span> : null}
        </div>

        {assistant.micHint && <MicHint hint={assistant.micHint} onDismiss={assistant.clearMicHint} />}

        {g.chainTrouble && !g.offline ? (
          <div className="g-notice" role="status" style={{ borderTop: "1px solid var(--g-line)" }}>
            <span className="g-ui">The Robinhood Chain testnet isn't responding right now. Trying again…</span>
            <span className="g-meta">This is the network, not your vault. Glance keeps checking and picks up where it left off.</span>
          </div>
        ) : null}
        {g.offline ? (
          <div className="g-notice" role="status" style={{ borderTop: "1px solid var(--g-line)" }}>
            <span className="g-ui">Glance can't reach its API</span>
            <span className="g-meta">{g.offlineMessage} Start it with `pnpm --filter api dev`, or change the address in settings.</span>
            <button className="g-btn" onClick={g.openSettings}>
              Open settings
            </button>
          </div>
        ) : g.lost ? (
          <LostBanner lost={g.lost} onAction={g.lost === "relink" ? g.openRelink : g.lost === "add-usdg" ? g.openAddUsdg : g.openSetup} />
        ) : (
          <RelinkNotice hint={g.relink} onRelink={g.openRelink} />
        )}

        {checklistState && !checklistState.dismissed && <Checklist rows={checklistRows(checklistState)} onDismiss={() => void dismissChecklist()} />}

        {host && companies.length === 0 && !assistant.card && <EmptyPage />}

        {assistant.card?.kind === "company" && renderChart && layout === "tall" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s5)" }}>{renderChart(assistant.card.symbol)}</div>
        )}

        {assistant.card?.kind === "chart" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s7)" }}>
            {renderChart?.(assistant.card.symbol, () => assistant.setCard(null), assistant.card.range)}
          </div>
        )}

        {assistant.card?.kind === "company" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s7)" }}>
            <CompanyCard
              key={assistant.card.key}
              symbol={assistant.card.symbol}
              autoAmount={assistant.card.autoAmount}
              decision={assistant.decision}
              onClose={() => assistant.setCard(null)}
              pageContext={pageContext ? () => pageContext(cardSymbol!) : undefined}
            />
          </div>
        )}

        {assistant.card?.kind === "portfolio" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s7)" }}>
            <PortfolioCard key={assistant.card.key} initialTab={assistant.card.tab} onClose={() => assistant.setCard(null)} />
          </div>
        )}

        {assistant.card?.kind === "choice" && (
          <div className="g-section" role="group" aria-label={assistant.card.question} style={{ gap: 8 }}>
            <span className="g-body">{assistant.card.question}</span>
            <div className="g-row" style={{ flexWrap: "wrap" }}>
              {assistant.card.options.map((o, i) => (
                <button key={o.label} className={`g-btn ${i === 0 ? "g-btn-primary" : "g-btn-ghost"}`} onClick={() => (assistant.setCard(null), o.run())}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {assistant.card?.kind === "compare" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s7)" }}>
            <CompareCard key={assistant.card.key} symbols={assistant.card.symbols} range={assistant.card.range} data={assistant.card.data} onClose={() => assistant.setCard(null)} />
          </div>
        )}

        {assistant.card?.kind === "baskets" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s7)" }}>
            <BasketsCard
              key={assistant.card.key}
              initialBuy={assistant.card.buy}
              notice={assistant.card.notice}
              onClose={() => assistant.setCard(null)}
              pageContext={pageContext ? () => pageContext(companies[0]?.symbol ?? "") : undefined}
            />
          </div>
        )}

        {assistant.card?.kind === "why" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s7)" }}>
            <WhyCard
              key={assistant.card.key}
              symbol={assistant.card.symbol}
              name={g.catalog.find((s) => s.symbol === (assistant.card as { symbol: string }).symbol)?.name}
              onClose={() => assistant.setCard(null)}
            />
          </div>
        )}

        {assistant.card?.kind === "spent" && !g.vault && (
          <div className="g-section" aria-busy="true" style={{ gap: 8 }}>
            <span className="g-skeleton" style={{ width: "60%" }} />
            <span className="g-skeleton" style={{ width: "45%" }} />
            <span className="g-skeleton" style={{ width: "50%" }} />
          </div>
        )}
        {assistant.card?.kind === "spent" && g.vault && (
          <div className="g-section">
            <dl className="g-facts">
              <dt>Spent in 24h</dt>
              <dd>{g.vault.buyWindow.used.formatted}</dd>
              <dt>Left today</dt>
              <dd>{g.vault.buyWindow.remaining.formatted}</dd>
              <dt>Per trade</dt>
              <dd>{g.vault.limits.perTrade.formatted}</dd>
              <dt>In the vault</dt>
              <dd>{g.vault.balances.usdg.formatted}</dd>
            </dl>
          </div>
        )}

        {companies.length > 0 && (
          <div className="g-names" aria-label="Companies on this page">
            <span className="g-meta" style={{ padding: "var(--g-s5) var(--g-s7) 6px" }}>
              On this page
            </span>
            {companies.map((c) => (
              <button
                key={c.symbol}
                className="g-name"
                onClick={() => {
                  assistant.setCard({ kind: "company", symbol: c.symbol, key: Date.now() });
                  onRevealCompany?.(c.symbol);
                }}
              >
                <span className="g-ui">{c.name}</span>
                <span className="g-data">
                  {c.symbol} · {c.mentions}×
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {closed && (
        <div style={{ padding: "var(--g-s5) var(--g-s7) 0" }}>
          <WeekendBadge ageSeconds={freshestAgeSeconds} cap={g.vault?.limits.weekendCap ?? "25%"} />
        </div>
      )}

      <form
        className="g-section g-row"
        style={{ borderTop: "1px solid var(--g-line)" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void assistant.run(text.trim());
          setText("");
        }}
      >
        <input ref={input} className="g-input g-grow" placeholder="Try “buy $10 of Tesla”" aria-label="Ask Glance" value={text} onChange={(e) => setText(e.target.value)} />
        {/* Always offered: if voice can't work here, pressing it says exactly why, and typing still works. */}
        <button
          type="button"
          className="g-btn g-icon-btn"
          aria-label={assistant.listening ? "Stop listening" : "Talk"}
          aria-pressed={assistant.listening}
          onClick={() => (assistant.listening ? assistant.stopListening() : assistant.startListening())}
        >
          <MicIcon />
        </button>
      </form>

      <div className="g-between" style={{ padding: "0 var(--g-s7) var(--g-s5)", flexWrap: "wrap", rowGap: 0 }}>
        <button className="g-btn g-btn-ghost" onClick={onSwitchMode}>
          {layout === "tall" ? "Float on the page instead" : "Dock to the side panel"}
        </button>
        <button className="g-btn g-btn-ghost" onClick={() => assistant.setCard({ kind: "portfolio", key: Date.now() })}>
          Portfolio
        </button>
        <button className="g-btn g-btn-ghost" onClick={() => assistant.setCard({ kind: "baskets", key: Date.now() })}>
          Baskets
        </button>
        <button className="g-btn g-btn-ghost" onClick={g.openSettings}>
          Settings
        </button>
      </div>
      </>
      )}
    </div>
  );
}

/** The browser's microphone grant ran out: one plain line, the address to copy, never another prompt. */
function MicHint({ hint, onDismiss }: { hint: { line: string; url: string }; onDismiss(): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="g-notice" role="status" style={{ borderTop: "1px solid var(--g-line)" }}>
      <span className="g-body">{hint.line}</span>
      <div className="g-row" style={{ flexWrap: "wrap" }}>
        <button
          className="g-btn"
          onClick={() =>
            void navigator.clipboard.writeText(hint.url).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy the address"}
        </button>
        <span className="g-data">{hint.url}</span>
        <button className="g-btn g-btn-ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/** The docked panel's orb: it breathes when idle and shakes once when a trade is refused, like the floating one. */
function PanelOrb() {
  const g = useGlance();
  const ref = useRef<HTMLSpanElement>(null);
  const motion = useOrbMotion(ref, g.orb.state, { still: g.still });
  return (
    <span ref={ref} className="g-orb-motion" data-breathe={motion.breathe || undefined}>
      <Orb state={g.orb.state} size={32} markUrl={g.markUrl} />
    </span>
  );
}
