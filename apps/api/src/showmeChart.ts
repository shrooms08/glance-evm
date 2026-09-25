/**
 * The chart context Show me gets when the question is about a stock's price movement, or a chart is open: a compact
 * summary of what the chart shows (symbol, range, about 60 points, the high and the low with their times, the first
 * and latest price, and the trade and news markers already on it), so the model can draw on Glance's own chart with
 * the chart tags, and the "Why it moved" sources that are already cached, to cite (never fetched here: no Finnhub or
 * Claude call from a chart).
 */
import type { ChartData, ChartRange } from "@glance/core/chart";
import { dayPart, pct, RANGE_WORDS, usd, type ChartFacts } from "@glance/core/chart-facts";
import { rangeFor } from "@glance/core/showme";
import type { Address } from "viem";

import { factsFor } from "./chartFacts.js";
import type { AppContext } from "./context.js";
import { chartView } from "./services.js";
import { findCompanies } from "./voice/intent.js";

export const SUMMARY_POINTS = 60;

export interface ChartSummary {
  symbol: string;
  name: string;
  range: ChartRange;
  source: string;
  points: Array<{ t: number; price: number }>;
  high: { t: number; price: number };
  low: { t: number; price: number };
  first: { t: number; price: number };
  latest: { t: number; price: number };
  markers: string[];
  /** Cached "Why it moved" headlines for the stock (maybe none). */
  news: Array<{ title: string; site: string; publishedAt: string }>;
}

/** About `n` points, evenly by index, always keeping the first, the last, the high and the low. */
export function downsample(points: ReadonlyArray<{ t: number; price: number }>, n = SUMMARY_POINTS): Array<{ t: number; price: number }> {
  if (points.length <= n) return [...points];
  const keep = new Set<number>([0, points.length - 1]);
  let hi = 0;
  let lo = 0;
  points.forEach((p, i) => {
    if (p.price > points[hi]!.price) hi = i;
    if (p.price < points[lo]!.price) lo = i;
  });
  keep.add(hi).add(lo);
  const step = (points.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) keep.add(Math.round(i * step));
  return [...keep].sort((a, b) => a - b).map((i) => points[i]!);
}

export function summarize(data: ChartData, name: string, news: ChartSummary["news"]): ChartSummary | null {
  const pts = data.points.map((p) => ({ t: p.t, price: p.price }));
  if (pts.length < 2) return null;
  const byPrice = [...pts].sort((a, b) => a.price - b.price);
  return {
    symbol: data.symbol,
    name,
    range: data.range,
    source: data.source.label,
    points: downsample(pts),
    high: byPrice.at(-1)!,
    low: byPrice[0]!,
    first: pts[0]!,
    latest: pts.at(-1)!,
    markers: data.markers.slice(-8).map((m) => (m.kind === "news" ? `news at ${m.t}: ${m.title} (${m.site})` : `${m.kind} at ${m.t}: ${m.amount} at ${m.price}`)),
    news,
  };
}

/** A question about a stock's price movement (or its chart, or how the user's buy has done). */
export const MOVEMENT =
  /\b(chart|graph|move|moved|moving|drop|dropped|dropping|fell|fall|falling|rose|rise|rising|jump|jumped|rally|rallied|slid|slide|plunge|plunged|surge|surged|climb|climbed|high|low|peak|bottom|price|trend|week|today|month|down|up|do|did|doing|done|perform|performed|drawdown|bumpy|volatile|volatility|swing|swings|bought|since)\b/i;

/**
 * The charts to summarize for this question: the one already open (with its range), else a stock the question names
 * when it's about price movement. Never more than one.
 */
export async function chartContextFor(
  ctx: AppContext,
  input: { question: string; openChart?: { symbol: string; range: ChartRange } | null; vault?: string },
): Promise<{ charts: ChartSummary[]; facts: ChartFacts[] }> {
  let symbol: string | null = null;
  let range: ChartRange = rangeFor(input.question);
  const named = findCompanies(input.question, ctx.catalog.entries);
  if (input.openChart && ctx.catalog.bySymbol.has(input.openChart.symbol) && (named.length === 0 || named[0] === input.openChart.symbol)) {
    symbol = input.openChart.symbol;
    if (!/\b(today|week|month)\b/i.test(input.question)) range = input.openChart.range;
  } else if (named.length === 1 && MOVEMENT.test(input.question)) {
    symbol = named[0]!;
  }
  if (!symbol) return { charts: [], facts: [] };
  try {
    const vault = input.vault as Address | undefined;
    const data = await chartView(ctx, symbol, range, vault);
    const news = (ctx.why.summaries.get(symbol)?.value.sources ?? []).slice(0, 5).map((s) => ({ title: s.title, site: s.site, publishedAt: s.publishedAt }));
    const s = summarize(data, ctx.catalog.bySymbol.get(symbol)?.name ?? symbol, news);
    const f = factsFor(ctx, data, vault);
    return { charts: s ? [s] : [], facts: f ? [f] : [] };
  } catch {
    return { charts: [], facts: [] }; // no chart data: the answer goes ahead without chart tags
  }
}

/**
 * The prompt block for a chart summary, plus the cached sources (or a plain "none"). With computed facts, the points
 * are left out: the facts' numbers and times are all the answer may use (and draw with).
 */
export function chartBlock(c: ChartSummary, withFacts = false): string {
  const pts = withFacts ? "see <chart_facts>" : c.points.map((p) => `${p.t} ${p.price.toFixed(2)}`).join("; ");
  const news = c.news.length
    ? c.news.map((n, i) => `[${i + 1}] ${n.title} (${n.site}, ${n.publishedAt.slice(0, 16).replace("T", " ")} UTC)`).join("\n")
    : "none cached: don't explain the move, say you don't have the news for it";
  return [
    `<chart symbol="${c.symbol}" name="${c.name}" range="${c.range}" source="${c.source}">`,
    `points (unix time, price): ${pts}`,
    ...(withFacts
      ? []
      : [`high: ${c.high.price.toFixed(2)} at ${c.high.t}; low: ${c.low.price.toFixed(2)} at ${c.low.t}`, `first: ${c.first.price.toFixed(2)} at ${c.first.t}; latest: ${c.latest.price.toFixed(2)} at ${c.latest.t}`]),
    c.markers.length ? `markers: ${c.markers.join("; ")}` : "markers: none",
    `</chart>`,
    `<why_it_moved_sources symbol="${c.symbol}">`,
    news,
    `</why_it_moved_sources>`,
  ].join("\n");
}

/** The key prices in the order they happened, so "then" means then: "low $361.59 (Friday morning), then high ...". */
function inOrder(f: ChartFacts): string {
  const events = [
    { t: f.first.t, what: `start ${usd(f.first.price)}` },
    { t: f.high.t, what: `high ${usd(f.high.price)}` },
    { t: f.low.t, what: `low ${usd(f.low.price)}` },
    { t: f.last.t, what: `latest ${usd(f.last.price)}` },
  ].sort((a, b) => a.t - b.t);
  const seen = new Set<number>();
  return events
    .filter((e) => (seen.has(e.t) ? false : (seen.add(e.t), true)))
    .map((e) => `${e.what} (${dayPart(e.t)})`)
    .join(", then ");
}

/** "up $4.20 (1.12%)" */
const signed = (abs: number, p: number) => (abs === 0 ? "flat" : `${abs > 0 ? "up" : "down"} ${usd(abs)} (${pct(p)})`);
const when = (t: number) => `${dayPart(t)} ET [t=${t}]`;

/**
 * The computed facts, as the only numbers an answer may say: each one written exactly as it may be spoken, with its
 * time in words and its unix time for drawings.
 */
export function factsBlock(f: ChartFacts): string {
  const m = (label: string, x: ChartFacts["biggestDrop"]) =>
    x ? `${label}: ${x.pct < 0 ? "down" : "up"} ${pct(x.pct)} (${usd(x.abs)}), from ${usd(x.from.price)} ${when(x.from.t)} to ${usd(x.to.price)} ${when(x.to.t)}` : `${label}: none`;
  return [
    `<chart_facts symbol="${f.symbol}" name="${f.name}" range="${f.range}" (${RANGE_WORDS[f.range]})>`,
    `(the only numbers you may say about ${f.name}: as digits, exactly as shown here, like "${usd(f.last.price)}" or "${pct(f.change.pct)}"; a number in words, or one not listed, is removed)`,
    `first: ${usd(f.first.price)} ${when(f.first.t)}`,
    `latest: ${usd(f.last.price)} ${when(f.last.t)}`,
    `change over the range: ${signed(f.change.abs, f.change.pct)}`,
    `high: ${usd(f.high.price)} ${when(f.high.t)}`,
    `low: ${usd(f.low.price)} ${when(f.low.t)}`,
    m("biggest single drop between two prices", f.biggestDrop),
    m("biggest single rise between two prices", f.biggestRise),
    m("max drawdown (peak to trough)", f.maxDrawdown),
    `latest against the high (how far it is from the peak now): ${f.fromHigh.abs === 0 ? "the latest price is the high" : signed(f.fromHigh.abs, f.fromHigh.pct)}`,
    `how bumpy: ${pct(f.bumpiness.stdevPct)} typical move between prices (${f.bumpiness.label})`,
    `in time order: ${inOrder(f)}`,
    f.closed.length
      ? `market closed (no new prices): ${f.closed.map((c) => `${c.hours} hours from ${when(c.from)} ${c.ongoing ? "until now" : `to ${when(c.to)}`}`).join("; ")}`
      : "market closed: no closed stretch in this range",
    f.sinceBuy
      ? `since the user's last buy (${usd(f.sinceBuy.amount)} at ${usd(f.sinceBuy.price)} a share, ${dayPart(f.sinceBuy.t)} ET): ${signed(f.sinceBuy.abs, f.sinceBuy.pct)} a share`
      : "since the user's last buy: no buy of this stock in this vault",
    `</chart_facts>`,
  ].join("\n");
}
