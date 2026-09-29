/**
 * Chart facts: what a price chart shows, computed in code so an answer about it never makes a number up. From the
 * points behind GET /chart (the Chainlink rounds, or the public quote's history), for one range:
 *
 *   first, last, change ($ and %)          the price that stood when the range opened, the latest, the difference
 *   high, low                               with their times
 *   biggest single drop / rise              between two consecutive published prices, with times and %
 *   max drawdown                            the deepest fall from a running peak to a later trough, with times and %
 *   from the high                           where the latest price stands against the range's high ("down from the peak")
 *   how bumpy                               the standard deviation of the point-to-point % changes, with a plain label
 *   market closed                           stretches with no new price for 6 hours or more (nights, weekends)
 *   bounces                                 lows the price rose clearly from ("where did it bounce?"), with times and %
 *   trend                                   a straight line fitted through every price: up, down or flat, and by how much
 *   support, resistance                     prices the chart turned at more than once (lows for support, highs for
 *                                           resistance), with how many times; the range's low and high when none repeat
 *   zone                                    the longest stretch the price stayed in a narrow band (a consolidation box)
 *   since your last buy                     the vault's last buy of the stock (from the portfolio event cache)
 *
 * Every number is rounded once, here (prices and dollar changes to cents, percentages to 2 places), and those rounded
 * numbers are the only ones Show me may say about the chart: groundedSentence() checks a reply against them, and
 * snapChartTags() moves its drawings onto the facts' own times and prices. Comparisons rebase each line to 100 at the
 * range's start. Pure: no network, no clock (the caller passes asOf).
 */
import type { ChartRange } from "./chart.ts";
import type { ShowAction, Tagged } from "./showme.ts";

export interface PricePoint {
  t: number;
  price: number;
}

/** A move between two points: `pct` is signed (negative for a fall). */
export interface Move {
  from: PricePoint;
  to: PricePoint;
  abs: number;
  pct: number;
}

export type Bumpiness = "smooth" | "a little bumpy" | "bumpy" | "very bumpy";

export interface ChartFacts {
  symbol: string;
  name: string;
  range: ChartRange;
  source: string;
  asOf: number;
  first: PricePoint;
  last: PricePoint;
  change: { abs: number; pct: number };
  high: PricePoint;
  low: PricePoint;
  biggestDrop: Move | null;
  biggestRise: Move | null;
  /** From the peak (`from`) to the trough (`to`); null when the price never fell below an earlier high. */
  maxDrawdown: Move | null;
  /** The latest price against the range's high: "how much is it down from the peak?" (0 when the latest is the high). */
  fromHigh: { abs: number; pct: number };
  /** "How bumpy": the standard deviation of the point-to-point % changes, over `moves` changes. */
  bumpiness: { stdevPct: number; label: Bumpiness; moves: number };
  /** No new price for CLOSED_GAP_SECONDS or more; `ongoing` when it runs to asOf. */
  closed: Array<{ from: number; to: number; hours: number; ongoing: boolean }>;
  /** The vault's last buy of this stock (any time), and the change from its price per share to the last price. */
  sinceBuy: { t: number; price: number; amount: number; abs: number; pct: number } | null;
  /** Each from a swing low (`from`) to the high of the rise after it (`to`): up to 3, in time order. */
  bounces: Move[];
  /** A least-squares line through every price, from its value at the first time to its value at the last. */
  trend: { direction: "up" | "down" | "flat"; from: PricePoint; to: PricePoint; pct: number };
  /** Where the price turned: lows it turned up from (support), highs it turned down from (resistance). */
  levels: { support: Level; resistance: Level };
  /** The longest stretch in a narrow band (at most a third of the range's high to low), when it's a fifth of the range. */
  zone: { t1: number; t2: number; low: number; high: number } | null;
}

/** A price the chart turned at `touches` times (1: just the range's low or high), with when. */
export interface Level {
  price: number;
  touches: number;
  times: number[];
}

/** Turning points: prices lower (or higher) than every price within `k` points each side. */
function turns(points: ReadonlyArray<PricePoint>, kind: "low" | "high"): PricePoint[] {
  const n = points.length;
  const k = Math.max(2, Math.round(n / 30));
  const out: PricePoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    let ok = true;
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k) && ok; j++) {
      if (j === i) continue;
      const q = points[j]!.price;
      if (kind === "low" ? q < p.price || (q === p.price && j < i) : q > p.price || (q === p.price && j < i)) ok = false;
    }
    if (ok) out.push(p);
  }
  return out;
}

/**
 * Support and resistance, computed: turning lows (highs) within a band of the larger of 0.4% and a tenth of the range
 * are one level; the level touched most (then the lowest for support, the highest for resistance) is kept. With no
 * level touched twice, the range's own low (high), touched once.
 */
export function levels(points: ReadonlyArray<PricePoint>, low: PricePoint, high: PricePoint): { support: Level; resistance: Level } {
  const band = Math.max(low.price * 0.004, (high.price - low.price) * 0.1);
  const cluster = (ps: PricePoint[], prefer: (a: number, b: number) => boolean, fallback: PricePoint): Level => {
    let best: Level | null = null;
    for (const p of ps) {
      const near = ps.filter((q) => Math.abs(q.price - p.price) <= band);
      if (near.length < 2) continue;
      const price = round2(near.reduce((s, q) => s + q.price, 0) / near.length);
      const level = { price, touches: near.length, times: near.map((q) => q.t) };
      if (!best || level.touches > best.touches || (level.touches === best.touches && prefer(level.price, best.price))) best = level;
    }
    return best ?? { price: round2(fallback.price), touches: 1, times: [fallback.t] };
  };
  return { support: cluster(turns(points, "low"), (a, b) => a < b, low), resistance: cluster(turns(points, "high"), (a, b) => a > b, high) };
}

/** The longest run of consecutive prices inside a band of a third of the range's high to low; null under a fifth of it. */
export function consolidation(points: ReadonlyArray<PricePoint>, low: number, high: number): ChartFacts["zone"] {
  const n = points.length;
  const band = (high - low) / 3;
  if (n < 10 || band <= 0) return null;
  let best: { i: number; j: number } | null = null;
  let i = 0;
  let lo = points[0]!.price;
  let hi = lo;
  for (let j = 0; j < n; j++) {
    const p = points[j]!.price;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
    while (hi - lo > band && i < j) {
      i++;
      lo = Math.min(...points.slice(i, j + 1).map((q) => q.price));
      hi = Math.max(...points.slice(i, j + 1).map((q) => q.price));
    }
    if (!best || j - i > best.j - best.i) best = { i, j };
  }
  if (!best || best.j - best.i + 1 < n / 5) return null;
  const run = points.slice(best.i, best.j + 1).map((q) => q.price);
  return { t1: points[best.i]!.t, t2: points[best.j]!.t, low: round2(Math.min(...run)), high: round2(Math.max(...run)) };
}

/** A trend flatter than this (in % over the range) is "flat". */
export const FLAT_TREND_PCT = 0.5;

/**
 * Bounces: swing lows (the lowest price within a window around them) that the price then rose clearly from: at least
 * the larger of 0.5% and twice the typical move between prices, up to the top of that rise (where it next pulls back
 * as much, or falls below the low).
 * The biggest 3, in time order.
 */
export function bounces(points: ReadonlyArray<PricePoint>, typicalMovePct: number): Move[] {
  const n = points.length;
  if (n < 5) return [];
  const k = Math.max(2, Math.round(n / 25));
  const need = Math.max(0.5, 2 * typicalMovePct);
  const found: Array<{ i: number; move: Move }> = [];
  for (let i = 1; i < n - 1; i++) {
    const p = points[i]!;
    let isLow = true;
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) if (points[j]!.price < p.price || (j < i && points[j]!.price === p.price)) isLow = false;
    if (!isLow) continue;
    // The rise after it: up to its top, until the price pulls back clearly from that top (or goes below this low).
    let top = p;
    for (let j = i + 1; j < n && points[j]!.price >= p.price; j++) {
      const q = points[j]!;
      if (q.price > top.price) top = q;
      else if (pctOf(top.price, q.price) <= -need) break;
    }
    const m = move(p, top);
    if (top !== p && m.pct >= need) found.push({ i, move: m });
  }
  return found
    .sort((a, b) => b.move.pct - a.move.pct)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i)
    .map((f) => f.move);
}

/** The straight line through every price (least squares over time), and which way it points. */
export function trendLine(points: ReadonlyArray<PricePoint>): ChartFacts["trend"] {
  const n = points.length;
  const t0 = points[0]!.t;
  const xs = points.map((p) => p.t - t0);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = points.reduce((a, p) => a + p.price, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = sxx === 0 ? 0 : xs.reduce((a, x, i) => a + (x - mx) * (points[i]!.price - my), 0) / sxx;
  const at = (x: number) => my + slope * (x - mx);
  const from = rp({ t: points[0]!.t, price: at(0) });
  const to = rp({ t: points.at(-1)!.t, price: at(xs.at(-1)!) });
  const p = pctSaid(from.price, to.price);
  return { direction: Math.abs(p) < FLAT_TREND_PCT ? "flat" : p > 0 ? "up" : "down", from, to, pct: p };
}

/** A stretch this long with no new price reads as the market being closed (the feeds publish on moves, 24/5). */
export const CLOSED_GAP_SECONDS = 6 * 3600;

const round2 = (n: number) => Math.round((n + Number.EPSILON * Math.sign(n)) * 100) / 100;
const pctOf = (from: number, to: number) => (from === 0 ? 0 : ((to - from) / from) * 100);
/** A % change between two prices as they're said (rounded to cents), so "$2.01 from $194.56" is always 1.03%. */
const pctSaid = (from: number, to: number) => round2(pctOf(round2(from), round2(to)));
// A dollar change is the difference of the two prices as they're said (rounded), so the three numbers always agree.
const diff = (from: number, to: number) => round2(round2(to) - round2(from));
const move = (a: PricePoint, b: PricePoint): Move => ({ from: rp(a), to: rp(b), abs: diff(a.price, b.price), pct: pctSaid(a.price, b.price) });
const rp = (p: PricePoint): PricePoint => ({ t: p.t, price: round2(p.price) });

/** Sorted by time, the last price winning on a tie. */
export function cleanPoints(points: ReadonlyArray<PricePoint>): PricePoint[] {
  const out: PricePoint[] = [];
  for (const p of [...points].filter((x) => Number.isFinite(x.price) && x.price > 0).sort((a, b) => a.t - b.t)) {
    const last = out.at(-1);
    if (last && last.t === p.t) last.price = p.price;
    else out.push({ t: p.t, price: p.price });
  }
  return out;
}

export function bumpinessLabel(stdevPct: number): Bumpiness {
  if (stdevPct < 0.1) return "smooth";
  if (stdevPct < 0.3) return "a little bumpy";
  if (stdevPct < 0.7) return "bumpy";
  return "very bumpy";
}

/** Population standard deviation of the point-to-point % changes (0 with fewer than two changes). */
export function bumpiness(points: ReadonlyArray<PricePoint>): { stdevPct: number; moves: number } {
  const changes: number[] = [];
  for (let i = 1; i < points.length; i++) changes.push(pctOf(points[i - 1]!.price, points[i]!.price));
  if (changes.length < 2) return { stdevPct: 0, moves: changes.length };
  const mean = changes.reduce((s, c) => s + c, 0) / changes.length;
  const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
  return { stdevPct: round2(Math.sqrt(variance)), moves: changes.length };
}

/** The deepest peak-to-trough fall (the peak is the highest price before the trough). Null when nothing fell. */
export function maxDrawdown(points: ReadonlyArray<PricePoint>): Move | null {
  if (points.length < 2) return null;
  let peak = points[0]!;
  let best: { peak: PricePoint; trough: PricePoint; dd: number } | null = null;
  for (const p of points) {
    if (p.price > peak.price) peak = p;
    const dd = (p.price - peak.price) / peak.price;
    if (dd < 0 && (!best || dd < best.dd)) best = { peak, trough: p, dd };
  }
  return best ? move(best.peak, best.trough) : null;
}

/** The biggest single fall and rise between consecutive points (by %). */
export function biggestMoves(points: ReadonlyArray<PricePoint>): { drop: Move | null; rise: Move | null } {
  let drop: [PricePoint, PricePoint, number] | null = null;
  let rise: [PricePoint, PricePoint, number] | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const pct = pctOf(a.price, b.price);
    if (pct < 0 && (!drop || pct < drop[2])) drop = [a, b, pct];
    if (pct > 0 && (!rise || pct > rise[2])) rise = [a, b, pct];
  }
  return { drop: drop ? move(drop[0], drop[1]) : null, rise: rise ? move(rise[0], rise[1]) : null };
}

/** Stretches with no new price for `gap` seconds or more, including the one running up to `asOf`. */
export function closedPeriods(points: ReadonlyArray<PricePoint>, asOf: number, gap = CLOSED_GAP_SECONDS): ChartFacts["closed"] {
  const out: ChartFacts["closed"] = [];
  const hours = (s: number) => Math.round(s / 3600);
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!.t;
    const to = points[i]!.t;
    if (to - from >= gap) out.push({ from, to, hours: hours(to - from), ongoing: false });
  }
  const last = points.at(-1);
  if (last && asOf - last.t >= gap) out.push({ from: last.t, to: asOf, hours: hours(asOf - last.t), ongoing: true });
  return out;
}

/** Everything above for one chart. Null with fewer than two prices. */
export function computeFacts(input: {
  symbol: string;
  name: string;
  range: ChartRange;
  source: string;
  asOf: number;
  points: ReadonlyArray<PricePoint>;
  /** The vault's last buy of the stock: when, the price per share paid, and the dollars spent. */
  lastBuy?: { t: number; price: number; amount: number } | null;
}): ChartFacts | null {
  const pts = cleanPoints(input.points);
  if (pts.length < 2) return null;
  const first = pts[0]!;
  const last = pts.at(-1)!;
  let high = first;
  let low = first;
  for (const p of pts) {
    if (p.price > high.price) high = p;
    if (p.price < low.price) low = p;
  }
  const { drop, rise } = biggestMoves(pts);
  const b = bumpiness(pts);
  const buy = input.lastBuy && input.lastBuy.price > 0 ? input.lastBuy : null;
  return {
    symbol: input.symbol,
    name: input.name,
    range: input.range,
    source: input.source,
    asOf: input.asOf,
    first: rp(first),
    last: rp(last),
    change: { abs: diff(first.price, last.price), pct: pctSaid(first.price, last.price) },
    high: rp(high),
    low: rp(low),
    biggestDrop: drop,
    biggestRise: rise,
    maxDrawdown: maxDrawdown(pts),
    fromHigh: { abs: diff(high.price, last.price), pct: pctSaid(high.price, last.price) },
    bumpiness: { ...b, label: bumpinessLabel(b.stdevPct) },
    closed: closedPeriods(pts, input.asOf),
    sinceBuy: buy
      ? { t: buy.t, price: round2(buy.price), amount: round2(buy.amount), abs: diff(buy.price, last.price), pct: pctSaid(buy.price, last.price) }
      : null,
    bounces: bounces(pts, b.stdevPct),
    trend: trendLine(pts),
    levels: levels(pts, low, high),
    zone: consolidation(pts, low.price, high.price),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------

/** "$1,234.50" */
export const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "2.13%" (unsigned: the words say up or down). */
export const pct = (n: number) => `${Math.abs(n).toFixed(2)}%`;
const upDown = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "flat");
export const RANGE_WORDS: Record<ChartRange, string> = {
  "1D": "today",
  "1W": "this week",
  "1M": "this month",
  "3M": "over 3 months",
  "6M": "over 6 months",
  YTD: "this year",
  "1Y": "over the past year",
  "5Y": "over 5 years",
  "10Y": "over 10 years",
  ALL: "over its whole history",
};

/** "Tuesday afternoon", in US market time (ET): times in words, never dates or clock times. */
export function dayPart(t: number): string {
  const d = new Date(t * 1000);
  const weekday = d.toLocaleString("en-US", { weekday: "long", timeZone: "America/New_York" });
  const hour = Number(d.toLocaleString("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/New_York" }));
  const part = hour < 5 ? "night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `${weekday} ${part}`;
}

/**
 * Plain sentences built only from the facts: the fallback when a generated answer can't be trusted. With the question,
 * the sentence that answers it comes first ("what was the biggest drop?" -> the biggest drop).
 */
export function factSentences(f: ChartFacts, question = ""): string[] {
  const q = question.toLowerCase();
  const first: string[] = [];
  const when = (t: number) => dayPart(t);
  const bounce = [...f.bounces].sort((a, b) => b.pct - a.pct)[0];
  if (/\b(bounce|bounced|bounces|bouncing|rebound|rebounded|bottom|bottomed)\b/.test(q)) {
    first.push(
      bounce
        ? `The clearest bounce was from ${usd(bounce.from.price)} ${when(bounce.from.t)}, up ${pct(bounce.pct)} to ${usd(bounce.to.price)} ${when(bounce.to.t)}.`
        : `It didn't bounce clearly from a low ${RANGE_WORDS[f.range]}; the low was ${usd(f.low.price)}.`,
    );
  } else if (/\b(support|resistance|floor|ceiling|entry)\b/.test(q)) {
    const s = f.levels.support;
    const r = f.levels.resistance;
    first.push(
      `It turned up near ${usd(s.price)}${s.touches > 1 ? ` ${s.touches} times` : ""} and turned down near ${usd(r.price)}${r.touches > 1 ? ` ${r.touches} times` : ""} ${RANGE_WORDS[f.range]}.`,
    );
  } else if (/\b(trend|trending|direction)\b/.test(q)) {
    first.push(f.trend.direction === "flat" ? `Overall it moved sideways ${RANGE_WORDS[f.range]}.` : `Overall the trend was ${f.trend.direction}, ${pct(f.trend.pct)} along a straight line through the prices.`);
  } else if (/\b(drop|drops|fall|fell|dip|plunge|slide|slid|worst)\b/.test(q) && f.biggestDrop) {
    first.push(`The biggest single drop was ${pct(f.biggestDrop.pct)}, from ${usd(f.biggestDrop.from.price)} to ${usd(f.biggestDrop.to.price)}, ${when(f.biggestDrop.to.t)}.`);
  } else if (/\b(rise|rose|jump|jumped|gain|best|surge)\b/.test(q) && f.biggestRise) {
    first.push(`The biggest single rise was ${pct(f.biggestRise.pct)}, from ${usd(f.biggestRise.from.price)} to ${usd(f.biggestRise.to.price)}, ${when(f.biggestRise.to.t)}.`);
  } else if (/\b(peak|top|from the high|off the high)\b/.test(q)) {
    first.push(f.fromHigh.abs === 0 ? `It's at its high for the range, ${usd(f.high.price)}.` : `It's ${usd(f.fromHigh.abs)} below its peak of ${usd(f.high.price)}, down ${pct(f.fromHigh.pct)}.`);
  } else if (/\b(bumpy|volatile|volatility|choppy|smooth)\b/.test(q)) {
    first.push(`It was ${f.bumpiness.label}: the typical move between two prices was ${pct(f.bumpiness.stdevPct)}.`);
  }
  const out = [
    ...first,
    f.change.abs === 0
      ? `${f.name} ended ${RANGE_WORDS[f.range]} where it started, at ${usd(f.last.price)}.`
      : `${f.name} went from ${usd(f.first.price)} to ${usd(f.last.price)} ${RANGE_WORDS[f.range]}, ${upDown(f.change.abs)} ${usd(f.change.abs)} (${pct(f.change.pct)}).`,
    `The high was ${usd(f.high.price)} and the low ${usd(f.low.price)}.`,
  ];
  if (f.maxDrawdown) out.push(`At its deepest it was down ${pct(f.maxDrawdown.pct)} from its peak.`);
  if (f.sinceBuy) out.push(`Since your last buy at ${usd(f.sinceBuy.price)}, it's ${upDown(f.sinceBuy.abs)} ${pct(f.sinceBuy.pct)}.`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Grounding: every number in a chart answer must be one of the facts
// ---------------------------------------------------------------------------------------------------------------------

/** The numbers a set of facts says, by kind, unsigned (the words carry the direction). */
export interface FactNumbers {
  /** Percentages: changes, moves, drawdowns, how bumpy. */
  percent: number[];
  /** Dollars: prices and dollar changes. */
  money: number[];
  /** Plain counts: the hours a market-closed stretch lasted. */
  count: number[];
}

export function factNumbers(f: ChartFacts | readonly ChartFacts[]): FactNumbers {
  const all = Array.isArray(f) ? (f as readonly ChartFacts[]) : [f as ChartFacts];
  const out: FactNumbers = { percent: [], money: [], count: [] };
  for (const x of all) {
    const moves = [x.biggestDrop, x.biggestRise, x.maxDrawdown].filter((m): m is Move => m !== null);
    out.percent.push(x.change.pct, x.fromHigh.pct, ...moves.map((m) => m.pct), x.bumpiness.stdevPct, ...(x.sinceBuy ? [x.sinceBuy.pct] : []), ...(x.bounces ?? []).map((m) => m.pct), ...(x.trend ? [x.trend.pct] : []));
    out.money.push(
      x.first.price,
      x.last.price,
      x.change.abs,
      x.fromHigh.abs,
      x.high.price,
      x.low.price,
      ...moves.flatMap((m) => [m.from.price, m.to.price, m.abs]),
      ...(x.sinceBuy ? [x.sinceBuy.price, x.sinceBuy.amount, x.sinceBuy.abs] : []),
      ...(x.bounces ?? []).flatMap((m) => [m.from.price, m.to.price, m.abs]),
      ...(x.trend ? [x.trend.from.price, x.trend.to.price] : []),
      ...(x.levels ? [x.levels.support.price, x.levels.resistance.price] : []),
      ...(x.zone ? [x.zone.low, x.zone.high] : []),
    );
    out.count.push(...x.closed.map((c) => c.hours), ...(x.levels ? [x.levels.support.touches, x.levels.resistance.touches] : []));
  }
  return { percent: out.percent.map(Math.abs), money: out.money.map(Math.abs), count: out.count };
}

/** The times the facts name (drawings snap to these). */
export function factTimes(f: ChartFacts): number[] {
  const moves = [f.biggestDrop, f.biggestRise, f.maxDrawdown].filter((m): m is Move => m !== null);
  const times = [f.first.t, f.last.t, f.high.t, f.low.t, ...moves.flatMap((m) => [m.from.t, m.to.t]), ...(f.bounces ?? []).flatMap((m) => [m.from.t, m.to.t]), ...(f.zone ? [f.zone.t1, f.zone.t2] : []), ...(f.levels ? [...f.levels.support.times, ...f.levels.resistance.times] : []), ...f.closed.flatMap((c) => [c.from, c.to])];
  if (f.sinceBuy && f.sinceBuy.t >= f.first.t && f.sinceBuy.t <= f.last.t) times.push(f.sinceBuy.t);
  return [...new Set(times.filter((t) => t >= f.first.t && t <= Math.max(f.last.t, f.asOf)))].sort((a, b) => a - b);
}

/** The prices the facts name (levels snap to these). */
export function factPrices(f: ChartFacts): number[] {
  const moves = [f.biggestDrop, f.biggestRise, f.maxDrawdown].filter((m): m is Move => m !== null);
  return [
    ...new Set([
      f.first.price,
      f.last.price,
      f.high.price,
      f.low.price,
      ...moves.flatMap((m) => [m.from.price, m.to.price]),
      ...(f.bounces ?? []).flatMap((m) => [m.from.price, m.to.price]),
      ...(f.trend ? [f.trend.from.price, f.trend.to.price] : []),
      ...(f.levels ? [f.levels.support.price, f.levels.resistance.price] : []),
      ...(f.zone ? [f.zone.low, f.zone.high] : []),
      ...(f.sinceBuy ? [f.sinceBuy.price] : []),
    ]),
  ];
}

/** Numbers written in digits: "$1,234.50", "2.13%", "-4", "0.31". */
export function numbersIn(text: string): Array<{ value: number; decimals: number; money: boolean; percent: boolean }> {
  const out: Array<{ value: number; decimals: number; money: boolean; percent: boolean }> = [];
  for (const m of text.matchAll(/(\$)?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(%| ?percent\b)?/gi)) {
    const digits = `${m[2]!.replace(/,/g, "")}${m[3] ? `.${m[3]}` : ""}`;
    out.push({ value: Number(digits), decimals: m[3]?.length ?? 0, money: Boolean(m[1]), percent: Boolean(m[4]) });
  }
  return out;
}

/** Amounts spelled out in words ("three sixty two", "twelve percent") can't be checked, so they don't pass. */
const SPELLED_AMOUNT = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(percent|dollars?|point)\b/i;

/**
 * Whether every number in `text` is one of the facts of its kind (a % only matches a fact percentage, a $ amount only a
 * fact price or dollar change), at the precision it's written with: "$362" and "$362.2" both match 362.20, "2%"
 * matches 2.13, "2.1%" doesn't. Small bare counts (0 to 10) and the numbers in `alsoAllowed` (a company's own name:
 * "S&P 500 ETF") pass too. Spelled-out amounts never do.
 */
export function groundedSentence(text: string, allowed: FactNumbers, alsoAllowed: readonly number[] = []): { ok: boolean; unknown: number[] } {
  const unknown: number[] = [];
  if (SPELLED_AMOUNT.test(text)) return { ok: false, unknown: [Number.NaN] };
  for (const n of numbersIn(text)) {
    if (!n.money && !n.percent && n.decimals === 0 && n.value <= 10) continue;
    if (!n.money && !n.percent && alsoAllowed.includes(n.value)) continue;
    const pool = n.percent ? allowed.percent : n.money ? allowed.money : [...allowed.money, ...allowed.percent, ...allowed.count];
    const slack = 0.5 * 10 ** -n.decimals + 1e-9;
    if (!pool.some((v) => Math.abs(v - n.value) <= slack)) unknown.push(n.value);
  }
  return { ok: unknown.length === 0, unknown };
}

/**
 * "It peaked at $384.64, then dipped to $361.59": when a sentence links fact prices with "then", "after", "later" or
 * "followed", they must have happened in that order. False when two named prices run backwards in time (a price that
 * stood at more than one time can't be placed, so it's not judged).
 */
export function timeOrderOk(text: string, facts: readonly ChartFacts[]): boolean {
  if (!/\b(then|after|afterwards|later|followed|before falling|before rising|before dipping)\b/i.test(text)) return true;
  const at = new Map<number, number | null>();
  const note = (price: number, t: number) => at.set(price, at.has(price) && at.get(price) !== t ? null : t);
  for (const f of facts) {
    const moves = [f.biggestDrop, f.biggestRise, f.maxDrawdown].filter((m): m is Move => m !== null);
    for (const p of [f.first, f.last, f.high, f.low, ...moves.flatMap((m) => [m.from, m.to])]) note(p.price, p.t);
  }
  let prev: number | null = null;
  for (const n of numbersIn(text)) {
    if (!n.money) continue;
    const t = at.get(n.value);
    if (t === undefined || t === null) continue;
    if (prev !== null && t < prev) return false;
    prev = t;
  }
  return true;
}

/** Claims of a cause ("because", "after Reuters reported"): only allowed with a cached news source to cite. */
export const CAUSE = /\b(because|due to|driven by|thanks to|on the back of|amid|after (?:\w+ ){0,4}(reported|announced|said|released|posted|missed|beat)|on (news|reports|word) (of|that))\b/i;

// ---------------------------------------------------------------------------------------------------------------------
// Drawings on the facts' own times and prices
// ---------------------------------------------------------------------------------------------------------------------

const nearest = (xs: readonly number[], x: number) => xs.reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best), xs[0]!);

/**
 * Moves every chart drawing onto the facts: a point or a band's ends to the nearest time the facts name, a level to
 * the fact price it's within 0.5% of (else it's dropped), and a level's label must only use the facts' numbers.
 * Drawings for a stock without facts are left as they are (validateChartTags still checks them).
 */
export function snapChartTags(t: Tagged, facts: readonly ChartFacts[]): Tagged {
  const bySymbol = new Map(facts.map((f) => [f.symbol, f]));
  const out: ShowAction[] = [];
  for (const a of t.actions) {
    const f = "symbol" in a ? bySymbol.get(a.symbol) : undefined;
    if (!f || (a.kind !== "CHART_POINT" && a.kind !== "CHART_LEVEL" && a.kind !== "CHART_RANGE" && a.kind !== "CHART_TREND")) {
      out.push(a);
      continue;
    }
    const times = factTimes(f);
    if (a.kind === "CHART_POINT") out.push({ ...a, t: nearest(times, a.t) });
    else if (a.kind === "CHART_LEVEL") {
      const price = nearest(factPrices(f), a.price);
      if (Math.abs(price - a.price) <= price * 0.005 && groundedSentence(a.label, factNumbers(f)).ok) out.push({ ...a, price });
    } else {
      const t1 = nearest(times, a.t1);
      const t2 = nearest(times, a.t2);
      if (t2 > t1) out.push({ ...a, t1, t2 });
    }
  }
  return { spoken: t.spoken, actions: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------------------------------------------------

export const MAX_COMPARE = 3;
export const REBASED_LABEL = "rebased to 100" as const;

/** Each price as a share of the first, times 100 (2 decimals): lines that start together at 100. */
export function rebase(points: ReadonlyArray<PricePoint>): Array<{ t: number; value: number }> {
  const pts = cleanPoints(points);
  const base = pts[0]?.price;
  if (!base) return [];
  return pts.map((p) => ({ t: p.t, value: round2((p.price / base) * 100) }));
}

export interface CompareRow {
  symbol: string;
  name: string;
  changePct: number;
  maxDrawdownPct: number;
  bumpiness: { stdevPct: number; label: Bumpiness };
}

export function compareRows(facts: readonly ChartFacts[]): CompareRow[] {
  return facts.map((f) => ({
    symbol: f.symbol,
    name: f.name,
    changePct: f.change.pct,
    maxDrawdownPct: f.maxDrawdown?.pct ?? 0,
    bumpiness: { stdevPct: f.bumpiness.stdevPct, label: f.bumpiness.label },
  }));
}

/** The comparison in words, only from the facts: each change %, each deepest fall, and which was bumpier. */
export function compareSentence(facts: readonly ChartFacts[]): string {
  if (facts.length === 0) return "";
  const range = RANGE_WORDS[facts[0]!.range];
  const changes = facts.map((f) => `${f.name} ${f.change.pct === 0 ? "was flat" : `${upDown(f.change.pct)} ${pct(f.change.pct)}`}`);
  const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  const falls = facts.map((f) => (f.maxDrawdown ? `${f.name} ${pct(f.maxDrawdown.pct)}` : `${f.name} none`));
  const bumpiest = [...facts].sort((a, b) => b.bumpiness.stdevPct - a.bumpiness.stdevPct)[0]!;
  const calmest = [...facts].sort((a, b) => a.bumpiness.stdevPct - b.bumpiness.stdevPct)[0]!;
  const bumps =
    bumpiest.bumpiness.stdevPct === calmest.bumpiness.stdevPct
      ? "They were about as bumpy as each other."
      : `${bumpiest.name} was the bumpiest (${pct(bumpiest.bumpiness.stdevPct)} typical move), ${calmest.name} the calmest (${pct(calmest.bumpiness.stdevPct)}).`;
  return `${range[0]!.toUpperCase()}${range.slice(1)}, ${list(changes)}. Deepest fall from a peak: ${list(falls)}. ${bumps}`;
}
