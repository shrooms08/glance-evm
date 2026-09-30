/**
 * "Compare AMD and NVIDIA": any two or three US stocks, side by side, from the market's own daily candles (the
 * any-ticker path, Yahoo Finance). Every number said is computed here: the price, the day's change, the change over
 * the window asked about (the same window for each), and where each sits in its 52-week range. No model, and no
 * recommendation. Trading stays with the vault's own stocks (the existing refusal line says so when asked).
 */
import type { ChartRange } from "./chart.ts";
import { pct, RANGE_WORDS, usd } from "./chartFacts.ts";

export const MAX_COMPARE_ANY = 3;

/** The windows a comparison can ask about ("today", "this week", "this month"), in days back from the last close. */
const WINDOW_DAYS: Partial<Record<ChartRange, number>> = { "1W": 7, "1M": 30 };

/** The names in "compare X and Y", "X vs Y", "compare X, Y and Z"; null when it isn't a comparison of 2 or 3. */
export function compareNames(text: string): string[] | null {
  const t = text
    .replace(/[’]/g, "'")
    .replace(/[?.!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const body = /^(?:(?:ok|okay|hey|glance|please|can you|could you)\s+)*compare\s+(.+)$/i.exec(t)?.[1] ?? (/\b(?:vs\.?|versus)\b/i.test(t) ? t : null);
  if (!body) return null;
  const cleaned = body
    .replace(/\b(?:today|this week|this month|over the (?:past|last) (?:week|month|day)|for (?:the )?(?:week|month|day)|right now|now|stocks?|shares|prices?|charts?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const names = cleaned
    .split(/\s*(?:,|\band\b|\bwith\b|\bto\b|\bvs\.?|\bversus\b|&)\s*/i)
    .map((n) => n.replace(/^(?:the|to|with)\s+/i, "").replace(/'s$/i, "").trim())
    .filter((n) => n.length > 0);
  return names.length >= 2 && names.length <= MAX_COMPARE_ANY ? names : null;
}

export interface ComparePoint {
  /** Unix seconds. */
  t: number;
  /** The close. */
  price: number;
}

export interface CompareAnyRow {
  symbol: string;
  name: string;
  price: number;
  /** The last close against the one before it. */
  dayChangePct: number;
  /** Over the window asked about (the same window for every stock). */
  windowChangePct: number;
  /** Over the last 52 weeks, from the daily closes. */
  yearLow: number;
  yearHigh: number;
  /** 0 at the 52-week low, 100 at the high. Null with less than a year's range to go on. */
  yearPosition: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const change = (from: number, to: number) => (from > 0 ? round2(((to - from) / from) * 100) : 0);

/** One stock's row, from a year of daily closes (oldest first). Null with fewer than two closes. */
export function compareRow(symbol: string, name: string, closes: readonly ComparePoint[], range: ChartRange): CompareAnyRow | null {
  const pts = [...closes].filter((p) => Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const last = pts.at(-1)!;
  const prev = pts.at(-2)!;
  const days = WINDOW_DAYS[range];
  // The window starts at the last close at or before (last close minus the window): the same rule for every stock.
  const since = days ? last.t - days * 86_400 : null;
  const base = since === null ? prev : ([...pts].reverse().find((p) => p.t <= since) ?? pts[0]!);
  const yearAgo = last.t - 365 * 86_400;
  const year = pts.filter((p) => p.t >= yearAgo);
  const yearLow = Math.min(...year.map((p) => p.price));
  const yearHigh = Math.max(...year.map((p) => p.price));
  const spanDays = (last.t - (year[0]?.t ?? last.t)) / 86_400;
  return {
    symbol,
    name,
    price: last.price,
    dayChangePct: change(prev.price, last.price),
    windowChangePct: change(base.price, last.price),
    yearLow,
    yearHigh,
    yearPosition: spanDays >= 300 && yearHigh > yearLow ? Math.round(((last.price - yearLow) / (yearHigh - yearLow)) * 100) : null,
  };
}

const moved = (p: number) => (p === 0 ? "was flat" : `${p > 0 ? "rose" : "fell"} ${pct(p)}`);
const upDown = (p: number) => (p === 0 ? "flat" : `${p > 0 ? "up" : "down"} ${pct(p)}`);
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The comparison in words, only from the rows. */
export function compareAnySentence(rows: readonly CompareAnyRow[], range: ChartRange): string {
  if (rows.length === 0) return "";
  const parts: string[] = [];
  if (range !== "1D") {
    const when = RANGE_WORDS[range];
    parts.push(`${when.charAt(0).toUpperCase()}${when.slice(1)}, ${list(rows.map((r) => `${r.name} ${moved(r.windowChangePct)}`))}.`);
  }
  parts.push(`${list(rows.map((r) => `${r.name} is at ${usd(r.price)}, ${upDown(r.dayChangePct)} on the day`))}.`);
  const placed = rows.filter((r) => r.yearPosition !== null);
  if (placed.length === rows.length) {
    parts.push(`In the last 52 weeks, ${list(rows.map((r) => `${r.name} is ${r.yearPosition}% of the way from its low to its high`))}.`);
  }
  return parts.join(" ");
}
