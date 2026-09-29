/**
 * Candle formations, found in code from the candles a page's chart was calibrated against (never by the vision model).
 * The explainer lines say what each one looks like and what traders often read into it, framed as a hint.
 *
 *   single   doji, hammer, inverted hammer, hanging man, shooting star, marubozu (bullish, bearish), spinning top
 *   two      engulfing (bullish, bearish), harami (bullish, bearish), piercing line, dark cloud cover, tweezer top,
 *            tweezer bottom, inside bar
 *   three    morning star, evening star, three white soldiers, three black crows
 *
 * A reversal pattern needs the trend it reverses: a bullish one after a decline, a bearish one after a rise. Without
 * it the shape isn't called by that name (a hammer's shape after a rise is a hanging man; after no trend, nothing).
 * Zero-range bars are skipped, and so are extended-hours bars when the page shows regular hours only.
 */

export interface Candle {
  /** Unix seconds. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Every threshold, in one place (fractions of a bar's high to low range unless said otherwise). */
export const CANDLE_CONFIG = {
  /** A doji's body is at most this much of its range. */
  dojiBody: 0.1,
  /** A spinning top's body is at most this much of its range, and each shadow at least `spinningShadow`. */
  spinningBody: 0.3,
  spinningShadow: 0.25,
  /** Hammer family: the body at most this much of the range... */
  hammerBody: 0.35,
  /** ...the long shadow at least this many bodies... */
  hammerShadowBodies: 2,
  /** ...and the other shadow at most this much of the range. */
  hammerOtherShadow: 0.12,
  /** A marubozu's body is at least this much of its range. */
  marubozuBody: 0.9,
  /** A "long" body (engulfed, harami mother, star's first bar, piercing's first bar): at least this much of range. */
  longBody: 0.5,
  /** A harami's inside body is at most this much of the mother's body. */
  haramiBody: 0.5,
  /** A star's middle body is at most this much of the first bar's body. */
  starBody: 0.35,
  /** Tweezers: the two highs (or lows) within this fraction of the average range. */
  tweezerTolerance: 0.08,
  /** Soldiers and crows: each body at least this much of its range, each upper (lower) shadow at most `soldierShadow`. */
  soldierBody: 0.55,
  soldierShadow: 0.3,
  /** Bars before a pattern read for its trend. */
  trendBars: 6,
  /** A decline or a rise moves at least this many average ranges over `trendBars`. */
  trendRanges: 1,
  /** Bars averaged for the typical range. */
  rangeBars: 20,
  /** A bar under this fraction of the typical range is too small to call (a quiet print). */
  minRange: 0.25,
  /** Matches kept, and the least strength worth listing. */
  maxMatches: 3,
  minStrength: 0.35,
  /** "Explain this chart" mentions a pattern at least this strong. */
  strongStrength: 0.6,
} as const;

export type CandleConfig = { -readonly [K in keyof typeof CANDLE_CONFIG]: number };

export type PatternId =
  | "doji"
  | "hammer"
  | "inverted-hammer"
  | "hanging-man"
  | "shooting-star"
  | "bullish-marubozu"
  | "bearish-marubozu"
  | "spinning-top"
  | "bullish-engulfing"
  | "bearish-engulfing"
  | "bullish-harami"
  | "bearish-harami"
  | "piercing-line"
  | "dark-cloud-cover"
  | "tweezer-top"
  | "tweezer-bottom"
  | "inside-bar"
  | "morning-star"
  | "evening-star"
  | "three-white-soldiers"
  | "three-black-crows";

export type Direction = "bullish" | "bearish" | "neutral";

export interface Trend {
  direction: "decline" | "rise" | "flat";
  /** Bars read. */
  bars: number;
  /** The move over them, in average ranges (negative: down). */
  ranges: number;
}

export interface PatternMatch {
  id: PatternId;
  name: string;
  /** Indexes into the candles given. */
  bars: number[];
  times: number[];
  direction: Direction;
  /** The trend read before it (null when the pattern doesn't need one). */
  trend: Trend | null;
  /** 0 to 1. */
  strength: number;
  /** The pattern's price span (for its mark: a box from low to high across its bars). */
  low: number;
  high: number;
}

export const PATTERN_NAMES: Record<PatternId, string> = {
  doji: "Doji",
  hammer: "Hammer",
  "inverted-hammer": "Inverted hammer",
  "hanging-man": "Hanging man",
  "shooting-star": "Shooting star",
  "bullish-marubozu": "Bullish marubozu",
  "bearish-marubozu": "Bearish marubozu",
  "spinning-top": "Spinning top",
  "bullish-engulfing": "Bullish engulfing",
  "bearish-engulfing": "Bearish engulfing",
  "bullish-harami": "Bullish harami",
  "bearish-harami": "Bearish harami",
  "piercing-line": "Piercing line",
  "dark-cloud-cover": "Dark cloud cover",
  "tweezer-top": "Tweezer top",
  "tweezer-bottom": "Tweezer bottom",
  "inside-bar": "Inside bar",
  "morning-star": "Morning star",
  "evening-star": "Evening star",
  "three-white-soldiers": "Three white soldiers",
  "three-black-crows": "Three black crows",
};

// ---------------------------------------------------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------------------------------------------------

const range = (c: Candle) => c.high - c.low;
const body = (c: Candle) => Math.abs(c.close - c.open);
const upper = (c: Candle) => c.high - Math.max(c.open, c.close);
const lower = (c: Candle) => Math.min(c.open, c.close) - c.low;
const bull = (c: Candle) => c.close > c.open;
const bear = (c: Candle) => c.close < c.open;
const bodyTop = (c: Candle) => Math.max(c.open, c.close);
const bodyBottom = (c: Candle) => Math.min(c.open, c.close);
const mid = (c: Candle) => (c.open + c.close) / 2;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Minutes after midnight in New York. */
function nyMinutes(t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(t * 1000));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** A bar inside the regular session (9:30 to 16:00 New York), for intraday candles. */
export function regularSession(t: number): boolean {
  const m = nyMinutes(t);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

export interface DetectOptions {
  /** The page shows the regular session only: extended-hours bars are left out (intraday candles). */
  regularOnly?: boolean;
  /** The candles are intraday (under a day each). Default: judged from their spacing. */
  intraday?: boolean;
  config?: Partial<CandleConfig>;
}

/** The candles worth reading, with their indexes in the input. */
function usable(candles: readonly Candle[], o: DetectOptions): Array<{ c: Candle; i: number }> {
  const sorted = candles.map((c, i) => ({ c, i })).sort((a, b) => a.c.t - b.c.t);
  const step = sorted.length > 1 ? (sorted.at(-1)!.c.t - sorted[0]!.c.t) / (sorted.length - 1) : 86_400;
  const intraday = o.intraday ?? step < 20 * 3600;
  return sorted.filter(({ c }) => range(c) > 0 && [c.open, c.high, c.low, c.close].every(Number.isFinite) && (!o.regularOnly || !intraday || regularSession(c.t)));
}

/** The trend over the `n` bars before position `at` (a least-squares line through their closes). */
export function trendBefore(bars: readonly Candle[], at: number, avgRange: number, cfg: CandleConfig = CANDLE_CONFIG): Trend | null {
  const n = Math.min(cfg.trendBars, at);
  if (n < 3 || avgRange <= 0) return null;
  const ys = bars.slice(at - n, at).map((c) => c.close);
  const mx = (n - 1) / 2;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  ys.forEach((y, x) => {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  });
  const ranges = ((sxy / sxx) * (n - 1)) / avgRange;
  const direction = ranges <= -cfg.trendRanges ? "decline" : ranges >= cfg.trendRanges ? "rise" : "flat";
  return { direction, bars: n, ranges: Math.round(ranges * 100) / 100 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------------------------

interface Found {
  id: PatternId;
  /** Positions in the usable bars. */
  at: number[];
  /** How cleanly the bars make the shape, 0 to 1. */
  shape: number;
  /** A reversal needs this trend before it. */
  needs?: "decline" | "rise";
}

function single(c: Candle, avg: number, cfg: CandleConfig): Found[] {
  const r = range(c);
  const b = body(c);
  const out: Array<Omit<Found, "at">> = [];
  if (b <= cfg.dojiBody * r) out.push({ id: "doji", shape: clamp01(1 - b / (cfg.dojiBody * r)) * 0.6 + 0.4 });
  else if (b <= cfg.spinningBody * r && upper(c) >= cfg.spinningShadow * r && lower(c) >= cfg.spinningShadow * r) {
    out.push({ id: "spinning-top", shape: clamp01(Math.min(upper(c), lower(c)) / (0.4 * r)) });
  }
  if (b > cfg.dojiBody * r * 0.5 && b <= cfg.hammerBody * r) {
    // The long shadow below, the body at the top: a hammer after a decline, a hanging man after a rise.
    if (lower(c) >= cfg.hammerShadowBodies * b && upper(c) <= cfg.hammerOtherShadow * r) {
      const shape = clamp01(lower(c) / (3 * b)) * 0.7 + clamp01(1 - upper(c) / (cfg.hammerOtherShadow * r)) * 0.3;
      out.push({ id: "hammer", shape, needs: "decline" }, { id: "hanging-man", shape, needs: "rise" });
    }
    // The long shadow above, the body at the bottom: an inverted hammer after a decline, a shooting star after a rise.
    if (upper(c) >= cfg.hammerShadowBodies * b && lower(c) <= cfg.hammerOtherShadow * r) {
      const shape = clamp01(upper(c) / (3 * b)) * 0.7 + clamp01(1 - lower(c) / (cfg.hammerOtherShadow * r)) * 0.3;
      out.push({ id: "inverted-hammer", shape, needs: "decline" }, { id: "shooting-star", shape, needs: "rise" });
    }
  }
  if (b >= cfg.marubozuBody * r && r >= avg) out.push({ id: bull(c) ? "bullish-marubozu" : "bearish-marubozu", shape: clamp01((b / r - cfg.marubozuBody) / (1 - cfg.marubozuBody)) * 0.5 + 0.5 });
  return out.map((f) => ({ ...f, at: [0] }));
}

function double(a: Candle, c: Candle, avg: number, cfg: CandleConfig): Found[] {
  const out: Found[] = [];
  const at = [0, 1];
  // Engulfing: the second body covers the first, opposite colors.
  if (bear(a) && bull(c) && c.open <= a.close && c.close >= a.open && body(c) > body(a)) out.push({ id: "bullish-engulfing", at, shape: clamp01(body(c) / (2 * body(a))), needs: "decline" });
  if (bull(a) && bear(c) && c.open >= a.close && c.close <= a.open && body(c) > body(a)) out.push({ id: "bearish-engulfing", at, shape: clamp01(body(c) / (2 * body(a))), needs: "rise" });
  // Harami: a small body inside a long one.
  const inside = bodyTop(c) <= bodyTop(a) && bodyBottom(c) >= bodyBottom(a) && body(c) <= cfg.haramiBody * body(a) && body(a) >= cfg.longBody * range(a);
  if (inside && bear(a) && !bear(c)) out.push({ id: "bullish-harami", at, shape: clamp01(1 - body(c) / body(a)), needs: "decline" });
  if (inside && bull(a) && !bull(c)) out.push({ id: "bearish-harami", at, shape: clamp01(1 - body(c) / body(a)), needs: "rise" });
  // Piercing line and dark cloud cover: the second opens past the first's close and closes past its middle.
  if (bear(a) && bull(c) && body(a) >= cfg.longBody * range(a) && c.open <= a.close && c.close > mid(a) && c.close < a.open) {
    out.push({ id: "piercing-line", at, shape: clamp01((c.close - mid(a)) / (body(a) / 2)) * 0.5 + 0.5, needs: "decline" });
  }
  if (bull(a) && bear(c) && body(a) >= cfg.longBody * range(a) && c.open >= a.close && c.close < mid(a) && c.close > a.open) {
    out.push({ id: "dark-cloud-cover", at, shape: clamp01((mid(a) - c.close) / (body(a) / 2)) * 0.5 + 0.5, needs: "rise" });
  }
  // Tweezers: two matching highs (a rise turning) or lows (a decline turning).
  const tol = cfg.tweezerTolerance * avg;
  if (Math.abs(a.high - c.high) <= tol && bull(a) && bear(c)) out.push({ id: "tweezer-top", at, shape: clamp01(1 - Math.abs(a.high - c.high) / (tol || 1)) * 0.5 + 0.5, needs: "rise" });
  if (Math.abs(a.low - c.low) <= tol && bear(a) && bull(c)) out.push({ id: "tweezer-bottom", at, shape: clamp01(1 - Math.abs(a.low - c.low) / (tol || 1)) * 0.5 + 0.5, needs: "decline" });
  // Inside bar: the whole second bar within the first's (a pause). Where a harami says it better, the ranking keeps one.
  if (c.high <= a.high && c.low >= a.low && (c.high < a.high || c.low > a.low)) {
    out.push({ id: "inside-bar", at, shape: clamp01(1 - range(c) / range(a)) });
  }
  return out;
}

function triple(a: Candle, b: Candle, c: Candle, cfg: CandleConfig): Found[] {
  const out: Found[] = [];
  const at = [0, 1, 2];
  const longA = body(a) >= cfg.longBody * range(a);
  const smallB = body(b) <= cfg.starBody * body(a);
  // Stars: a long bar, a small one beyond its close, then a bar back past the first one's middle.
  if (longA && smallB && bear(a) && bodyTop(b) <= a.close + 0.25 * body(a) && bull(c) && c.close > mid(a)) {
    out.push({ id: "morning-star", at, shape: clamp01((c.close - mid(a)) / (body(a) / 2)) * 0.5 + clamp01(1 - body(b) / (cfg.starBody * body(a))) * 0.5, needs: "decline" });
  }
  if (longA && smallB && bull(a) && bodyBottom(b) >= a.close - 0.25 * body(a) && bear(c) && c.close < mid(a)) {
    out.push({ id: "evening-star", at, shape: clamp01((mid(a) - c.close) / (body(a) / 2)) * 0.5 + clamp01(1 - body(b) / (cfg.starBody * body(a))) * 0.5, needs: "rise" });
  }
  // Soldiers and crows: three long bars the same way, each opening inside the last one's body.
  const bars = [a, b, c];
  const strong = (x: Candle) => body(x) >= cfg.soldierBody * range(x);
  if (bars.every((x) => bull(x) && strong(x) && upper(x) <= cfg.soldierShadow * range(x)) && b.close > a.close && c.close > b.close && b.open >= a.open && b.open <= a.close && c.open >= b.open && c.open <= b.close) {
    out.push({ id: "three-white-soldiers", at, shape: clamp01(Math.min(...bars.map((x) => body(x) / range(x)))), needs: "decline" });
  }
  if (bars.every((x) => bear(x) && strong(x) && lower(x) <= cfg.soldierShadow * range(x)) && b.close < a.close && c.close < b.close && b.open <= a.open && b.open >= a.close && c.open <= b.open && c.open >= b.close) {
    out.push({ id: "three-black-crows", at, shape: clamp01(Math.min(...bars.map((x) => body(x) / range(x)))), needs: "rise" });
  }
  return out;
}

const DIRECTION: Record<PatternId, Direction> = {
  doji: "neutral",
  hammer: "bullish",
  "inverted-hammer": "bullish",
  "hanging-man": "bearish",
  "shooting-star": "bearish",
  "bullish-marubozu": "bullish",
  "bearish-marubozu": "bearish",
  "spinning-top": "neutral",
  "bullish-engulfing": "bullish",
  "bearish-engulfing": "bearish",
  "bullish-harami": "bullish",
  "bearish-harami": "bearish",
  "piercing-line": "bullish",
  "dark-cloud-cover": "bearish",
  "tweezer-top": "bearish",
  "tweezer-bottom": "bullish",
  "inside-bar": "neutral",
  "morning-star": "bullish",
  "evening-star": "bearish",
  "three-white-soldiers": "bullish",
  "three-black-crows": "bearish",
};

/** Every formation in `candles` (all of them, oldest first), each with its trend and strength. */
export function findPatterns(candles: readonly Candle[], o: DetectOptions = {}): PatternMatch[] {
  const cfg: CandleConfig = { ...CANDLE_CONFIG, ...o.config };
  const kept = usable(candles, o);
  const bars = kept.map((k) => k.c);
  const avgAt = (i: number) => {
    const from = Math.max(0, i - cfg.rangeBars);
    const slice = bars.slice(from, Math.max(i, from + 1));
    return slice.reduce((s, c) => s + range(c), 0) / slice.length;
  };
  const out: PatternMatch[] = [];
  for (let end = 0; end < bars.length; end++) {
    const avg = avgAt(end);
    const found: Array<Found & { start: number }> = [];
    found.push(...single(bars[end]!, avg, cfg).map((f) => ({ ...f, start: end })));
    if (end >= 1) found.push(...double(bars[end - 1]!, bars[end]!, avg, cfg).map((f) => ({ ...f, start: end - 1 })));
    if (end >= 2) found.push(...triple(bars[end - 2]!, bars[end - 1]!, bars[end]!, cfg).map((f) => ({ ...f, start: end - 2 })));
    for (const f of found) {
      const positions = f.at.map((k) => f.start + k);
      // Too small to call: a quiet print says little.
      if (positions.some((p) => range(bars[p]!) < cfg.minRange * avgAt(p))) continue;
      const trend = f.needs ? trendBefore(bars, f.start, avgAt(f.start), cfg) : null;
      if (f.needs && trend?.direction !== f.needs) continue; // no trend to reverse: not this pattern
      const span = positions.map((p) => bars[p]!);
      const size = clamp01(Math.max(...span.map(range)) / (1.5 * avg));
      const trendScore = trend ? clamp01(Math.abs(trend.ranges) / (2.5 * cfg.trendRanges)) : 0.5;
      const strength = Math.round((0.5 * f.shape + 0.3 * trendScore + 0.2 * size) * 100) / 100;
      out.push({
        id: f.id,
        name: PATTERN_NAMES[f.id],
        bars: positions.map((p) => kept[p]!.i),
        times: span.map((c) => c.t),
        direction: DIRECTION[f.id],
        trend,
        strength,
        low: Math.min(...span.map((c) => c.low)),
        high: Math.max(...span.map((c) => c.high)),
      });
    }
  }
  return out;
}

/** The formations worth naming: most recent first, then the strongest; at most `maxMatches`, one per bar span. */
export function detectPatterns(candles: readonly Candle[], o: DetectOptions = {}): PatternMatch[] {
  const cfg: CandleConfig = { ...CANDLE_CONFIG, ...o.config };
  const found = findPatterns(candles, o);
  // A harami is an inside bar with a trend to reverse: on the same two bars, the harami is the name to use.
  const harami = new Set(found.filter((m) => m.id.endsWith("harami")).map((m) => m.times.join()));
  const all = found.filter((m) => m.strength >= cfg.minStrength && !(m.id === "inside-bar" && harami.has(m.times.join())));
  const last = (m: PatternMatch) => m.times.at(-1)!;
  all.sort((a, b) => last(b) - last(a) || b.strength - a.strength || b.bars.length - a.bars.length);
  const out: PatternMatch[] = [];
  for (const m of all) {
    // One name per stretch of bars: a later, weaker match on overlapping bars adds nothing.
    if (out.some((k) => k.times.some((t) => m.times.includes(t)))) continue;
    out.push(m);
    if (out.length >= cfg.maxMatches) break;
  }
  return out;
}

/** The most recent formation at least `strongStrength` strong, if any (for "Explain this chart"). */
export function strongPattern(candles: readonly Candle[], o: DetectOptions = {}): PatternMatch | null {
  const cfg: CandleConfig = { ...CANDLE_CONFIG, ...o.config };
  return detectPatterns(candles, o).find((m) => m.strength >= cfg.strongStrength) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The last candle
// ---------------------------------------------------------------------------------------------------------------------

export interface LastCandle {
  candle: Candle;
  index: number;
  color: "green" | "red" | "flat";
  /** The single-bar shape it makes, when it makes one (a hammer's shape is named only with its trend). */
  shape: PatternMatch | null;
  bodyPct: number;
}

/** The last usable candle, and what shape it makes. */
export function lastCandle(candles: readonly Candle[], o: DetectOptions = {}): LastCandle | null {
  const kept = usable(candles, o);
  const k = kept.at(-1);
  if (!k) return null;
  const c = k.c;
  const shape = findPatterns(candles, o).filter((m) => m.bars.length === 1 && m.bars[0] === k.i).sort((a, b) => b.strength - a.strength)[0] ?? null;
  return { candle: c, index: k.i, color: bull(c) ? "green" : bear(c) ? "red" : "flat", shape, bodyPct: Math.round((body(c) / range(c)) * 100) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The explainer
// ---------------------------------------------------------------------------------------------------------------------

/** Said after every explanation. */
export const PATTERN_CAVEAT = "It's a hint, not a guarantee.";

/** Per pattern: what it looks like, and what traders often read into it. */
export const EXPLAINERS: Record<PatternId, { looks: string; reads: string }> = {
  doji: {
    looks: "A doji opens and closes at almost the same price, so its body is a thin line between its shadows.",
    reads: "Traders often read it as indecision, a pause where neither side took control.",
  },
  hammer: {
    looks: "A hammer has a small body near the top of the candle and a long lower shadow, at least twice the body, after a decline.",
    reads: "Traders often read it as prices being pushed down and then bid back up, a sign the decline may be tiring.",
  },
  "inverted-hammer": {
    looks: "An inverted hammer has a small body near the bottom of the candle and a long upper shadow, after a decline.",
    reads: "Traders often read it as a first attempt to push prices higher after the decline.",
  },
  "hanging-man": {
    looks: "A hanging man has a small body near the top and a long lower shadow, like a hammer, but it comes after a rise.",
    reads: "Traders often read it as a warning that the rise may be losing strength.",
  },
  "shooting-star": {
    looks: "A shooting star has a small body near the bottom and a long upper shadow, after a rise.",
    reads: "Traders often read it as prices being pushed up and then turned back, a sign the rise may be tiring.",
  },
  "bullish-marubozu": {
    looks: "A bullish marubozu is a long green candle with little or no shadow: it opens near its low and closes near its high.",
    reads: "Traders often read it as the bulls in control from the open to the close.",
  },
  "bearish-marubozu": {
    looks: "A bearish marubozu is a long red candle with little or no shadow: it opens near its high and closes near its low.",
    reads: "Traders often read it as the bears in control from the open to the close.",
  },
  "spinning-top": {
    looks: "A spinning top has a small body in the middle and shadows of similar length above and below.",
    reads: "Traders often read it as a balance between the two sides, with no clear winner.",
  },
  "bullish-engulfing": {
    looks: "A bullish engulfing is a red candle followed by a larger green one whose body covers the red body completely, after a decline.",
    reads: "Traders often read it as the bulls taking over from the bears.",
  },
  "bearish-engulfing": {
    looks: "A bearish engulfing is a green candle followed by a larger red one whose body covers the green body completely, after a rise.",
    reads: "Traders often read it as the bears taking over from the bulls.",
  },
  "bullish-harami": {
    looks: "A bullish harami is a long red candle followed by a small candle whose body sits inside the red body, after a decline.",
    reads: "Traders often read it as the decline losing momentum.",
  },
  "bearish-harami": {
    looks: "A bearish harami is a long green candle followed by a small candle whose body sits inside the green body, after a rise.",
    reads: "Traders often read it as the rise losing momentum.",
  },
  "piercing-line": {
    looks: "A piercing line is a long red candle followed by a green one that opens lower and closes above the middle of the red body.",
    reads: "Traders often read it as the bulls pushing back after a decline.",
  },
  "dark-cloud-cover": {
    looks: "Dark cloud cover is a long green candle followed by a red one that opens higher and closes below the middle of the green body.",
    reads: "Traders often read it as the bears pushing back after a rise.",
  },
  "tweezer-top": {
    looks: "A tweezer top is two candles with matching highs after a rise, the first green and the second red.",
    reads: "Traders often read it as prices failing twice at the same level.",
  },
  "tweezer-bottom": {
    looks: "A tweezer bottom is two candles with matching lows after a decline, the first red and the second green.",
    reads: "Traders often read it as prices holding twice at the same level.",
  },
  "inside-bar": {
    looks: "An inside bar is a candle whose whole range sits within the candle before it.",
    reads: "Traders often read it as a pause, with the range narrowing before the next move.",
  },
  "morning-star": {
    looks: "A morning star is three candles after a decline: a long red one, a small one below it, then a green one that closes above the middle of the first.",
    reads: "Traders often read it as a possible turn from a decline toward a rise.",
  },
  "evening-star": {
    looks: "An evening star is three candles after a rise: a long green one, a small one above it, then a red one that closes below the middle of the first.",
    reads: "Traders often read it as a possible turn from a rise toward a decline.",
  },
  "three-white-soldiers": {
    looks: "Three white soldiers are three long green candles in a row after a decline, each opening inside the last one's body and closing higher.",
    reads: "Traders often read it as steady strength after the decline.",
  },
  "three-black-crows": {
    looks: "Three black crows are three long red candles in a row after a rise, each opening inside the last one's body and closing lower.",
    reads: "Traders often read it as steady weakness after the rise.",
  },
};

/** The explainer entry for a pattern: what it looks like, what traders read into it, and the caveat. */
export function explainPattern(id: PatternId): string {
  const e = EXPLAINERS[id];
  return `${e.looks} ${e.reads} ${PATTERN_CAVEAT}`;
}

/** The pattern a question names ("What's a hammer?"), if it names one. */
export function patternNamed(text: string): PatternId | null {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  const order = (Object.keys(PATTERN_NAMES) as PatternId[]).sort((a, b) => PATTERN_NAMES[b].length - PATTERN_NAMES[a].length);
  for (const id of order) {
    const name = PATTERN_NAMES[id].toLowerCase();
    if (t.includes(name) || t.includes(id.replace(/-/g, " "))) return id;
  }
  if (/\bengulf/.test(t)) return /\bbear/.test(t) ? "bearish-engulfing" : "bullish-engulfing";
  if (/\bharami\b/.test(t)) return /\bbear/.test(t) ? "bearish-harami" : "bullish-harami";
  if (/\bmarubozu\b/.test(t)) return /\bbear/.test(t) ? "bearish-marubozu" : "bullish-marubozu";
  if (/\btweezers?\b/.test(t)) return /\bbottom/.test(t) ? "tweezer-bottom" : "tweezer-top";
  if (/\bsoldiers\b/.test(t)) return "three-white-soldiers";
  if (/\bcrows\b/.test(t)) return "three-black-crows";
  if (/\bdark cloud\b/.test(t)) return "dark-cloud-cover";
  if (/\bpiercing\b/.test(t)) return "piercing-line";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Which candle question
// ---------------------------------------------------------------------------------------------------------------------

export type CandleIntent = { kind: "patterns" } | { kind: "last-candle" } | { kind: "explain"; id: PatternId };

/** "Any candle patterns here?", "What's that last candle?", "What's a hammer?"; null for anything else. */
export function candleIntent(text: string): CandleIntent | null {
  const t = text.toLowerCase().replace(/[’']/g, "'").trim();
  // A question about a pattern by name, not about this chart: the explainer, no marks, on any page.
  const id = patternNamed(t);
  if (id && /^(what('s| is| are| does)|what's|explain|define|tell me about|how do (i|you) (read|spot))\b/.test(t) && !/\b(here|this chart|on (the|this) chart|any)\b/.test(t)) return { kind: "explain", id };
  if (/\b(last|latest|today's|todays|this|that|current|most recent) (candle|bar)\b/.test(t) || /\bcandle (today|right now)\b/.test(t)) return { kind: "last-candle" };
  if (/\b(candle(stick)?s? )?(patterns?|formations?)\b/.test(t) && /\b(any|see|spot|find|show|are there|what|which|here|this chart)\b/.test(t)) return { kind: "patterns" };
  return null;
}
