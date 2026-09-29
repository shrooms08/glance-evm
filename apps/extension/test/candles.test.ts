/**
 * Candle questions on the page's chart (lib/candleAnswer.ts) and their marks (lib/chartLayer.ts): the sentences are
 * written in code from the detector and the explainer, each formation's sentence carries its box, the box is lime,
 * soft red or gray by direction, and nothing said forecasts or advises.
 */
import { describe, expect, it } from "vitest";

import { color } from "@glance/design";
import type { Calibration } from "@glance/core/page-chart";
import type { ChartPoint } from "@glance/core/chart";
import { PATTERN_CAVEAT } from "@glance/core/candles";
import { candleAnswer, explainerAnswer, explainsChart, NO_CANDLES, NO_PATTERNS, strongPatternSentence, SWITCH_TO_CANDLES, toCandles, type PatternMark } from "../lib/candleAnswer";
import { ChartLayer, markShapes, PATTERN_COLOR } from "../lib/chartLayer";

const DAY = 86_400;
const T0 = Date.UTC(2026, 6, 1, 20) / 1000;

function points(...ohlc: Array<[number, number, number, number]>): ChartPoint[] {
  return ohlc.map(([open, high, low, close], i) => ({ t: T0 + i * DAY, price: close, formatted: `$${close.toFixed(2)}`, open, high, low }));
}

const DECLINE: Array<[number, number, number, number]> = Array.from({ length: 6 }, (_, k) => {
  const o = 120 - 1.5 * k;
  return [o, o + 0.3, o - 1.8, o - 1.5];
});
const ENGULFING: Array<[number, number, number, number]> = [
  [111, 111.2, 109.8, 110],
  [109.9, 111.6, 109.7, 111.4],
];
const MORNING_STAR: Array<[number, number, number, number]> = [
  [112, 112.1, 109.9, 110],
  [109.7, 109.9, 109.3, 109.6],
  [109.8, 111.5, 109.7, 111.4],
];

/** Every sentence Glance would say, for the wording checks. */
const BANNED = /\b(will|breakouts?|targets?|buy\w*|sell\w*)\b/i;

describe("candle answers, written in code", () => {
  it("'Any candle patterns here?': each formation in its own sentence with its box, then the caveat", () => {
    const s = candleAnswer({ kind: "patterns" }, { points: points(...DECLINE, ...ENGULFING), series: "candles", prepost: false });
    expect(s[0]!.text).toBe("I see one candle pattern here.");
    expect(s[1]!.text).toMatch(/^A bullish engulfing on July 8, which traders often read as the bulls taking over from the bears\.$/);
    expect(s[1]!.mark).toMatchObject({ kind: "PATTERN", t1: T0 + 6 * DAY, t2: T0 + 7 * DAY, before: T0 + 5 * DAY, after: null, low: 109.7, high: 111.6, label: "Bullish engulfing", direction: "bullish" });
    expect(s.at(-1)!.text).toBe(PATTERN_CAVEAT);
    expect(s.filter((x) => x.mark)).toHaveLength(1);
  });

  it("at most three formations are named and marked", () => {
    const s = candleAnswer({ kind: "patterns" }, { points: points(...DECLINE, ...MORNING_STAR, ...DECLINE.map(([o, h, l, c]): [number, number, number, number] => [o - 1, h - 1, l - 1, c - 1]), ...ENGULFING), series: "candles", prepost: false });
    expect(s.filter((x) => x.mark).length).toBeLessThanOrEqual(3);
  });

  it("on a line chart it says once to switch to candles", () => {
    const chart = { points: points(...DECLINE, ...ENGULFING), series: "line" as const, prepost: false };
    expect(candleAnswer({ kind: "patterns" }, chart)[0]!.text).toBe(SWITCH_TO_CANDLES);
    expect(candleAnswer({ kind: "patterns" }, chart, true).map((x) => x.text)).not.toContain(SWITCH_TO_CANDLES);
  });

  it("no formation: says so; no candles (closes only): says it can't read them", () => {
    const flat: Array<[number, number, number, number]> = Array.from({ length: 8 }, (_, k) => (k % 2 === 0 ? [100, 101.2, 99.6, 100.8] : [100.8, 101.2, 99.6, 100]));
    expect(candleAnswer({ kind: "patterns" }, { points: points(...flat), series: "candles", prepost: false }).map((x) => x.text)).toEqual([NO_PATTERNS]);
    const closesOnly = points(...DECLINE).map(({ t, price, formatted }) => ({ t, price, formatted }));
    expect(toCandles(closesOnly)).toEqual([]);
    expect(candleAnswer({ kind: "patterns" }, { points: closesOnly, series: "candles", prepost: false })).toEqual([{ text: NO_CANDLES }]);
  });

  it("'What's that last candle?': its color, open, close and range, the shape it makes, and its box", () => {
    const s = candleAnswer({ kind: "last-candle" }, { points: points(...DECLINE, [110.9, 111.35, 109.5, 111.3]), series: "candles", prepost: false });
    expect(s[0]!.text).toBe("The last candle, on July 7, is green: it opened at $110.90, closed at $111.30, and traded between $109.50 and $111.35.");
    expect(s[0]!.mark).toMatchObject({ t1: T0 + 6 * DAY, t2: T0 + 6 * DAY, label: "Hammer", direction: "bullish" });
    expect(s[1]!.text).toMatch(/^It has the shape of a hammer, which traders often read as/);
    expect(s.at(-1)!.text).toBe(PATTERN_CAVEAT);
  });

  it("'What's a hammer?': the explainer entry, no marks", () => {
    const s = explainerAnswer("hammer");
    expect(s.map((x) => x.text)).toEqual([
      "A hammer has a small body near the top of the candle and a long lower shadow, at least twice the body, after a decline.",
      "Traders often read it as prices being pushed down and then bid back up, a sign the decline may be tiring.",
      PATTERN_CAVEAT,
    ]);
    expect(s.some((x) => x.mark)).toBe(false);
  });

  it("'Explain this chart' gets one more sentence on the most recent strong formation (strength 0.6 or more)", () => {
    const s = strongPatternSentence({ points: points(...DECLINE, ...MORNING_STAR), series: "candles", prepost: false })!;
    expect(s.text).toMatch(/^The most recent clear candle pattern is a morning star on July 9, which traders often read as .*, a hint, not a guarantee\.$/);
    expect(s.mark?.label).toBe("Morning star");
    expect(explainsChart("Explain this chart")).toBe(true);
    expect(explainsChart("walk me through this chart")).toBe(true);
    expect(explainsChart("Where did it bounce this week?")).toBe(false);
  });

  it("nothing it says forecasts, advises or uses a dash", () => {
    const all = [
      ...candleAnswer({ kind: "patterns" }, { points: points(...DECLINE, ...ENGULFING), series: "line", prepost: false }),
      ...candleAnswer({ kind: "last-candle" }, { points: points(...DECLINE, [110.9, 111.35, 109.5, 111.3]), series: "candles", prepost: false }),
      strongPatternSentence({ points: points(...DECLINE, ...MORNING_STAR), series: "candles", prepost: false })!,
      ...explainerAnswer("shooting-star"),
    ].map((x) => x.text);
    for (const text of all) {
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(/[‒-―]/);
    }
  });
});

describe("a formation's box on the page's chart", () => {
  // price px = -2 * price + 900; time px = 0.5 * t - 500 (page px); the box at (100, 200).
  const cal = { method: "canvas", price: { a: -2, b: 900, rmse: 0, n: 2 }, time: { kind: "linear", anchors: [], fit: { a: 0.5, b: -500, rmse: 0, n: 2 } }, plot: { x: 100, y: 200, width: 600, height: 240 }, priceSide: "right" } as Calibration;
  const at = { x: 100, y: 200, width: 600, height: 240 };
  const mark: PatternMark = { kind: "PATTERN", t1: 1600, t2: 1640, before: 1560, after: 1680, low: 295, high: 305, label: "Bullish engulfing", direction: "bullish" };

  it("a box across its bars (half way to the candles either side) from their low to their high, with its name above", () => {
    expect(markShapes(mark, cal, at, () => null, () => [])).toEqual([
      {
        kind: "polygon",
        points: [
          [190, 87],
          [230, 87],
          [230, 113],
          [190, 113],
        ],
      },
      { kind: "text", x: 210, y: 81, text: "Bullish engulfing", anchor: "middle" },
    ]);
  });

  it("outside the plot: skipped, never guessed", () => {
    expect(markShapes({ ...mark, t1: 99_000, t2: 99_040 }, cal, at, () => null, () => [])).toBeNull();
  });

  it("lime when bullish, the soft red when bearish, gray when neutral, each with the dark outline", async () => {
    expect(PATTERN_COLOR).toEqual({ bullish: color.lime, bearish: color.down, neutral: color.mute });
    const target = document.createElement("div");
    document.body.append(target);
    const host = document.createElement("div");
    document.body.append(host);
    const layer = new ChartLayer(host, target, cal, at, () => null, () => [], { now: () => Date.now() });
    layer.add(mark);
    layer.add({ ...mark, direction: "bearish", label: "Evening star" });
    layer.add({ ...mark, direction: "neutral", label: "Doji" });
    await new Promise((r) => setTimeout(r, 900));
    const groups = [...layer.root.querySelectorAll("g[data-mark=pattern]")];
    expect(groups.map((g) => g.getAttribute("data-direction"))).toEqual(["bullish", "bearish", "neutral"]);
    for (const [g, c] of groups.map((g, i) => [g, [color.lime, color.down, color.mute][i]!] as const)) {
      const polys = g.querySelectorAll("polygon");
      expect(polys[0]!.getAttribute("stroke")).toBe(color.canvas); // the dark outline under it
      expect(polys[1]!.getAttribute("stroke")).toBe(c);
      expect(g.querySelector("text")!.getAttribute("fill")).toBe(c);
    }
    // Side by side, each name clears the one before it.
    const ys = groups.map((g) => Number(g.querySelector("text")!.getAttribute("y")));
    expect(new Set(ys).size).toBe(3);
    layer.close();
  });
});
