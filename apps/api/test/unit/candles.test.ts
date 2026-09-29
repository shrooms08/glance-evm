/**
 * Candle formations (@glance/core/candles): a positive and a near-miss fixture per pattern, the trend rule (a
 * reversal needs the trend it reverses), the bars left out, the ranking, the four candle questions, and the
 * explainer's wording.
 */
import { describe, expect, it, vi } from "vitest";

import { marketChartData, yahooHistory } from "../../src/chart.js";
import { rulesIntent } from "../../src/voice/intent.js";

import {
  CANDLE_CONFIG,
  candleIntent,
  detectPatterns,
  EXPLAINERS,
  explainPattern,
  findPatterns,
  lastCandle,
  PATTERN_CAVEAT,
  PATTERN_NAMES,
  patternNamed,
  strongPattern,
  type Candle,
  type PatternId,
} from "@glance/core/candles";

const DAY = 86_400;
const T0 = Date.UTC(2026, 6, 1) / 1000;

/** Bars as [open, high, low, close], a day apart. */
function bars(...ohlc: Array<[number, number, number, number]>): Candle[] {
  return ohlc.map(([open, high, low, close], i) => ({ t: T0 + i * DAY, open, high, low, close }));
}

/** Six falling bars, closing at 111 (each 2.1 high to low). */
const DECLINE: Array<[number, number, number, number]> = Array.from({ length: 6 }, (_, k) => {
  const o = 120 - 1.5 * k;
  return [o, o + 0.3, o - 1.8, o - 1.5];
});
/** Six rising bars, closing at 89. */
const RISE: Array<[number, number, number, number]> = Array.from({ length: 6 }, (_, k) => {
  const o = 80 + 1.5 * k;
  return [o, o + 1.8, o - 0.3, o + 1.5];
});
/** Eight sideways bars around 100 (each 1.6 high to low). */
const FLAT: Array<[number, number, number, number]> = Array.from({ length: 8 }, (_, k) => (k % 2 === 0 ? [100, 101.2, 99.6, 100.8] : [100.8, 101.2, 99.6, 100]));

/** Whether `id` is found ending on the last bar. */
function endsWith(candles: Candle[], id: PatternId): boolean {
  return findPatterns(candles).some((m) => m.id === id && m.bars.at(-1) === candles.length - 1);
}

const CASES: Array<{ id: PatternId; before: typeof DECLINE; yes: typeof DECLINE; near: typeof DECLINE }> = [
  // Single bars.
  { id: "doji", before: FLAT, yes: [[100.4, 101.2, 99.6, 100.45]], near: [[100.2, 101.2, 99.6, 100.5]] },
  { id: "hammer", before: DECLINE, yes: [[110.9, 111.35, 109.5, 111.3]], near: [[110.9, 111.35, 110.4, 111.3]] },
  { id: "inverted-hammer", before: DECLINE, yes: [[111.3, 112.9, 110.85, 110.9]], near: [[111.3, 111.9, 110.85, 110.9]] },
  { id: "hanging-man", before: RISE, yes: [[88.9, 89.35, 87.5, 89.3]], near: [[88.9, 89.35, 88.4, 89.3]] },
  { id: "shooting-star", before: RISE, yes: [[89.3, 90.9, 88.85, 88.9]], near: [[89.3, 89.9, 88.85, 88.9]] },
  { id: "bullish-marubozu", before: FLAT, yes: [[99.6, 101.65, 99.58, 101.6]], near: [[99.6, 101.9, 99.3, 101.6]] },
  { id: "bearish-marubozu", before: FLAT, yes: [[101.6, 101.62, 99.55, 99.6]], near: [[101.6, 101.9, 99.3, 99.6]] },
  { id: "spinning-top", before: FLAT, yes: [[100.2, 101.2, 99.5, 100.5]], near: [[100.2, 100.6, 99.2, 100.5]] },
  // Two bars.
  {
    id: "bullish-engulfing",
    before: DECLINE,
    yes: [
      [111, 111.2, 109.8, 110],
      [109.9, 111.6, 109.7, 111.4],
    ],
    near: [
      [111, 111.2, 109.8, 110],
      [109.9, 111, 109.7, 110.8],
    ],
  },
  {
    id: "bearish-engulfing",
    before: RISE,
    yes: [
      [89, 90.2, 88.8, 90],
      [90.1, 90.3, 88.4, 88.6],
    ],
    near: [
      [89, 90.2, 88.8, 90],
      [90.1, 90.3, 89, 89.2],
    ],
  },
  {
    id: "bullish-harami",
    before: DECLINE,
    yes: [
      [111.5, 111.7, 109.3, 109.5],
      [110, 110.8, 109.8, 110.5],
    ],
    near: [
      [111.5, 111.7, 109.3, 109.5],
      [109.8, 111.2, 109.6, 111],
    ],
  },
  {
    id: "bearish-harami",
    before: RISE,
    yes: [
      [88.5, 90.7, 88.3, 90.5],
      [90, 90.2, 89.2, 89.5],
    ],
    near: [
      [88.5, 90.7, 88.3, 90.5],
      [90.2, 90.4, 88.6, 88.9],
    ],
  },
  {
    id: "piercing-line",
    before: DECLINE,
    yes: [
      [111.5, 111.6, 109.4, 109.5],
      [109.3, 110.9, 109.1, 110.8],
    ],
    near: [
      [111.5, 111.6, 109.4, 109.5],
      [109.3, 110.4, 109.1, 110.3],
    ],
  },
  {
    id: "dark-cloud-cover",
    before: RISE,
    yes: [
      [88.5, 90.6, 88.4, 90.5],
      [90.7, 90.9, 89.1, 89.2],
    ],
    near: [
      [88.5, 90.6, 88.4, 90.5],
      [90.7, 90.9, 89.6, 89.7],
    ],
  },
  {
    id: "tweezer-top",
    before: RISE,
    yes: [
      [89, 90.5, 88.8, 90.2],
      [90.1, 90.52, 89.2, 89.4],
    ],
    near: [
      [89, 90.5, 88.8, 90.2],
      [90.1, 91, 89.2, 89.4],
    ],
  },
  {
    id: "tweezer-bottom",
    before: DECLINE,
    yes: [
      [111, 111.2, 109.5, 109.8],
      [109.9, 111, 109.52, 110.8],
    ],
    near: [
      [111, 111.2, 109.5, 109.8],
      [109.9, 111, 109.1, 110.8],
    ],
  },
  { id: "inside-bar", before: FLAT, yes: [[100.3, 100.9, 99.9, 100.6]], near: [[100.3, 101.3, 99.9, 100.6]] },
  // Three bars.
  {
    id: "morning-star",
    before: DECLINE,
    yes: [
      [112, 112.1, 109.9, 110],
      [109.7, 109.9, 109.3, 109.6],
      [109.8, 111.5, 109.7, 111.4],
    ],
    near: [
      [112, 112.1, 109.9, 110],
      [109.7, 109.9, 109.3, 109.6],
      [109.8, 110.7, 109.7, 110.6],
    ],
  },
  {
    id: "evening-star",
    before: RISE,
    yes: [
      [88, 90.1, 87.9, 90],
      [90.3, 90.7, 90.1, 90.4],
      [90.2, 90.3, 88.5, 88.6],
    ],
    near: [
      [88, 90.1, 87.9, 90],
      [90.3, 90.7, 90.1, 90.4],
      [90.2, 90.3, 89.3, 89.4],
    ],
  },
  {
    id: "three-white-soldiers",
    before: DECLINE,
    yes: [
      [110, 111.3, 109.9, 111.2],
      [110.6, 112.1, 110.5, 112],
      [111.5, 113, 111.4, 112.9],
    ],
    near: [
      [110, 111.3, 109.9, 111.2],
      [110.6, 112.1, 110.5, 112],
      [111.5, 112.5, 111.4, 111.9],
    ],
  },
  {
    id: "three-black-crows",
    before: RISE,
    yes: [
      [90, 90.1, 88.7, 88.8],
      [89.4, 89.5, 87.9, 88],
      [88.5, 88.6, 87, 87.1],
    ],
    near: [
      [90, 90.1, 88.7, 88.8],
      [89.4, 89.5, 87.9, 88],
      [88.5, 88.6, 87.9, 88.1],
    ],
  },
];

describe("candle formations: a positive and a near miss for each", () => {
  it("covers every pattern", () => {
    expect(new Set(CASES.map((c) => c.id))).toEqual(new Set(Object.keys(PATTERN_NAMES)));
  });

  for (const c of CASES) {
    it(`${PATTERN_NAMES[c.id]}: found, and not on a near miss`, () => {
      expect(endsWith(bars(...c.before, ...c.yes), c.id)).toBe(true);
      expect(endsWith(bars(...c.before, ...c.near), c.id)).toBe(false);
    });
  }

  it("each match carries its bars, times, direction, trend and a strength from 0 to 1", () => {
    const candles = bars(...DECLINE, [111, 111.2, 109.8, 110], [109.9, 111.6, 109.7, 111.4]);
    const m = findPatterns(candles).find((x) => x.id === "bullish-engulfing")!;
    expect(m).toMatchObject({ name: "Bullish engulfing", bars: [6, 7], times: [candles[6]!.t, candles[7]!.t], direction: "bullish", low: 109.7, high: 111.6 });
    expect(m.trend).toMatchObject({ direction: "decline", bars: CANDLE_CONFIG.trendBars });
    expect(m.strength).toBeGreaterThan(0);
    expect(m.strength).toBeLessThanOrEqual(1);
  });
});

describe("candle formations: the trend a reversal needs", () => {
  const HAMMER: [number, number, number, number] = [110.9, 111.35, 109.5, 111.3];
  const shift = (b: [number, number, number, number], d: number): [number, number, number, number] => [b[0] + d, b[1] + d, b[2] + d, b[3] + d];

  it("a hammer after a decline is a hammer", () => {
    expect(endsWith(bars(...DECLINE, HAMMER), "hammer")).toBe(true);
  });

  it("the same shape after a rise is NOT a hammer (it's a hanging man)", () => {
    const candles = bars(...RISE, shift(HAMMER, 89 - 111.3));
    expect(endsWith(candles, "hammer")).toBe(false);
    expect(endsWith(candles, "hanging-man")).toBe(true);
  });

  it("with no trend before it, the shape isn't called by a reversal name at all", () => {
    const candles = bars(...FLAT, shift(HAMMER, 100.5 - 111.3));
    expect(endsWith(candles, "hammer")).toBe(false);
    expect(endsWith(candles, "hanging-man")).toBe(false);
  });

  it("a bullish engulfing after a rise isn't one", () => {
    expect(endsWith(bars(...RISE, [89.5, 89.7, 88.3, 88.5], [88.4, 90.1, 88.2, 89.9]), "bullish-engulfing")).toBe(false);
  });
});

describe("candle formations: bars left out", () => {
  it("skips zero-range bars", () => {
    expect(endsWith(bars(...FLAT, [100.4, 100.4, 100.4, 100.4]), "doji")).toBe(false);
    expect(lastCandle(bars(...FLAT, [100.4, 100.4, 100.4, 100.4]))!.index).toBe(FLAT.length - 1);
  });

  it("leaves out extended-hours bars when the page shows the regular session only", () => {
    // 15-minute bars from 9:30 New York (13:30 UTC in July), then one at 17:00 New York that would be a doji.
    const open = Date.UTC(2026, 6, 1, 13, 30) / 1000;
    const candles: Candle[] = FLAT.map(([o, h, l, c], i) => ({ t: open + i * 900, open: o, high: h, low: l, close: c }));
    candles.push({ t: Date.UTC(2026, 6, 1, 21, 0) / 1000, open: 100.4, high: 101.2, low: 99.6, close: 100.45 });
    expect(findPatterns(candles).some((m) => m.id === "doji")).toBe(true);
    expect(findPatterns(candles, { regularOnly: true }).some((m) => m.id === "doji")).toBe(false);
  });
});

describe("candle formations: which ones are named", () => {
  it("most recent first, then the strongest, at most three, one per stretch of bars", () => {
    const candles = bars(
      ...DECLINE,
      [111, 111.2, 109.8, 110],
      [109.9, 111.6, 109.7, 111.4], // bullish engulfing
      ...FLAT.map(([o, h, l, c]): [number, number, number, number] => [o + 12, h + 12, l + 12, c + 12]),
      [112.4, 113.2, 111.6, 112.45], // a doji
      [112.3, 112.9, 111.9, 112.6], // an inside bar
    );
    const named = detectPatterns(candles);
    expect(named.length).toBeLessThanOrEqual(CANDLE_CONFIG.maxMatches);
    for (let i = 1; i < named.length; i++) expect(named[i - 1]!.times.at(-1)!).toBeGreaterThanOrEqual(named[i]!.times.at(-1)!);
    expect(named[0]!.times.at(-1)).toBe(candles.at(-1)!.t);
    const spans = named.flatMap((m) => m.times);
    expect(new Set(spans).size).toBe(spans.length);
  });

  it("a harami is named, not the inside bar it also is", () => {
    const named = detectPatterns(bars(...DECLINE, [111.5, 111.7, 109.3, 109.5], [110, 110.8, 109.8, 110.5]));
    expect(named[0]!.id).toBe("bullish-harami");
    expect(named.some((m) => m.id === "inside-bar")).toBe(false);
  });

  it("the strong pattern for Explain this chart is at least 0.6", () => {
    const m = strongPattern(bars(...DECLINE, [112, 112.1, 109.9, 110], [109.7, 109.9, 109.3, 109.6], [109.8, 111.5, 109.7, 111.4]));
    expect(m?.id).toBe("morning-star");
    expect(m!.strength).toBeGreaterThanOrEqual(CANDLE_CONFIG.strongStrength);
  });

  it("describes the last candle: its color, body and shape", () => {
    const last = lastCandle(bars(...DECLINE, [110.9, 111.35, 109.5, 111.3]))!;
    expect(last).toMatchObject({ color: "green", index: 6 });
    expect(last.shape?.id).toBe("hammer");
  });
});

describe("candle questions", () => {
  it.each([
    ["Any candle patterns here?", "patterns"],
    ["What patterns do you see?", "patterns"],
    ["any candlestick patterns on this chart", "patterns"],
    ["What's that last candle?", "last-candle"],
    ["What's today's candle?", "last-candle"],
    ["What’s a hammer?", "explain"],
    ["What's a doji?", "explain"],
    ["what is an inverted hammer", "explain"],
    ["What are three white soldiers?", "explain"],
  ])("%s → %s", (q, kind) => {
    expect(candleIntent(q)?.kind).toBe(kind);
  });

  it("names the pattern asked about", () => {
    expect(candleIntent("What's a hammer?")).toEqual({ kind: "explain", id: "hammer" });
    expect(candleIntent("What's a doji?")).toEqual({ kind: "explain", id: "doji" });
    expect(patternNamed("what's a bearish engulfing")).toBe("bearish-engulfing");
    expect(patternNamed("what's a shooting star")).toBe("shooting-star");
  });

  it.each(["Any candle patterns here?", "What patterns do you see?", "What's that last candle?", "What's today's candle?", "What's a hammer?", "What's a doji?"])(
    "spoken, %s is a question for the page (the ask intent), never a trade or a price",
    (q) => {
      expect(rulesIntent(q, [], {}).intent).toBe("ask");
    },
  );

  it.each(["Explain this chart", "What's Tesla at?", "Where did it bounce this week?", "Show me support"])("%s is not a candle question", (q) => {
    expect(candleIntent(q)).toBeNull();
  });
});

describe("the explainer's wording", () => {
  const BANNED = /\b(will|breakouts?|targets?|buy\w*|sell\w*)\b/i;
  for (const id of Object.keys(EXPLAINERS) as PatternId[]) {
    it(`${PATTERN_NAMES[id]}: two plain sentences, no forecast or trade words, no dashes, the caveat last`, () => {
      const text = explainPattern(id);
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(/[‒-―]/);
      expect(text.endsWith(PATTERN_CAVEAT)).toBe(true);
      expect(EXPLAINERS[id].reads).toMatch(/^Traders often read/);
    });
  }
});

describe("market candles carry the whole candle", () => {
  it("open, high and low come with each close from Yahoo, and pass through to the chart's points", async () => {
    const t = [T0, T0 + DAY, T0 + 2 * DAY];
    const fetchFn = vi.fn(async () =>
      Response.json({ chart: { result: [{ meta: {}, timestamp: t, indicators: { quote: [{ open: [10, 11, null], high: [12, 12.5, 13], low: [9.5, 10.5, 11], close: [11, 12, 12.5] }] } }] } }),
    ) as unknown as typeof fetch;
    const h = await yahooHistory("NVDA", "1M", fetchFn);
    expect(h.points).toEqual([
      { t: t[0], price: 11, open: 10, high: 12, low: 9.5 },
      { t: t[1], price: 12, open: 11, high: 12.5, low: 10.5 },
      { t: t[2], price: 12.5 }, // no open: the close alone
    ]);
    const chart = marketChartData("NVDA", "1M", h, t[2]! + 60);
    expect(chart.points[0]).toMatchObject({ price: 11, open: 10, high: 12, low: 9.5 });
    expect(chart.points[2]).not.toHaveProperty("open");
  });
});
