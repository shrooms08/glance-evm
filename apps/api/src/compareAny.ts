/**
 * "Compare AMD and NVIDIA" for any US stocks (GET /compare, and the spoken compare intent). Each name becomes a US
 * ticker (the catalog's own stocks first, then a ticker as written, then Yahoo Finance's symbol search, cached), and
 * each ticker's facts come from a year of the market's daily candles (the any-ticker path). The sentence is built in
 * code (@glance/core/compare-any). Nothing here trades: the vault still trades only its own stocks.
 */
import { compareAnySentence, compareRow, MAX_COMPARE_ANY, type CompareAnyRow } from "@glance/core/compare-any";
import type { ChartRange } from "@glance/core/chart";
import { shortName } from "@glance/core/tickers";

import type { AppContext } from "./context.js";
import { ApiError, marketChartView } from "./services.js";
import { findCompanies } from "./voice/intent.js";

const US_TICKER = /^[A-Z]{1,5}(?:\.[A-Z])?$/;
/** US listings, as Yahoo names their exchanges. */
const US_EXCHANGES = new Set(["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS", "NAS", "NYS", "NIM"]);
const SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const SEARCH_TTL_MS = 7 * 24 * 3600 * 1000;
const searched = new Map<string, { at: number; ticker: string | null }>();

export type TickerSearch = (name: string) => Promise<string | null>;

/** Yahoo Finance's symbol search: the first US-listed stock or ETF it finds for a name. */
export const yahooSearch =
  (doFetch: typeof fetch = fetch): TickerSearch =>
  async (name) => {
    const key = name.toLowerCase();
    const hit = searched.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.ticker;
    const res = await doFetch(`${SEARCH}?${new URLSearchParams({ q: name, quotesCount: "6", newsCount: "0" })}`, {
      headers: { "user-agent": "Mozilla/5.0 (Glance compare)", accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!res?.ok) return null;
    const body = (await res.json().catch(() => null)) as { quotes?: Array<{ symbol?: string; quoteType?: string; exchange?: string }> } | null;
    const q = (body?.quotes ?? []).find((x) => (x.quoteType === "EQUITY" || x.quoteType === "ETF") && US_EXCHANGES.has(x.exchange ?? "") && US_TICKER.test(x.symbol ?? ""));
    const ticker = q?.symbol ?? null;
    searched.set(key, { at: Date.now(), ticker });
    return ticker;
  };

/** A name as said or typed, as a US ticker: the catalog's stocks, a ticker written in capitals, else the search. */
export async function resolveTicker(ctx: AppContext, name: string, search: TickerSearch): Promise<string | null> {
  const inCatalog = findCompanies(name, ctx.catalog.entries)[0];
  if (inCatalog) return inCatalog;
  const bare = name.trim().replace(/^\$/, "");
  if (US_TICKER.test(bare)) return bare;
  return search(bare);
}

export interface CompareAnyView {
  range: ChartRange;
  symbols: string[];
  rows: CompareAnyRow[];
  sentence: string;
  source: string;
  /** Names that matched no US stock. */
  unmatched: string[];
}

export async function compareAnyView(ctx: AppContext, names: readonly string[], range: ChartRange, search: TickerSearch = yahooSearch()): Promise<CompareAnyView> {
  if (names.length < 2 || names.length > MAX_COMPARE_ANY) throw new ApiError(400, "INVALID_INPUT", `Name 2 or ${MAX_COMPARE_ANY} stocks to compare.`);
  const resolved = await Promise.all(names.map(async (n) => ({ name: n, ticker: await resolveTicker(ctx, n, search).catch(() => null) })));
  const unmatched = resolved.filter((r) => !r.ticker).map((r) => r.name);
  const tickers = [...new Set(resolved.flatMap((r) => (r.ticker ? [r.ticker] : [])))];
  if (tickers.length < 2) {
    throw new ApiError(404, "NO_MARKET_DATA", unmatched.length ? `I can't find a US stock called ${unmatched.join(" or ")}.` : "Name two different stocks to compare.");
  }
  // A year of daily closes each: the same source and the same window for every stock.
  const rows: CompareAnyRow[] = [];
  for (const ticker of tickers) {
    const known = ctx.catalog.bySymbol.get(ticker);
    const data = await marketChartView(ctx, ticker, "1Y", known?.name);
    const row = compareRow(ticker, shortName(data.name ?? known?.name ?? ticker), data.points, range);
    if (!row) throw new ApiError(404, "NO_MARKET_DATA", `I can't find ${ticker}'s prices right now.`);
    rows.push(row);
  }
  return { range, symbols: tickers, rows, sentence: compareAnySentence(rows, range), source: "Yahoo Finance daily closes", unmatched };
}
