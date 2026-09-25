"use client";
import { useState } from "react";

import { MarketChip } from "@/components/MarketChip";
import { PriceChart } from "@/components/PriceChart";
import type { CatalogStock, FeedStatus, LiveQuote } from "@/lib/api";
import { addressUrl, txUrl } from "@/lib/chain";
import { formatAgeHours, formatAgo, formatUsd, shortAddress } from "@/lib/format";
import { priceSourceLabel } from "@/lib/priceSource";
import { useNow } from "@/lib/useNow";

/**
 * One stock on the Prices page: the live market price big (a live dot, its age), and underneath the price the vault
 * actually trades at (its feed, source and age), with the feed's links and chart.
 */
export function PriceCard({ stock, feed, live, now }: { stock: CatalogStock; feed?: FeedStatus; live: LiveQuote | null; now: number }) {
  const price = feed?.price ? formatUsd(BigInt(feed.price.raw), feed.price.decimals) : "–";
  const tick = useNow(1_000);
  const age = feed?.updatedAt ? now - feed.updatedAt : feed?.ageSeconds ?? null;
  const source = priceSourceLabel({ symbol: stock.symbol, feedReal: stock.feedReal, kind: feed?.source ?? stock.priceSourceKind });
  const mirrored = !stock.feedReal && source.tone === "neutral";
  const [open, setOpen] = useState(false);
  return (
    <article className={`card price${open ? " price-open" : ""}`}>
      <div className="between">
        <div>
          <p className="ticker">{stock.symbol}</p>
          <p className="meta">{stock.name}</p>
        </div>
        <MarketChip state={feed?.marketState ?? null} />
      </div>
      {live ? (
        <>
          <p className="display-sm figure" data-testid="live-price">
            {formatUsd(BigInt(Math.round(Number(live.price) * 100)), 2)}
          </p>
          <p className="meta live-line">
            <span className="live-dot" aria-hidden="true" /> live · {Math.max(0, tick - live.quotedAt)}s old · {live.source === "finnhub" ? "Finnhub" : "Yahoo Finance"}
          </p>
          <p className="meta" data-testid="vault-price">
            Vault trades at <span className="mono">{price}</span> · {source.label} · {age !== null ? formatAgeHours(age) : "–"}
          </p>
        </>
      ) : (
        <>
          <p className="display-sm figure">{price}</p>
          <p className="meta">The vault's price (no live quote right now).</p>
        </>
      )}
      <dl className="kv kv-stack">
        <div>
          <dt>Age</dt>
          <dd className="mono">{age !== null ? formatAgeHours(age) : "–"}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            <span className={`chip source-chip ${source.tone === "accent" ? "chip-accent" : source.tone === "guard" ? "chip-guard" : ""}`}>{source.label}</span>
          </dd>
        </div>
      </dl>
      <p className="meta">
        {stock.feedReal
          ? "A live Chainlink feed on Robinhood Chain testnet."
          : mirrored
            ? (
                <>
                  Copies the mainnet Chainlink feed{" "}
                  {stock.mainnetFeed ? <span className="mono">{shortAddress(stock.mainnetFeed)}</span> : null}, price and timestamp.
                </>
              )
            : `No live Chainlink feed to copy: priced from ${feed?.sourceDetail ?? stock.priceSource}.`}
      </p>
      <div className="row wrap meta">
        <a className="mono" href={addressUrl(stock.feed)} target="_blank" rel="noreferrer">
          Feed {shortAddress(stock.feed)} ↗
        </a>
        {feed?.lastWrite?.txHash && (
          <a className="mono" href={txUrl(feed.lastWrite.txHash)} target="_blank" rel="noreferrer">
            Last write {formatAgo(feed.lastWrite.agoSeconds)} ↗
          </a>
        )}
      </div>
      <button className="btn btn-ghost chart-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide chart" : "Show chart"}
      </button>
      {open && <PriceChart symbol={stock.symbol} />}
    </article>
  );
}
