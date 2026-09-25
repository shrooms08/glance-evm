/**
 * GET /chart/:symbols/facts?range=1D|1W|1M[&vault=0x…]: the computed breakdown of one chart, or a comparison of up to
 * three ("TSLA,AMD"). Deterministic: the numbers come from @glance/core/chart-facts over the same points as GET /chart,
 * never from a model. With a vault, "since your last buy" comes from the portfolio event cache (no chain read).
 * A comparison adds each line rebased to 100 at the range's start, the side-by-side rows and a sentence built from them.
 */
import type { Address } from "viem";

import type { ChartData, ChartRange } from "@glance/core/chart";
import { compareRows, compareSentence, computeFacts, MAX_COMPARE, rebase, REBASED_LABEL, type ChartFacts, type CompareRow } from "@glance/core/chart-facts";
import { toDecimalString } from "@glance/core/format";

import type { AppContext } from "./context.js";
import { ApiError, chartDeps, chartView, stockBySymbol } from "./services.js";

export interface FactsView {
  range: ChartRange;
  facts: ChartFacts[];
  comparison: {
    label: typeof REBASED_LABEL;
    lines: Array<{ symbol: string; name: string; points: Array<{ t: number; value: number }> }>;
    rows: CompareRow[];
    sentence: string;
  } | null;
}

/** The vault's last buy of this stock from the portfolio event cache: when, price per share, dollars spent. */
export function lastBuyFrom(
  cached: { events: ReadonlyArray<{ kind: string; token: string; timestamp: number; usdgIn?: bigint; tokensOut?: bigint }>; usdgDecimals: number } | null,
  token: string,
  tokenDecimals: number,
): { t: number; price: number; amount: number } | null {
  const buys = (cached?.events ?? []).filter((e) => e.kind === "buy" && e.token.toLowerCase() === token.toLowerCase() && (e.tokensOut ?? 0n) > 0n);
  const last = buys.sort((a, b) => a.timestamp - b.timestamp).at(-1);
  if (!last || !cached) return null;
  const d = cached.usdgDecimals;
  const perShare = (last.usdgIn! * 10n ** BigInt(tokenDecimals)) / last.tokensOut!;
  return { t: last.timestamp, price: Number(toDecimalString(perShare, d)), amount: Number(toDecimalString(last.usdgIn!, d)) };
}

/** Facts for one stock's chart data (already fetched). */
export function factsFor(ctx: AppContext, data: ChartData, vault?: Address): ChartFacts | null {
  const stock = stockBySymbol(ctx, data.symbol);
  const lastBuy = vault ? lastBuyFrom(chartDeps(ctx).trades(vault), stock.token, stock.tokenDecimals) : null;
  return computeFacts({
    symbol: data.symbol,
    name: stock.name,
    range: data.range,
    source: data.source.label,
    asOf: data.asOf,
    points: data.points.map((p) => ({ t: p.t, price: p.price })),
    lastBuy,
  });
}

export async function factsView(ctx: AppContext, symbols: readonly string[], range: ChartRange, vault?: Address): Promise<FactsView> {
  const unique = [...new Set(symbols.map((s) => stockBySymbol(ctx, s).symbol))];
  if (unique.length === 0 || unique.length > MAX_COMPARE) throw new ApiError(400, "INVALID_INPUT", `Ask about 1 to ${MAX_COMPARE} stocks.`);
  const charts = await Promise.all(unique.map((s) => chartView(ctx, s, range, vault)));
  const facts: ChartFacts[] = [];
  for (const data of charts) {
    const f = factsFor(ctx, data, vault);
    if (!f) throw new ApiError(404, "NO_CHART_DATA", `There's no chart data for ${data.symbol} yet.`);
    facts.push(f);
  }
  const comparison =
    facts.length > 1
      ? {
          label: REBASED_LABEL,
          lines: charts.map((c, i) => ({ symbol: c.symbol, name: facts[i]!.name, points: rebase(c.points) })),
          rows: compareRows(facts),
          sentence: compareSentence(facts),
        }
      : null;
  return { range, facts, comparison };
}
