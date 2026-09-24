/**
 * A company's card: name, ticker, live oracle price, its age, the market state, and the buy flow
 * (presets $10 / $25 / $100 or a custom amount -> on-chain preflight -> review -> confirm -> receipt or blocked).
 * Used as the in-page hover card and inside the floating and docked panels.
 */
import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import { onChainRecovered } from "../lib/chainStatus";
import type { Price } from "../lib/api-types";
import { ageHours, priceUsd, shortHash } from "../lib/format";
import { BlockedCard } from "./BlockedCard";
import { useGlance } from "./context";
import { Orb } from "./Orb";
import { useTradeFlow, type PageContextSource } from "./useTradeFlow";
import { WhyLine } from "./Why";

const PRESETS = ["10", "25", "100"];

interface Props {
  symbol: string;
  /** Start a quote for this amount straight away (voice: "buy ten dollars of Tesla"). */
  autoAmount?: string;
  onClose?(): void;
  /** Where the card lives, for spacing only. */
  variant?: "hover" | "panel";
  /** A spoken "yes" / "cancel" from the assistant, applied to a pending review. */
  decision?: { n: number; confirm: boolean };
  /** Where this card is on a page, for the headline journal. */
  pageContext?: PageContextSource;
}

export function CompanyCard({ symbol, autoAmount, onClose, variant = "panel", decision, pageContext }: Props) {
  const g = useGlance();
  const stock = g.catalog.find((s) => s.symbol === symbol);
  const [price, setPrice] = useState<Price | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  // A card opened by voice ("buy ten dollars of Tesla") answers aloud; one opened by hover or click stays quiet.
  const { flow, start, confirm, reset } = useTradeFlow(symbol, { voice: Boolean(autoAmount), pageContext });

  const loadPrice = useCallback(async () => {
    setPriceError(null);
    const res = await api.price(symbol, g.vaultAddress || undefined);
    if (res.ok) setPrice(res.data);
    else setPriceError(res.message);
  }, [symbol, g.vaultAddress]);

  useEffect(() => {
    void loadPrice();
  }, [loadPrice]);
  // The price couldn't load because the testnet wasn't answering: load it again once it does.
  useEffect(() => (priceError && g.chainTrouble ? onChainRecovered(() => void loadPrice()) : undefined), [priceError, g.chainTrouble, loadPrice]);

  useEffect(() => {
    if (autoAmount) void start(autoAmount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAmount]);

  useEffect(() => {
    if (!decision?.n || flow.step !== "review") return;
    if (decision.confirm) void confirm();
    else reset();
    // Only react to a new decision, not to flow changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.n]);

  // The confirm moment should feel still and certain: no idle motion anywhere while it is on screen.
  const confirming = flow.step === "review" || flow.step === "trading";
  const { holdStill } = g;
  useEffect(() => (confirming ? holdStill() : undefined), [confirming, holdStill]);

  const weekendCap = g.vault?.limits.weekendCap ?? "25%";

  if (flow.step === "blocked") {
    return (
      <BlockedCard
        guard={flow.guard}
        symbol={symbol}
        onRetry={(amount) => void start(amount)}
        onRequote={() => void start(flow.amount)}
        onDismiss={() => {
          reset();
          onClose?.();
        }}
      />
    );
  }

  return (
    <div className="g-card" role="dialog" aria-label={`${stock?.name ?? symbol} (${symbol})`}>
      <div className="g-section" style={{ gap: 6 }}>
        <div className="g-between">
          <div className="g-row" style={{ gap: 8, minWidth: 0 }}>
            <span className="g-heading" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {stock?.legalName ?? symbol}
            </span>
            <span className="g-ticker">{symbol}</span>
          </div>
          {onClose && (
            <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {price ? (
          <>
            <span className="g-figure">{priceUsd(price.price.value)}</span>
            <span className="g-live g-data">
              <span className="g-dot" data-state={price.marketState} />
              {ageHours(price.ageSeconds)} old ·{" "}
              {price.marketState === "OPEN"
                ? "market open"
                : price.marketState === "CLOSED"
                  ? `market closed · limits at ${weekendCap}`
                  : "price too old to trade on"}
            </span>
          </>
        ) : priceError ? (
          <span className="g-meta">{priceError}</span>
        ) : (
          <>
            <span className="g-skeleton" style={{ height: 22, width: 110 }} />
            <span className="g-skeleton" style={{ width: 160 }} />
          </>
        )}
      </div>

      {flow.step === "idle" || flow.step === "failed" ? (
        <div className="g-section">
          {flow.step === "failed" && <FailedNotice code={flow.code} message={flow.message} />}
          <div className="g-chips" role="group" aria-label="Amount to buy">
            {PRESETS.map((p) => (
              <button key={p} className="g-chip" onClick={() => void start(p)} disabled={!price || price.marketState === "STALE"}>
                ${p}
              </button>
            ))}
          </div>
          <form
            className="g-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^\d+(\.\d{1,2})?$/.test(custom) && Number(custom) > 0) void start(custom);
            }}
          >
            <label className="g-amount g-grow">
              <span>$</span>
              <input
                className="g-input"
                inputMode="decimal"
                placeholder="Other amount"
                aria-label="Custom amount in dollars"
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
              />
            </label>
            <button className="g-btn g-btn-primary" type="submit" disabled={!price || !custom || price.marketState === "STALE"}>
              Buy
            </button>
          </form>
          {variant === "hover" && <span className="g-meta">Glance checks every limit on chain before anything is sent.</span>}
          <WhyLine symbol={symbol} />
        </div>
      ) : flow.step === "quoting" ? (
        <div className="g-section g-row" aria-live="polite">
          <Orb state="thinking" size={28} markUrl={g.markUrl} />
          <span className="g-meta">Checking ${flow.amount} against your vault's limits…</span>
        </div>
      ) : flow.step === "review" || flow.step === "trading" ? (
        <div className="g-section">
          <dl className="g-facts">
            <dt>You pay</dt>
            <dd>${flow.amount}</dd>
            <dt>You get about</dt>
            <dd>{flow.quote.deskQuote?.formatted ?? "?"}</dd>
            <dt>Oracle price</dt>
            <dd>
              {priceUsd(flow.quote.price.value)} · {ageHours(flow.quote.priceAgeSeconds)} old
            </dd>
            <dt>Desk spread</dt>
            <dd>{flow.quote.spread}</dd>
          </dl>
          <span className="g-live g-data">
            <span className="g-dot" /> Passed every vault guard in a dry run
          </span>
          <div className="g-row">
            <button className="g-btn g-btn-primary g-grow" onClick={() => void confirm()} disabled={flow.step === "trading"} autoFocus>
              {flow.step === "trading" ? "Buying…" : `Confirm $${flow.amount} of ${symbol}`}
            </button>
            <button className="g-btn g-btn-ghost" onClick={reset} disabled={flow.step === "trading"}>
              Cancel
            </button>
          </div>
        </div>
      ) : flow.step === "done" ? (
        <Receipt symbol={symbol} amount={flow.amount} txUrl={flow.trade.explorerUrl} txHash={flow.trade.txHash} got={flow.trade.filled?.tokensOut?.formatted} price={flow.quote.price.value} onAgain={reset} />
      ) : null}
    </div>
  );
}

function Receipt(props: { symbol: string; amount: string; txUrl: string; txHash: string; got?: string; price: string; onAgain(): void }) {
  const g = useGlance();
  return (
    <>
      <div className="g-success-head" aria-live="polite">
        <Orb state="success" size={40} markUrl={g.markUrl} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="g-ui">Bought {props.got ?? props.symbol}</span>
          <span className="g-data">
            for ${props.amount} at {priceUsd(props.price)}
          </span>
        </div>
      </div>
      <div className="g-section g-between">
        <a className="g-data" href={props.txUrl} target="_blank" rel="noopener noreferrer">
          tx {shortHash(props.txHash)} ↗
        </a>
        <button className="g-btn g-btn-ghost" onClick={props.onAgain}>
          Buy more
        </button>
      </div>
    </>
  );
}

export function FailedNotice({ code, message }: { code: string; message: string }) {
  const g = useGlance();
  return (
    <div className="g-notice" style={{ padding: 0 }} role="status">
      <span className="g-body">{message}</span>
      {code === "NO_VAULT" || code === "API_OFFLINE" || code === "TIMEOUT" ? (
        <button className="g-btn" onClick={g.openSettings}>
          {code === "NO_VAULT" ? "Add your vault" : "Check the API in settings"}
        </button>
      ) : null}
    </div>
  );
}

export function WeekendBadge({ ageSeconds, cap }: { ageSeconds: number; cap: string }) {
  return (
    <span className="g-badge" role="status">
      <span className="g-dot" />
      Market closed · {ageHours(ageSeconds)} old · limits at {cap}
    </span>
  );
}
