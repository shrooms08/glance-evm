/**
 * The Portfolio view (side panel and floating panel): USDG cash, each position with its value and PnL ($ and %; lime
 * when up, a muted red when down), the price's age, and the total. Each position says which headline its latest buy
 * came from, from the headline journal (kept only in this browser), and how the price has moved since.
 * The Journal tab lists every buy's headline, newest first.
 */
import { BOUGHT_OUTSIDE_PAGE, EMPTY_PORTFOLIO } from "@glance/core/tone";
import { useCallback, useEffect, useState } from "react";

import { cachedPortfolio, cacheAge, savePortfolio } from "../lib/portfolioCache";

import { api } from "../lib/api";
import type { Portfolio, PortfolioPosition } from "../lib/api-types";
import { ageHours, priceUsd, shortHash } from "../lib/format";
import { clearJournal, deleteEntry, listJournal, sinceThen, type JournalEntry } from "../lib/journal";
import { isAddress } from "../lib/settings";
import { useGlance } from "./context";

type Tab = "positions" | "journal";

const tone = (signed: string | null | undefined) => (!signed || signed === "0%" || signed === "$0" ? "" : signed.startsWith("-") ? "g-down" : "g-up");

export function PortfolioCard({ initialTab = "positions", onClose }: { initialTab?: Tab; onClose?(): void }) {
  const g = useGlance();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [otherPrices, setOtherPrices] = useState<Record<string, string>>({});

  // Shown at once from this browser's last copy (with its age), then refreshed in the background.
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const load = useCallback(async () => {
    setJournal(await listJournal().catch(() => []));
    if (!isAddress(g.vaultAddress)) return;
    setError(null);
    const cached = await cachedPortfolio(g.vaultAddress);
    if (cached) {
      setData((d) => d ?? cached.data);
      setStaleAt((t) => t ?? cached.at);
    }
    const res = await api.portfolio(g.vaultAddress);
    if (res.ok) {
      setData(res.data);
      setStaleAt(null);
      void savePortfolio(g.vaultAddress, res.data);
    } else setError(res.message);
  }, [g.vaultAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  // The journal's "now" prices for stocks no longer held (held ones come with the portfolio).
  useEffect(() => {
    if (tab !== "journal") return;
    const held = new Set((data?.positions ?? []).map((p) => p.symbol));
    const missing = [...new Set(journal.map((j) => j.symbol))].filter((s) => !held.has(s) && !(s in otherPrices));
    if (missing.length === 0) return;
    void Promise.all(missing.map(async (s) => [s, await api.price(s)] as const)).then((rows) => {
      const found: Record<string, string> = {};
      for (const [s, r] of rows) if (r.ok) found[s] = r.data.price.value;
      setOtherPrices((prev) => ({ ...prev, ...found }));
    });
  }, [tab, journal, data, otherPrices]);

  return (
    <div className="g-card" role="region" aria-label="Portfolio">
      <div className="g-section" style={{ gap: 10 }}>
        <div className="g-between">
          <div className="g-tabs" role="tablist" aria-label="Portfolio">
            <button role="tab" aria-selected={tab === "positions"} className="g-tab" onClick={() => setTab("positions")}>
              Portfolio
            </button>
            <button role="tab" aria-selected={tab === "journal"} className="g-tab" onClick={() => setTab("journal")}>
              Journal
            </button>
          </div>
          {onClose && (
            <button className="g-btn g-btn-ghost g-icon-btn" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {tab === "positions" ? (
          <Positions data={data} error={error} journal={journal} hasVault={isAddress(g.vaultAddress)} onRetry={() => void load()} staleAt={staleAt} />
        ) : (
          <Journal
            entries={journal}
            prices={{ ...otherPrices, ...Object.fromEntries((data?.positions ?? []).map((p) => [p.symbol, p.price.value])) }}
            onDelete={async (hash) => {
              await deleteEntry(hash);
              setJournal(await listJournal());
            }}
            onClear={async () => {
              await clearJournal();
              setJournal([]);
            }}
          />
        )}
      </div>
    </div>
  );
}

export function Positions({
  data,
  error,
  journal,
  hasVault,
  onRetry,
  staleAt = null,
  now = Date.now(),
}: {
  data: Portfolio | null;
  error: string | null;
  journal: JournalEntry[];
  hasVault: boolean;
  onRetry?(): void;
  /** Showing this browser's last copy, from then (null: fresh). */
  staleAt?: number | null;
  now?: number;
}) {
  if (!hasVault) return <span className="g-meta">Set up your own vault in the console to see your portfolio.</span>;
  if (error && !data) {
    return (
      <div className="g-row" style={{ flexWrap: "wrap" }}>
        <span className="g-meta">{error}</span>
        {onRetry && (
          <button className="g-link-btn" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="g-skeleton" style={{ height: 22, width: 120 }} />
        <span className="g-skeleton" style={{ width: "80%" }} />
      </div>
    );
  }
  const byHash = new Map(journal.map((j) => [j.txHash.toLowerCase(), j]));
  const t = data.totals;
  return (
    <div className="g-portfolio">
      {staleAt !== null && (
        <div className="g-row" style={{ flexWrap: "wrap" }} aria-live="polite">
          <span className="g-meta">
            {cacheAge(staleAt, now)} · {error ? "couldn't refresh" : "refreshing…"}
          </span>
          {error && onRetry && (
            <button className="g-link-btn" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
      <div className="g-between" style={{ alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className="g-meta">Total</span>
          <span className="g-figure">{t.value.formatted}</span>
        </div>
        {data.positions.length > 0 && (
          <span className={`g-data ${tone(t.unrealizedPnl.formatted)}`}>
            {t.unrealizedPnl.formatted}
            {t.unrealizedPnlPct ? ` · ${t.unrealizedPnlPct}` : ""}
          </span>
        )}
      </div>
      <div className="g-between g-pos-cash">
        <span className="g-ui">USDG cash</span>
        <span className="g-data">{data.usdg.formatted}</span>
      </div>
      {data.positions.length === 0 ? (
        <span className="g-meta">{EMPTY_PORTFOLIO}</span>
      ) : (
        <ul className="g-positions">
          {data.positions.map((p) => (
            <PositionRow key={p.symbol} p={p} entry={p.lastBuy ? (byHash.get(p.lastBuy.txHash.toLowerCase()) ?? null) : null} />
          ))}
        </ul>
      )}
      {t.realizedPnl.raw !== "0" && <span className="g-meta">Realized from sales: <span className={tone(t.realizedPnl.formatted)}>{t.realizedPnl.formatted}</span></span>}
    </div>
  );
}

function PositionRow({ p, entry }: { p: PortfolioPosition; entry: JournalEntry | null }) {
  const since = entry ? sinceThen(entry.priceAtBuy, p.price.value) : null;
  return (
    <li className="g-position">
      <div className="g-between">
        <span className="g-ui">
          <span className="g-ticker">{p.symbol}</span> {p.qty.formatted.replace(` ${p.symbol}`, "")}
        </span>
        <span className="g-data">{p.value.formatted}</span>
      </div>
      <div className="g-between">
        <span className="g-meta">
          {priceUsd(p.price.value)} · {ageHours(p.priceAge.seconds)} old
        </span>
        <span className={`g-data ${tone(p.unrealizedPnl.formatted)}`}>
          {p.unrealizedPnl.formatted}
          {p.unrealizedPnlPct ? ` · ${p.unrealizedPnlPct}` : ""}
        </span>
      </div>
      {p.transferredIn && <span className="g-meta">Includes {p.transferredIn.formatted} sent in, counted at no cost.</span>}
      {p.lastBuy &&
        (entry?.page ? (
          <span className="g-meta g-bought-from">
            Bought from:{" "}
            <a href={entry.page.url} target="_blank" rel="noopener noreferrer">
              {entry.page.title || entry.page.site}
            </a>{" "}
            · {entry.page.site}
            {since && (
              <>
                {" "}
                · Since then: <span className={tone(since)}>{since}</span>
              </>
            )}
          </span>
        ) : (
          <span className="g-meta">{BOUGHT_OUTSIDE_PAGE}</span>
        ))}
    </li>
  );
}

export function Journal({ entries, prices, onDelete, onClear }: { entries: JournalEntry[]; prices: Record<string, string>; onDelete(txHash: string): void; onClear(): void }) {
  if (entries.length === 0) {
    return <span className="g-meta">No journal yet. Each buy you make from an article is noted here, in this browser only.</span>;
  }
  return (
    <div className="g-journal">
      <span className="g-meta">Kept only in this browser. Glance never sends it anywhere.</span>
      <ul className="g-positions">
        {entries.map((e) => {
          const now = prices[e.symbol];
          const since = now ? sinceThen(e.priceAtBuy, now) : null;
          return (
            <li key={e.txHash} className="g-position">
              {e.page ? (
                <a className="g-ui" href={e.page.url} target="_blank" rel="noopener noreferrer">
                  {e.page.title || e.page.site}
                </a>
              ) : (
                <span className="g-ui">{BOUGHT_OUTSIDE_PAGE}</span>
              )}
              {e.page?.sentence && <span className="g-meta g-quote">“{e.page.sentence}”</span>}
              <span className="g-meta">
                {e.page ? `${e.page.site} · ` : ""}
                <span className="g-ticker">{e.symbol}</span> ${e.amount} at {priceUsd(e.priceAtBuy)}
                {now ? ` · now ${priceUsd(now)}` : ""}
                {since ? (
                  <>
                    {" "}
                    (<span className={tone(since)}>{since}</span>)
                  </>
                ) : null}
              </span>
              <div className="g-between">
                <a className="g-data" href={e.explorerUrl} target="_blank" rel="noopener noreferrer">
                  tx {shortHash(e.txHash)} ↗
                </a>
                <button className="g-link-btn" onClick={() => onDelete(e.txHash)} aria-label={`Delete the ${e.symbol} entry`}>
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button className="g-btn g-btn-ghost" onClick={onClear}>
        Clear journal
      </button>
    </div>
  );
}
