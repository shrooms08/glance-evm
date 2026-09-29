/**
 * Candle questions, answered in code from the candles the page's chart was calibrated against (@glance/core/candles):
 * the detector finds the formations, the explainer library words them, and each sentence carries the mark it draws.
 * No model writes these sentences.
 *
 *   "Any candle patterns here?"   up to 3 formations, each marked (a shaded box across its bars, with its name)
 *   "What's that last candle?"    the last candle: its open, close and range, and the shape it makes
 *   "What's a hammer?"            the explainer entry; no marks, on any page
 *   "Explain this chart"          the usual answer, plus one sentence on the most recent strong formation
 *
 * On a line or area chart the candles can't be seen: "Switch the chart to candles to see it clearly." once a page.
 */
import {
  CANDLE_CONFIG,
  detectPatterns,
  EXPLAINERS,
  explainPattern,
  lastCandle,
  PATTERN_CAVEAT,
  type Candle,
  type CandleIntent,
  type Direction,
  type PatternMatch,
} from "@glance/core/candles";
import { dayPart, usd } from "@glance/core/chart-facts";
import type { ChartPoint } from "@glance/core/chart";

/** A formation's mark: a shaded box across its bars from their low to their high, with its name. */
export interface PatternMark {
  kind: "PATTERN";
  t1: number;
  t2: number;
  /** The candles either side (null at an end): the box reaches half way to them, so it covers the bars' bodies. */
  before: number | null;
  after: number | null;
  low: number;
  high: number;
  label: string;
  direction: Direction;
}

export interface CandleSentence {
  text: string;
  mark?: PatternMark;
}

export const SWITCH_TO_CANDLES = "Switch the chart to candles to see it clearly.";
export const NO_CANDLES = "I don't have this chart's candles right now, so I can't read its patterns.";
export const NO_PATTERNS = "I don't see a clear candle pattern on this chart right now.";
export const NO_CHART_FOR_CANDLES = "I need a chart on the page to read its candles.";

/** "Explain this chart", "walk me through this chart": an explanation of the whole chart (it gets the formation sentence). */
export function explainsChart(question: string): boolean {
  const t = question.toLowerCase().replace(/[’]/g, "'");
  return /\b(explain|walk me through|break down|describe|what's going on (in|with|on)|what is going on (in|with|on))\b.*\b(chart|graph)\b/.test(t);
}

/** The whole candles among a chart's points (a point without its open, high and low is skipped). */
export function toCandles(points: readonly ChartPoint[]): Candle[] {
  return points.flatMap((p) => (p.open !== undefined && p.high !== undefined && p.low !== undefined ? [{ t: p.t, open: p.open, high: p.high, low: p.low, close: p.price }] : []));
}

const intradayOf = (c: readonly Candle[]) => c.length > 1 && (c.at(-1)!.t - c[0]!.t) / (c.length - 1) < 20 * 3600;

/** When a candle was, in words: "Tuesday afternoon" for intraday candles, "on September 22" for daily ones. */
export function whenWords(t: number, intraday: boolean): string {
  if (intraday) return dayPart(t);
  return `on ${new Date(t * 1000).toLocaleString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" })}`;
}

/** "the bulls taking over from the bears." from "Traders often read it as the bulls taking over from the bears." */
const readsAs = (m: PatternMatch) => EXPLAINERS[m.id].reads.replace(/^Traders often read it as /, "");
const article = (name: string) => (/^[aeiou]/i.test(name) ? "An" : "A");

/** The mark for bars `times` (their low to high), named `label`. */
export function markFor(times: readonly number[], low: number, high: number, label: string, direction: Direction, candles: readonly Candle[]): PatternMark {
  const first = candles.findIndex((c) => c.t === times[0]);
  const last = candles.findIndex((c) => c.t === times.at(-1));
  return {
    kind: "PATTERN",
    t1: times[0]!,
    t2: times.at(-1)!,
    before: first > 0 ? candles[first - 1]!.t : null,
    after: last >= 0 && last < candles.length - 1 ? candles[last + 1]!.t : null,
    low,
    high,
    label,
    direction,
  };
}

export const patternMark = (m: PatternMatch, candles: readonly Candle[]) => markFor(m.times, m.low, m.high, m.name, m.direction, candles);

export interface CandleChart {
  points: readonly ChartPoint[];
  /** What the page draws: candles, a line (or area), or not known. */
  series: "candles" | "line" | null;
  /** The page shows the pre- and after-market (else extended-hours bars are left out). */
  prepost: boolean;
}

/**
 * The sentences for a candle question about a chart (the explainer needs none: see explainerAnswer). `lineNoteSaid`:
 * the switch-to-candles line was already said on this page.
 */
export function candleAnswer(intent: Exclude<CandleIntent, { kind: "explain" }>, chart: CandleChart, lineNoteSaid = false): CandleSentence[] {
  const candles = toCandles(chart.points);
  if (candles.length < 3) return [{ text: NO_CANDLES }];
  const opts = { regularOnly: !chart.prepost };
  const intraday = intradayOf(candles);
  const out: CandleSentence[] = [];
  if (chart.series === "line" && !lineNoteSaid) out.push({ text: SWITCH_TO_CANDLES });
  if (intent.kind === "patterns") {
    const found = detectPatterns(candles, opts);
    if (found.length === 0) return [...out, { text: NO_PATTERNS }];
    out.push({ text: found.length === 1 ? "I see one candle pattern here." : `I see ${found.length} candle patterns here.` });
    for (const m of found) out.push({ text: `${article(m.name)} ${m.name.toLowerCase()} ${whenWords(m.times.at(-1)!, intraday)}, which traders often read as ${readsAs(m)}`, mark: patternMark(m, candles) });
    out.push({ text: PATTERN_CAVEAT });
    return out;
  }
  // The last candle.
  const last = lastCandle(candles, opts);
  if (!last) return [...out, { text: NO_CANDLES }];
  const c = last.candle;
  const which = intraday ? "The last candle" : `The last candle, ${whenWords(c.t, false)},`;
  out.push({
    text: `${which} is ${last.color}: it opened at ${usd(c.open)}, closed at ${usd(c.close)}, and traded between ${usd(c.low)} and ${usd(c.high)}.`,
    mark: markFor([c.t], c.low, c.high, last.shape?.name ?? "Last candle", last.color === "green" ? "bullish" : last.color === "red" ? "bearish" : "neutral", candles),
  });
  if (last.shape) {
    const s = last.shape;
    out.push({ text: `It has the shape of ${article(s.name).toLowerCase()} ${s.name.toLowerCase()}, which traders often read as ${readsAs(s)}` });
    out.push({ text: PATTERN_CAVEAT });
  } else out.push({ text: `Its body is ${last.bodyPct}% of its range, so it doesn't make a named pattern on its own.` });
  return out;
}

/** "What's a hammer?": the explainer entry, sentence by sentence. No marks. */
export function explainerAnswer(id: Extract<CandleIntent, { kind: "explain" }>["id"]): CandleSentence[] {
  return explainPattern(id)
    .split(/(?<=\.)\s+/)
    .map((text) => ({ text }));
}

/** For "Explain this chart": one sentence on the most recent strong formation (strength at least 0.6), or null. */
export function strongPatternSentence(chart: CandleChart): CandleSentence | null {
  const candles = toCandles(chart.points);
  if (candles.length < 3) return null;
  const m = detectPatterns(candles, { regularOnly: !chart.prepost }).find((x) => x.strength >= CANDLE_CONFIG.strongStrength);
  if (!m) return null;
  return {
    text: `The most recent clear candle pattern is ${article(m.name).toLowerCase()} ${m.name.toLowerCase()} ${whenWords(m.times.at(-1)!, intradayOf(candles))}, which traders often read as ${readsAs(m).replace(/\.$/, "")}, a hint, not a guarantee.`,
    mark: patternMark(m, candles),
  };
}
