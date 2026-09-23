/**
 * The assistant panel. "compact" floats beside the orb on the page; "tall" fills the docked side panel. Same content:
 * the orb's state and reply, the active card, companies found on the page, the weekend badge, a command box, and the
 * floating / docked switch.
 */
import { useEffect, useRef, useState } from "react";

import { keyLabel } from "../lib/hotkeys";
import { isAddress } from "../lib/settings";
import { CompanyCard, WeekendBadge } from "./CompanyCard";
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
}

export function Panel({ layout, assistant, host, companies, onRevealCompany, onSwitchMode, onClose, autoFocusInput }: Props) {
  const g = useGlance();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { closed, freshestAgeSeconds } = marketClosed(g.health);
  const glanceLabel = keyLabel(g.glanceKey);
  const voiceLabel = keyLabel(g.voiceKey);

  useEffect(() => {
    if (autoFocusInput) input.current?.focus();
  }, [autoFocusInput]);

  const idleLine = `Hold ${voiceLabel} to talk, or type below`;
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

      <div className="g-scroll" style={{ flex: 1 }}>
        <div className="g-section" style={{ gap: 6, minHeight: 64 }}>
          <span className="g-body" aria-live="polite">
            {line}
          </span>
          {assistant.listening && assistant.heard ? <span className="g-transcript">“{assistant.heard}”</span> : meta ? <span className="g-data">{meta}</span> : null}
        </div>

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
        ) : !isAddress(g.vaultAddress) ? (
          <div className="g-notice" role="status" style={{ borderTop: "1px solid var(--g-line)" }}>
            <span className="g-ui">No vault yet</span>
            <span className="g-meta">You can look up prices now. To trade, add your vault address in settings.</span>
            <button className="g-btn" onClick={g.openSettings}>
              Add your vault
            </button>
          </div>
        ) : null}

        {assistant.card?.kind === "company" && (
          <div style={{ padding: "0 var(--g-s7) var(--g-s7)" }}>
            <CompanyCard key={assistant.card.key} symbol={assistant.card.symbol} autoAmount={assistant.card.autoAmount} decision={assistant.decision} onClose={() => assistant.setCard(null)} />
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

      <div className="g-between" style={{ padding: "0 var(--g-s7) var(--g-s5)" }}>
        <button className="g-btn g-btn-ghost" onClick={onSwitchMode}>
          {layout === "tall" ? "Float on the page instead" : "Dock to the side panel"}
        </button>
        <button className="g-btn g-btn-ghost" onClick={g.openSettings}>
          Settings
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
