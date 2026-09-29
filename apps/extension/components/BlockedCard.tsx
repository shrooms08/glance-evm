/**
 * The blocked card: shown when the vault's guards refuse a trade, before or after sending.
 *
 * It must read as protection, not failure. The vault did its job, on the user's behalf:
 *   - amber (the Guard colour, used nowhere else) with a shield, never red, never "error";
 *   - the API's exact human sentence, so the card, the orb and the voice all say the same thing;
 *   - the facts behind the decision in mono (what was asked, what the limit is, when it frees up);
 *   - one constructive next step chosen from the guard's machine code: retry at the cap, wait for the window,
 *     get a fresh quote, or fix it in the console. Where nothing can be done yet, it says so and offers no fake button.
 */
import { useEffect, useRef } from "react";

import type { Guard } from "../lib/api-types";
import { viewForGuard, type GuardAction } from "../lib/guard";
import { useGlance } from "./context";
import { Orb, Shield } from "./Orb";

interface Props {
  guard: Guard;
  symbol?: string;
  /** A sell's refusal offers sells ("Sell $25 worth instead", "Sell all instead"). */
  side?: "buy" | "sell";
  onRetry(amount: string): void;
  onRequote(): void;
  onDismiss(): void;
}

export function BlockedCard({ guard, symbol, side = "buy", onRetry, onRequote, onDismiss }: Props) {
  const g = useGlance();
  const view = viewForGuard(guard, g.usdgDecimals, Date.now(), side);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the explanation so keyboard and screen-reader users hear why.
  useEffect(() => headingRef.current?.focus(), [guard]);

  const act = (a: GuardAction) => {
    if (a.kind === "retry") onRetry(a.amount);
    else if (a.kind === "requote") onRequote();
    else if (a.kind === "console") g.openConsole();
    else if (a.kind === "settings") g.openSettings();
  };

  return (
    <div className="g-card g-guard" role="alertdialog" aria-labelledby="g-guard-title" aria-describedby="g-guard-msg">
      <div className="g-guard-head">
        <Orb state="blocked" size={40} markUrl={g.markUrl} />
        <div className="g-grow" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="g-guard-eyebrow">Your vault held this back{symbol ? ` · ${symbol}` : ""}</span>
          <h3 id="g-guard-title" className="g-heading" tabIndex={-1} ref={headingRef} style={{ outline: "none" }}>
            {view.title}
          </h3>
        </div>
      </div>
      <div className="g-section">
        <p id="g-guard-msg" className="g-body">
          {view.message}
        </p>
        {view.facts.length > 0 && (
          <dl className="g-facts">
            {view.facts.map((f) => (
              <FragmentRow key={f.label} label={f.label} value={f.value} />
            ))}
          </dl>
        )}
        <span className="g-guard-meta">
          <Shield className="g-shield" />
          {view.meta} · no funds moved
        </span>
      </div>
      <div className="g-section" style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {view.primary && (
          <button className="g-btn g-btn-primary" onClick={() => act(view.primary!)}>
            {view.primary.label}
          </button>
        )}
        {view.secondary && view.secondary.kind === "wait" && (
          <span className="g-btn g-btn-ghost" aria-live="polite" style={{ cursor: "default" }}>
            {view.secondary.label}
          </span>
        )}
        <button className="g-btn g-btn-ghost" onClick={onDismiss}>
          {view.primary ? "Not now" : "OK"}
        </button>
      </div>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
