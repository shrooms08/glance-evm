"use client";
import { useState } from "react";

import { MarketChip } from "@/components/MarketChip";
import { PriceChart } from "@/components/PriceChart";
import { Notice } from "@/components/Notice";
import { ProblemNotice } from "@/components/ProblemNotice";
import { Skeleton } from "@/components/Skeleton";
import type { CatalogStock, FeedStatus, LiveQuote } from "@/lib/api";
import { addressUrl, txUrl } from "@/lib/chain";
import { formatAgeHours, formatAgo, formatUsd, formatWhen, shortAddress } from "@/lib/format";
import { priceSourceLabel } from "@/lib/priceSource";
import { useNow } from "@/lib/useNow";
import { useCatalog, useHealth, useLiveQuotes } from "@/lib/vault";

export default function PricesPage() {
  const health = useHealth();
  const catalog = useCatalog();
  const live = useLiveQuotes();
  const now = useNow(30_000);
  const error = health.error ?? catalog.error;
  const feeds = health.data?.feeds ?? [];
  const stocks = catalog.data?.stocks ?? [];
  const lastWrite = health.data?.keeper.lastWriteAt ?? null;
  const allStandIns = stocks.length > 0 && stocks.every((s) => !s.feedReal);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Prices</p>
          <h1 className="title">Live prices, and the ones the vault trades on</h1>
          <p className="meta">
            The big number is the live market price (for reading). Underneath is the price the vault actually trades at: each stock's price feed on Robinhood Chain testnet. The
            vault refuses any trade whose price is too old, and Glance won't send one while the two are more than 2% apart.
          </p>
        </div>
        {health.data && (
          <div className="keeper">
            <span className="meta">The keeper last wrote</span>
            <span className="figure-sm">{lastWrite ? formatAgo(now - lastWrite) : "not in the last 57 hours"}</span>
            {lastWrite && <span className="meta mono">{formatWhen(lastWrite)}</span>}
          </div>
        )}
      </div>

      {(allStandIns || stocks.some((s) => !s.feedReal)) && (
        <Notice tone="info" title="Stand-in feeds, stated plainly">
          Robinhood Chain testnet has no Chainlink stock feeds, so these are Glance's own stand-in feeds. Each one marked <em>Chainlink, mirrored from mainnet</em> copies the live
          Chainlink feed for that stock on Robinhood Chain <strong>mainnet</strong>, both its price and its own timestamp, never “now”. So a stand-in is
          fresh exactly when the real feed is, and goes quiet at nights and weekends just like it. A keeper copies them on a schedule; its last write is shown above. The stock
          tokens themselves are the real Robinhood testnet tokens. NFLX has no Chainlink feed on Robinhood Chain at all, so its
          stand-in follows a public quote instead, and says so.
        </Notice>
      )}

      {error ? <ProblemNotice error={error} what="prices" /> : null}
      {(health.isLoading || catalog.isLoading) && !health.data && (
        <div className="card">
          <Skeleton lines={5} />
        </div>
      )}
      {health.data && catalog.data && (
        <div className="price-grid">
          {stocks.map((s) => (
            <PriceCard key={s.symbol} stock={s} feed={feeds.find((f) => f.symbol === s.symbol)} live={live.data?.quotes.find((q) => q.symbol === s.symbol)?.live ?? null} now={now} />
          ))}
        </div>
      )}
      {health.data?.keeper.pausedLocally && (
        <Notice tone="guard" title="The keeper is paused on the API's machine">
          Someone paused it on purpose (usually to show the market-closed caps at a weekend). Prices stay as they are until it resumes.
        </Notice>
      )}
    </div>
  );
}

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
