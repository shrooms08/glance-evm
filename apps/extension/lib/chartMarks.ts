/**
 * Chart tags (CHART_POINT, CHART_LEVEL, CHART_RANGE, CHART_TREND) drawn on a chart on someone else's page, through
 * its calibration: every time and price is one of Glance's own facts (the API snaps them there), mapped onto the
 * page's scale. The geometry is worked out from the chart element's box at each frame, so marks follow scroll and
 * resize (and scale with the element if it changes size). A mark outside the plot is skipped, never guessed.
 */
import { priceToPx, timeToPx, type Box, type Calibration } from "@glance/core/page-chart";
import { circlePath, highlightPath, seedOf, underlinePath } from "@glance/core/sketch";
import type { ChartAnnotation } from "@glance/core/showme";

import type { Geometry } from "./showDraw";

/** The chart's box when it was calibrated, and a way to read its box now. */
export interface Anchor {
  at: Box;
  now(): Box | null;
}

/** A point in calibration coordinates, placed on the chart's box as it is now. */
function placer(anchor: Anchor) {
  const now = anchor.now();
  if (!now || now.width === 0) return null;
  const sx = now.width / anchor.at.width;
  const sy = now.height / anchor.at.height;
  return (x: number, y: number) => ({ x: now.x + (x - anchor.at.x) * sx, y: now.y + (y - anchor.at.y) * sy });
}

const f = (n: number) => n.toFixed(1);

export function chartMarkGeometry(a: ChartAnnotation, c: Calibration, anchor: Anchor, priceAt: (t: number) => number | null): Geometry {
  const seed = seedOf(`${a.kind}:${JSON.stringify(a)}`);
  const inPlot = (x: number, y?: number) => x >= c.plot.x - 2 && x <= c.plot.x + c.plot.width + 2 && (y === undefined || (y >= c.plot.y - 2 && y <= c.plot.y + c.plot.height + 2));
  return () => {
    const place = placer(anchor);
    if (!place) return null;
    switch (a.kind) {
      case "CHART_POINT": {
        const price = priceAt(a.t);
        if (price === null) return null;
        const x = timeToPx(c.time, a.t);
        const y = priceToPx(c.price, price);
        if (!inPlot(x, y)) return null;
        const p = place(x, y);
        return { strokes: [circlePath({ x: p.x - 7, y: p.y - 7, width: 14, height: 14 }, seed, 5)] };
      }
      case "CHART_LEVEL": {
        const y = priceToPx(c.price, a.price);
        if (!inPlot(c.plot.x, y)) return null;
        const left = place(c.plot.x, y);
        const right = place(c.plot.x + c.plot.width, y);
        return { strokes: [underlinePath({ x: left.x + 4, y: left.y - 3, width: right.x - left.x - 8, height: 0 }, seed)], label: { text: a.label, x: right.x - 6, y: left.y - 7 } };
      }
      case "CHART_RANGE": {
        const x1 = Math.max(c.plot.x, timeToPx(c.time, a.t1));
        const x2 = Math.min(c.plot.x + c.plot.width, timeToPx(c.time, a.t2));
        if (x2 <= x1) return null;
        const p1 = place(x1, c.plot.y);
        const p2 = place(x2, c.plot.y + c.plot.height);
        return { strokes: [], fill: highlightPath([{ x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y }], seed) };
      }
      case "CHART_TREND": {
        const pr1 = priceAt(a.t1);
        const pr2 = priceAt(a.t2);
        if (pr1 === null || pr2 === null) return null;
        const x1 = timeToPx(c.time, a.t1);
        const x2 = timeToPx(c.time, a.t2);
        if (!inPlot(x1) || !inPlot(x2)) return null;
        const p1 = place(x1, priceToPx(c.price, pr1));
        const p2 = place(x2, priceToPx(c.price, pr2));
        // A pen stroke: bowed a hair, like a ruler-less line.
        const mx = (p1.x + p2.x) / 2 + ((seed % 7) - 3) * 0.6;
        const my = (p1.y + p2.y) / 2 + ((seed % 5) - 2) * 0.8;
        return { strokes: [`M${f(p1.x)},${f(p1.y)} Q${f(mx)},${f(my)} ${f(p2.x)},${f(p2.y)}`] };
      }
    }
  };
}

/** The price at a fact's time: the exact fact when there is one, else the last published price at or before it. */
export function priceLookup(points: ReadonlyArray<{ t: number; price: number }>, exact: ReadonlyArray<{ t: number; price: number }> = []): (t: number) => number | null {
  const known = new Map(exact.map((p) => [p.t, p.price]));
  const sorted = [...points].sort((a, b) => a.t - b.t);
  return (t) => {
    if (known.has(t)) return known.get(t)!;
    let best: number | null = null;
    for (const p of sorted) if (p.t <= t) best = p.price;
    return best ?? sorted[0]?.price ?? null;
  };
}
