/**
 * Selling a stock back to USDG, by voice or typed in the panel: "sell $10 of Tesla", "sell all my Palantir", "sell half
 * my Tesla". The same safety path as a buy:
 *   idle -> quoting -> review (the API's on-chain preflight passed) -> trading -> done
 *                   -> blocked (a vault guard, the drift guard, or nothing held)
 *                   -> failed (API offline, no vault, ...) / needs-link (this browser isn't linked yet)
 * The API works out the shares (dollars at the vault's oracle price, or part of the holding) and quotes them; the
 * confirm tap sends exactly those shares, in a request this browser signs. Nothing is sold on a spoken yes.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { Guard, Quote, Trade } from "../lib/api-types";
import { onChainRecovered } from "../lib/chainStatus";
import { ageHours, priceUsd, shortHash } from "../lib/format";
import { LINK_CODES, startLinking, waitForLink } from "../lib/linking";
import { isAddress } from "../lib/settings";
import { speak } from "../lib/voiceClient";
import { BlockedCard } from "./BlockedCard";
import { FailedNotice, NeedsLink } from "./CompanyCard";
import { useGlance } from "./context";
import { Orb } from "./Orb";

/** What to sell: dollars' worth at the vault's price, or part of the holding ("1" all of it, "0.5" half). */
export type SellSpec = { usd: string } | { fraction: "1" | "0.5" };

const PRESETS: Array<{ label: string; spec: SellSpec }> = [
  { label: "$10", spec: { usd: "10" } },
  { label: "$25", spec: { usd: "25" } },
  { label: "Half", spec: { fraction: "0.5" } },
  { label: "All", spec: { fraction: "1" } },
];

/** "$10 of TSLA", "all your TSLA", "half your TSLA". */
export function describeSell(spec: SellSpec, symbol: string): string {
  if ("usd" in spec) return `$${spec.usd} of ${symbol}`;
  return `${spec.fraction === "1" ? "all" : "half"} your ${symbol}`;
}

/** The confirm line, said and shown: both prices, and what comes back. */
export function sellConfirmLine(quote: Quote): string {
  const vaultAt = priceUsd(quote.price.value);
  const back = quote.deskQuote ? ` You get about ${quote.deskQuote.formatted}.` : "";
  const at = quote.live ? `at ${priceUsd(quote.live.price)}; the vault trades at ${vaultAt}.` : `at ${vaultAt}.`;
  return `Sell ${quote.amountIn.formatted} ${at}${back} Confirm?`;
}

export type SellStep =
  | { step: "idle" }
  | { step: "quoting"; spec: SellSpec }
  | { step: "review"; spec: SellSpec; quote: Quote }
  | { step: "trading"; spec: SellSpec; quote: Quote }
  | { step: "done"; spec: SellSpec; quote: Quote; trade: Trade }
  | { step: "blocked"; spec: SellSpec; guard: Guard; quote?: Quote }
  | { step: "failed"; spec: SellSpec; code: string; message: string }
  | { step: "needs-link"; spec: SellSpec; quote: Quote; code: string; message: string; link: "idle" | "waiting" | "linked" | "failed"; until?: number };

export function useSellFlow(symbol: string, opts: { voice?: boolean } = {}) {
  const g = useGlance();
  const [flow, setFlow] = useState<SellStep>({ step: "idle" });
  const run = useRef(0);

  /** A refusal, said out loud when the sell was asked for by voice. */
  const refuse = useCallback(
    (spec: SellSpec, guard: Guard, quote?: Quote) => {
      setFlow({ step: "blocked", spec, guard, quote });
      g.setOrb({ state: "blocked", line: guard.message, meta: `Guard · ${guard.code}` });
      // By voice, "nothing held" was already said in the reply: the card shows it without saying it twice.
      if (opts.voice && guard.code !== "NOTHING_HELD") void speak(guard.message, g.voiceReplies);
    },
    [g, opts.voice],
  );

  const start = useCallback(
    async (spec: SellSpec) => {
      const id = ++run.current;
      if (!isAddress(g.vaultAddress)) {
        setFlow({ step: "failed", spec, code: "NO_VAULT", message: "Add your vault address in settings to trade." });
        return;
      }
      setFlow({ step: "quoting", spec });
      g.setOrb({ state: "thinking", line: `Checking your ${symbol} and your vault's limits`, meta: "Preflight on chain" });
      const res = await api.quote({ vault: g.vaultAddress, symbol, side: "sell", ...spec });
      if (id !== run.current) return;
      if (!res.ok) {
        // Nothing held is a refusal like the vault's own, with the same card.
        if (res.guard) return refuse(spec, res.guard);
        setFlow({ step: "failed", spec, code: res.code, message: res.message });
        g.setOrb({ state: "idle", line: res.message, meta: "" });
        return;
      }
      const quote = res.data;
      if (!quote.preflight.ok) return refuse(spec, quote.preflight.guard, quote);
      // The drift guard, before the confirm step: the API would refuse it anyway, so say so now.
      if (quote.drift?.blocked && quote.drift.guard) return refuse(spec, quote.drift.guard, quote);
      setFlow({ step: "review", spec, quote });
      const line = sellConfirmLine(quote);
      const meta = `Price ${(quote.priceAgeSeconds / 3600).toFixed(1)}h old · market ${quote.marketState === "OPEN" ? "open" : "closed"}`;
      g.setOrb({ state: "idle", line, meta });
      if (opts.voice) {
        await speak(line, g.voiceReplies, {
          onStart: () => id === run.current && g.setOrb({ state: "speaking", line, meta }),
          onEnd: () => id === run.current && g.setOrb({ state: "idle", line, meta }),
        });
      }
    },
    [g, symbol, opts.voice, refuse],
  );

  const linking = useRef<AbortController | null>(null);
  useEffect(() => () => linking.current?.abort(), []);

  const send = useCallback(
    async (spec: SellSpec, quote: Quote) => {
      const id = ++run.current;
      setFlow({ step: "trading", spec, quote });
      g.setOrb({ state: "thinking", line: `Selling ${quote.amountIn.formatted}`, meta: "Sending through your vault" });
      // Exactly the shares that were quoted and shown: the signed request names shares, never a dollar figure.
      const res = await api.trade({ vault: g.vaultAddress, symbol, side: "sell", amount: quote.amountIn.value });
      if (id !== run.current) return;
      if (res.ok) {
        setFlow({ step: "done", spec, quote, trade: res.data });
        const sold = res.data.filled?.tokensIn?.formatted ?? quote.amountIn.formatted;
        const got = res.data.filled?.usdgOut?.formatted ?? quote.deskQuote?.formatted ?? "";
        g.setOrb({ state: "success", line: `Sold ${sold}${got ? ` for ${got}` : ""}`, meta: `tx ${shortHash(res.data.txHash)}` });
        void g.refreshVault();
      } else if (res.guard) {
        refuse(spec, res.guard, quote);
      } else if (LINK_CODES.has(res.code)) {
        setFlow({ step: "needs-link", spec, quote, code: res.code, message: res.message, link: "idle" });
        g.setOrb({ state: "idle", line: res.message, meta: "" });
      } else {
        setFlow({ step: "failed", spec, code: res.code, message: res.message });
        g.setOrb({ state: "idle", line: res.message, meta: "" });
      }
    },
    [g, symbol, refuse],
  );

  const confirm = useCallback(async () => {
    if (flow.step === "review") await send(flow.spec, flow.quote);
  }, [flow, send]);

  /** Opens the console to link this browser, then waits for the owner's signature. */
  const link = useCallback(async () => {
    if (flow.step !== "needs-link" || flow.link === "waiting") return;
    const base = flow;
    linking.current?.abort();
    const abort = (linking.current = new AbortController());
    setFlow({ ...base, link: "waiting" });
    const started = await startLinking(g.vaultAddress);
    if (!started) return setFlow({ ...base, link: "failed" });
    const status = await waitForLink(g.vaultAddress, started.address, { signal: abort.signal });
    if (abort.signal.aborted) return;
    setFlow(status.linked ? { ...base, link: "linked", until: status.expiresAt } : { ...base, link: "failed" });
  }, [flow, g.vaultAddress]);

  /** After linking: the same sell, quoted again on chain before it's sent. */
  const retry = useCallback(async () => {
    if (flow.step === "needs-link") await start(flow.spec);
  }, [flow, start]);

  // A quote that failed only because the testnet wasn't answering tries again, on its own, once it answers.
  useEffect(() => {
    if (flow.step !== "failed" || flow.code !== "RPC_UNAVAILABLE") return;
    const spec = flow.spec;
    return onChainRecovered(() => void start(spec));
  }, [flow, start]);

  const reset = useCallback(() => {
    run.current++;
    linking.current?.abort();
    setFlow({ step: "idle" });
    g.setOrb({ state: "idle" });
  }, [g]);

  return { flow, start, confirm, reset, link, retry };
}

interface Props {
  symbol: string;
  /** Quote this straight away (voice: "sell all my Palantir"). */
  spec?: SellSpec;
  /** Opened by voice: the confirm line and any refusal are spoken. */
  voice?: boolean;
  onClose?(): void;
  /** A typed "yes" / "cancel" from the assistant, applied to a pending review. */
  decision?: { n: number; confirm: boolean };
}

export function SellCard({ symbol, spec, voice, onClose, decision }: Props) {
  const g = useGlance();
  const stock = g.catalog.find((s) => s.symbol === symbol);
  const [custom, setCustom] = useState("");
  const { flow, start, confirm, reset, link, retry } = useSellFlow(symbol, { voice });

  useEffect(() => {
    if (spec) void start(spec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!decision?.n || flow.step !== "review") return;
    if (decision.confirm) void confirm();
    else reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.n]);

  // The confirm moment should feel still and certain: no idle motion anywhere while it is on screen.
  const confirming = flow.step === "review" || flow.step === "trading";
  const { holdStill } = g;
  useEffect(() => (confirming ? holdStill() : undefined), [confirming, holdStill]);

  if (flow.step === "blocked") {
    return (
      <BlockedCard
        guard={flow.guard}
        symbol={symbol}
        side="sell"
        onRetry={(amount) => void start(amount === "all" ? { fraction: "1" } : { usd: amount })}
        onRequote={() => void start(flow.spec)}
        onDismiss={() => {
          reset();
          onClose?.();
        }}
      />
    );
  }

  const quote = "quote" in flow ? flow.quote : null;
  return (
    <div className="g-card" role="dialog" aria-label={`Sell ${stock?.name ?? symbol} (${symbol})`}>
      <div className="g-section" style={{ gap: 6 }}>
        <div className="g-between">
          <div className="g-row" style={{ gap: 8, minWidth: 0 }}>
            <span className="g-heading" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              Sell {stock?.name ?? symbol}
            </span>
            <span className="g-ticker">{symbol}</span>
          </div>
          {onClose && (
            <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {quote?.sell && (
          <span className="g-live g-data" data-testid="held">
            You hold {quote.sell.held.formatted} · about {quote.sell.heldValue.formatted}
          </span>
        )}
      </div>

      {flow.step === "idle" || flow.step === "failed" ? (
        <div className="g-section">
          {flow.step === "failed" && <FailedNotice code={flow.code} message={flow.message} onRetry={() => void start(flow.spec)} />}
          <div className="g-chips" role="group" aria-label="Amount to sell">
            {PRESETS.map((p) => (
              <button key={p.label} className="g-chip" onClick={() => void start(p.spec)}>
                {p.label}
              </button>
            ))}
          </div>
          <form
            className="g-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (/^\d+(\.\d{1,2})?$/.test(custom) && Number(custom) > 0) void start({ usd: custom });
            }}
          >
            <label className="g-amount g-grow">
              <span>$</span>
              <input
                className="g-input"
                inputMode="decimal"
                placeholder="Other amount"
                aria-label="Dollars of stock to sell"
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))}
              />
            </label>
            <button className="g-btn g-btn-primary" type="submit" disabled={!custom}>
              Sell
            </button>
          </form>
          <span className="g-meta">Glance checks every limit on chain before anything is sent. The USDG goes back to your vault.</span>
        </div>
      ) : flow.step === "quoting" ? (
        <div className="g-section g-row" aria-live="polite">
          <Orb state="thinking" size={28} markUrl={g.markUrl} />
          <span className="g-meta">Checking {describeSell(flow.spec, symbol)} against your vault's limits…</span>
        </div>
      ) : flow.step === "review" || flow.step === "trading" ? (
        <div className="g-section">
          <dl className="g-facts">
            <dt>You sell</dt>
            <dd>
              {flow.quote.amountIn.formatted}
              {flow.quote.sell ? ` · about ${flow.quote.sell.value.formatted}` : ""}
            </dd>
            <dt>You get about</dt>
            <dd>{flow.quote.deskQuote?.formatted ?? "?"}</dd>
            <dt>At least</dt>
            <dd>{flow.quote.minOut.formatted}</dd>
            {flow.quote.live && (
              <>
                <dt>Market price</dt>
                <dd>
                  {priceUsd(flow.quote.live.price)} · live, {flow.quote.live.ageSeconds}s ago
                </dd>
              </>
            )}
            <dt>Vault trades at</dt>
            <dd>
              {priceUsd(flow.quote.price.value)} · Chainlink · {ageHours(flow.quote.priceAgeSeconds)} old
            </dd>
            <dt>Desk spread</dt>
            <dd>{flow.quote.spread}</dd>
          </dl>
          <span className="g-live g-data">
            <span className="g-dot" /> Passed every vault guard in a dry run
          </span>
          <div className="g-row">
            <button className="g-btn g-btn-primary g-grow" onClick={() => void confirm()} disabled={flow.step === "trading"} autoFocus>
              {flow.step === "trading" ? "Selling…" : `Confirm sale of ${flow.quote.amountIn.formatted}`}
            </button>
            <button className="g-btn g-btn-ghost" onClick={reset} disabled={flow.step === "trading"}>
              Cancel
            </button>
          </div>
        </div>
      ) : flow.step === "needs-link" ? (
        <NeedsLink flow={flow} symbol={symbol} retryLabel={`Sell ${describeSell(flow.spec, symbol)}`} onLink={() => void link()} onRetry={() => void retry()} onCancel={reset} />
      ) : flow.step === "done" ? (
        <SoldReceipt quote={flow.quote} trade={flow.trade} onAgain={reset} />
      ) : null}
    </div>
  );
}

function SoldReceipt({ quote, trade, onAgain }: { quote: Quote; trade: Trade; onAgain(): void }) {
  const g = useGlance();
  const sold = trade.filled?.tokensIn?.formatted ?? quote.amountIn.formatted;
  const got = trade.filled?.usdgOut?.formatted ?? quote.deskQuote?.formatted;
  return (
    <>
      <div className="g-success-head" aria-live="polite">
        <Orb state="success" size={40} markUrl={g.markUrl} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="g-ui">
            Sold {sold}
            {got ? ` for ${got}` : ""}
          </span>
          <span className="g-data">
            at {priceUsd(quote.price.value)} (the vault's price){quote.live ? ` · market ${priceUsd(quote.live.price)}` : ""} · the USDG is back in your vault
          </span>
        </div>
      </div>
      <div className="g-section g-between">
        <a className="g-data" href={trade.explorerUrl} target="_blank" rel="noopener noreferrer">
          tx {shortHash(trade.txHash)} ↗
        </a>
        <button className="g-btn g-btn-ghost" onClick={onAgain}>
          Sell more
        </button>
      </div>
    </>
  );
}
