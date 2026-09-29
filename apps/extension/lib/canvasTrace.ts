/**
 * Calibration by tracing the page's own chart: the pixels of the chart's canvases (read with getImageData, the page's
 * canvases aren't tainted for a content script), the price series found in them, and the price scale fitted in code
 * against the real candles for the same stock and range. Pure: pixels in, a calibration (or the reason there isn't
 * one) out. The DOM side (compositing the canvases, devicePixelRatio) is in lib/pageChart.ts.
 *
 *   line      the dominant saturated color (never a gray: gridlines, axis text and the crosshair are gray), one y per
 *             x column (the run nearest the column before, so a dotted last-price line or the area fill below the
 *             line don't pull it off), a horizontal line in the series color (the last-price line) masked out
 *   candles   the up and down colors (a green and a red): each candle's body, its close at the body's top (up) or
 *             bottom (down)
 *   fit       x across the traced span is mapped to the candles by their order (charts space bars evenly, so nights and
 *             weekends take no room), then price = a * y + b by least squares. Accepted only when R^2 >= 0.95 and the
 *             fitted high to low is within 3% of the candles' high to low.
 */
import type { Box, Calibration } from "@glance/core/page-chart";

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, rows top to bottom. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface TracePoint {
  x: number;
  y: number;
}

export interface Trace {
  kind: "line" | "candles";
  /** In the pixels' own coordinates (device px), left to right. */
  points: TracePoint[];
  /** The series color, as #rrggbb (for the log and the debug dots). */
  color: string;
}

export const MIN_R2 = 0.95;
export const MAX_RANGE_ERROR = 0.03;

type RGB = [number, number, number];

const at = (p: Pixels, x: number, y: number): [number, number, number, number] => {
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!, p.data[i + 3]!];
};

/** A colored pixel: opaque enough, and far from gray (gridlines, text, the crosshair, the background). */
function saturated(r: number, g: number, b: number, a: number): boolean {
  if (a < 160) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min >= 70 && max >= 90;
}

const dist = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const hex = (c: RGB) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const hueFamily = (c: RGB): "green" | "red" | "other" => (c[1] > c[0] * 1.15 && c[1] > c[2] * 0.9 ? "green" : c[0] > c[1] * 1.3 && c[0] > c[2] * 1.2 ? "red" : "other");

/** The most common saturated colors (quantized to 16 levels a channel), most common first, with their counts. */
export function dominantColors(p: Pixels, step = 2): Array<{ color: RGB; count: number }> {
  const bins = new Map<number, { sum: RGB; count: number }>();
  for (let y = 0; y < p.height; y += step) {
    for (let x = 0; x < p.width; x += step) {
      const [r, g, b, a] = at(p, x, y);
      if (!saturated(r, g, b, a)) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key) ?? { sum: [0, 0, 0] as RGB, count: 0 };
      bin.sum[0] += r;
      bin.sum[1] += g;
      bin.sum[2] += b;
      bin.count++;
      bins.set(key, bin);
    }
  }
  return [...bins.values()]
    .map((b) => ({ color: [b.sum[0] / b.count, b.sum[1] / b.count, b.sum[2] / b.count] as RGB, count: b.count }))
    .sort((a, b) => b.count - a.count);
}

/** Runs of pixels close to `color` in column x: [top, bottom] (inclusive). */
function runs(p: Pixels, x: number, color: RGB, tolerance: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let y = 0; y <= p.height; y++) {
    let on = false;
    if (y < p.height) {
      const [r, g, b, a] = at(p, x, y);
      on = a >= 160 && dist([r, g, b], color) <= tolerance;
    }
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      out.push([start, y - 1]);
      start = -1;
    }
  }
  return out;
}

/** Rows where the color runs most of the way across: a horizontal line (the last-price line), not the series. */
function horizontalRows(p: Pixels, color: RGB, tolerance: number): Set<number> {
  const rows = new Set<number>();
  for (let y = 0; y < p.height; y++) {
    let n = 0;
    for (let x = 0; x < p.width; x += 2) {
      const [r, g, b, a] = at(p, x, y);
      if (a >= 160 && dist([r, g, b], color) <= tolerance) n++;
    }
    if (n >= (p.width / 2) * 0.35) rows.add(y);
  }
  return rows;
}

/** The series as a line: one y per column, following the line (see the module notes). Null with too little of it. */
export function traceLine(p: Pixels, color: RGB, dpr = 1): Trace | null {
  const tolerance = 90;
  const flat = horizontalRows(p, color, tolerance);
  const thick = 14 * dpr; // taller than this is a badge or a fill, not a line
  const cols: Array<{ x: number; cands: number[] }> = [];
  for (let x = 0; x < p.width; x++) {
    const cands = runs(p, x, color, tolerance)
      .filter(([t, b]) => b - t + 1 <= thick)
      .map(([t, b]) => (t + b) / 2)
      .filter((y) => !flat.has(Math.round(y)) || flat.size === 0);
    if (cands.length) cols.push({ x, cands });
  }
  if (cols.length < Math.max(20, p.width * 0.25)) return null;
  // Start where the line is unambiguous, then follow it both ways, taking the candidate nearest the last y.
  const seed = cols.findIndex((c) => c.cands.length === 1);
  if (seed < 0) return null;
  const ys = new Map<number, number>([[cols[seed]!.x, cols[seed]!.cands[0]!]]);
  const follow = (from: number, to: number, stepDir: 1 | -1) => {
    let last = cols[seed]!.cands[0]!;
    for (let i = from; stepDir > 0 ? i <= to : i >= to; i += stepDir) {
      const c = cols[i]!;
      const y = c.cands.reduce((best, v) => (Math.abs(v - last) < Math.abs(best - last) ? v : best), c.cands[0]!);
      // A jump bigger than a third of the chart between neighbours is a stray mark, not the line.
      if (Math.abs(y - last) > p.height / 3) continue;
      ys.set(c.x, y);
      last = y;
    }
  };
  follow(seed + 1, cols.length - 1, 1);
  follow(seed - 1, 0, -1);
  const points = [...ys.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
  return points.length >= 20 ? { kind: "line", points, color: hex(color) } : null;
}

/** The series as candles: each body's close (top of an up candle, bottom of a down one), left to right. */
export function traceCandles(p: Pixels, up: RGB, down: RGB): Trace | null {
  const tolerance = 80;
  const points: TracePoint[] = [];
  let group: { color: "up" | "down"; x0: number; x1: number; tops: number[]; bottoms: number[] } | null = null;
  const flush = () => {
    if (!group) return;
    const width = group.x1 - group.x0 + 1;
    if (width >= 2) {
      // The body: the median extent over the group's columns (the wick column, taller, is outvoted).
      const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
      const top = med(group.tops);
      const bottom = med(group.bottoms);
      points.push({ x: (group.x0 + group.x1) / 2, y: group.color === "up" ? top : bottom });
    }
    group = null;
  };
  for (let x = 0; x < p.width; x++) {
    const u = runs(p, x, up, tolerance);
    const d = runs(p, x, down, tolerance);
    const which = u.length && (!d.length || u[0]![1] - u[0]![0] >= d[0]![1] - d[0]![0]) ? "up" : d.length ? "down" : null;
    if (!which) {
      flush();
      continue;
    }
    const run = (which === "up" ? u : d).reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    if (group && group.color === which && x === group.x1 + 1) {
      group.x1 = x;
      group.tops.push(run[0]);
      group.bottoms.push(run[1]);
    } else {
      flush();
      group = { color: which, x0: x, x1: x, tops: [run[0]], bottoms: [run[1]] };
    }
  }
  flush();
  return points.length >= 8 ? { kind: "candles", points, color: `${hex(up)}/${hex(down)}` } : null;
}

/**
 * The page chart's series: candles when there are two strong colors, a green and a red, in comparable amounts;
 * otherwise the line in the most common saturated color. Null when nothing chart-like is there.
 */
export function traceSeries(p: Pixels, dpr = 1): Trace | null {
  const colors = dominantColors(p).filter((c) => c.count >= 20);
  if (colors.length === 0) return null;
  const green = colors.find((c) => hueFamily(c.color) === "green");
  const red = colors.find((c) => hueFamily(c.color) === "red");
  if (green && red && Math.min(green.count, red.count) >= Math.max(green.count, red.count) * 0.25 && colors[0] !== undefined && (colors[0] === green || colors[0] === red)) {
    const candles = traceCandles(p, green.color, red.color);
    if (candles) return candles;
  }
  return traceLine(p, colors[0]!.color, dpr);
}

// ---------------------------------------------------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------------------------------------------------

export interface TraceFit {
  ok: boolean;
  r2: number;
  /** |fitted high to low - candles' high to low| / candles' high to low. */
  rangeError: number;
  /** price = a * y + b (y in page px). */
  a: number;
  b: number;
  reason: string;
  calibration?: Calibration;
  /** Each candle's close where the fit puts it (page px): the "Show calibration points" dots. */
  dots?: TracePoint[];
}

/** Least squares price = a * y + b over the pairs, with R^2. */
function regress(pairs: ReadonlyArray<readonly [number, number]>): { a: number; b: number; r2: number; ssRes: number } | null {
  const n = pairs.length;
  if (n < 3) return null;
  const my = pairs.reduce((s, [y]) => s + y, 0) / n;
  const mp = pairs.reduce((s, [, v]) => s + v, 0) / n;
  const syy = pairs.reduce((s, [y]) => s + (y - my) ** 2, 0);
  const spp = pairs.reduce((s, [, v]) => s + (v - mp) ** 2, 0);
  if (syy === 0 || spp === 0) return null;
  const a = pairs.reduce((s, [y, v]) => s + (y - my) * (v - mp), 0) / syy;
  const b = mp - a * my;
  const ssRes = pairs.reduce((s, [y, v]) => s + (v - (a * y + b)) ** 2, 0);
  return { a, b, r2: 1 - ssRes / spp, ssRes };
}

/**
 * Fits the traced series (in page px) to the candles. The page and the candles may not start and end on the same bar
 * (a page's "5 days" can open a few bars earlier), so the alignment is searched: the traced span maps to candle
 * indexes i0..i1 (either end may reach past the candles), coarse then fine, keeping the one with the best R^2 that
 * uses at least 60% of the trace and covers at least 60% of the candles. Then price = a * y + b by least squares, and
 * the gates: R^2 >= 0.95, and the fitted high to low within 3% of the covered candles' high to low. `plot` is the
 * traced pane's box (page px).
 */
export function fitTrace(points: readonly TracePoint[], candles: ReadonlyArray<{ t: number; price: number }>, plot: Box): TraceFit {
  // Charts space x two ways: by bar (TradingView: nights and weekends take no room) or by clock time (Yahoo's day,
  // where quiet pre-market minutes have no bar): both are tried, and the better fit kept.
  return betterFit(fitTraceBy(points, candles, plot, "bar"), fitTraceBy(points, candles, plot, "time"));
}

/** The better of the by-bar and by-time fits. */
export function betterFit(byBar: TraceFit, byTime: TraceFit): TraceFit {
  if (byBar.ok !== byTime.ok) return byBar.ok ? byBar : byTime;
  return byTime.r2 > byBar.r2 ? byTime : byBar;
}

export function fitTraceBy(points: readonly TracePoint[], candles: ReadonlyArray<{ t: number; price: number }>, plot: Box, axis: "bar" | "time"): TraceFit {
  const fail = (reason: string, r2 = 0, rangeError = 1, a = 0, b = 0): TraceFit => ({ ok: false, r2, rangeError, a, b, reason });
  const bars = [...candles].sort((x, y) => x.t - y.t);
  if (points.length < 8 || bars.length < 2) return fail(`too little to fit (${points.length} traced, ${bars.length} candles)`);
  const x0 = points[0]!.x;
  const x1 = points.at(-1)!.x;
  if (x1 - x0 < 20) return fail("the traced line is too short");
  const n = bars.length;
  // Each bar's place along the x axis, in bar units: its order, or its time scaled to the same span.
  const span = bars.at(-1)!.t - bars[0]!.t || 1;
  const us = axis === "bar" ? bars.map((_, i) => i) : bars.map((b) => ((b.t - bars[0]!.t) / span) * (n - 1));
  // The candle price at a fractional place (between two bars: linear).
  const priceAtIndex = (f: number) => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (us[mid]! <= f) lo = mid;
      else hi = mid;
    }
    const w = us[hi]! === us[lo]! ? 0 : (f - us[lo]!) / (us[hi]! - us[lo]!);
    return bars[lo]!.price + (bars[hi]!.price - bars[lo]!.price) * Math.max(0, Math.min(1, w));
  };
  const indexAt = (x: number, i0: number, i1: number) => i0 + ((x - x0) / (x1 - x0)) * (i1 - i0);
  const pairsFor = (pts: readonly TracePoint[], i0: number, i1: number) => {
    const out: Array<readonly [number, number]> = [];
    for (const p of pts) {
      const f = indexAt(p.x, i0, i1);
      if (f >= 0 && f <= n - 1) out.push([p.y, priceAtIndex(f)] as const);
    }
    return out;
  };
  const sample = points.length > 400 ? points.filter((_, i) => i % Math.ceil(points.length / 400) === 0) : points;
  let best: { i0: number; i1: number; r2: number } | null = null;
  const tryAt = (i0: number, i1: number) => {
    if (i1 - i0 < 1) return;
    const covered = (Math.min(n - 1, i1) - Math.max(0, i0)) / (n - 1);
    if (covered < 0.6) return;
    const pairs = pairsFor(sample, i0, i1);
    if (pairs.length < sample.length * 0.6) return;
    const r = regress(pairs);
    if (r && r.a < 0 && (!best || r.r2 > best.r2)) best = { i0, i1, r2: r.r2 };
  };
  const coarse = Math.max(n / 40, 0.25);
  for (let i0 = -0.5 * n; i0 <= 0.5 * n; i0 += coarse) for (let span = 0.5 * n; span <= 2 * n; span += coarse) tryAt(i0, i0 + span);
  if (best) {
    const c: { i0: number; i1: number } = best;
    const fine = coarse / 10;
    for (let d0 = -coarse; d0 <= coarse; d0 += fine) for (let d1 = -coarse; d1 <= coarse; d1 += fine) tryAt(c.i0 + d0, c.i1 + d1);
  }
  if (!best) return fail("no alignment of the trace with the candles");
  const { i0, i1 } = best as { i0: number; i1: number };
  const pairs = pairsFor(points, i0, i1);
  const fit = regress(pairs);
  if (!fit) return fail("the line or the prices are flat");
  const { a, b, r2, ssRes } = fit;
  // The candles actually in view: their high and low are what the page's line should span.
  const first = us.findIndex((u) => u >= i0);
  let last = n - 1;
  while (last > 0 && us[last]! > i1) last--;
  const shown = bars.slice(first, last + 1);
  const used = points.filter((p) => {
    const f = indexAt(p.x, i0, i1);
    return f >= 0 && f <= n - 1;
  });
  const ys = used.map((p) => p.y);
  const xStart = x0 + ((us[first]! - i0) / (i1 - i0)) * (x1 - x0);
  const xEnd = x0 + ((us[last]! - i0) / (i1 - i0)) * (x1 - x0);
  // The candles' high and low over the traced span: the prices each traced column was paired with.
  const high = Math.max(...pairs.map(([, v]) => v));
  const low = Math.min(...pairs.map(([, v]) => v));
  const fitHigh = a * Math.min(...ys) + b;
  const fitLow = a * Math.max(...ys) + b;
  const rangeError = Math.abs(fitHigh - fitLow - (high - low)) / (high - low || 1);
  if (a >= 0) return fail("prices don't rise up the chart", r2, rangeError, a, b);
  if (r2 < MIN_R2) return fail(`R^2 ${r2.toFixed(3)} under ${MIN_R2}`, r2, rangeError, a, b);
  if (rangeError > MAX_RANGE_ERROR) return fail(`fitted range off by ${(rangeError * 100).toFixed(1)}% (over ${MAX_RANGE_ERROR * 100}%)`, r2, rangeError, a, b);
  // px = A * price + B, the calibration's direction.
  const A = 1 / a;
  const B = -b / a;
  const rmse = Math.sqrt(ssRes / pairs.length) * Math.abs(A);
  const xAt = (i: number) => x0 + ((us[i]! - i0) / (i1 - i0)) * (x1 - x0);
  const anchors = shown.map((bar, k) => ({ t: bar.t, px: xAt(first + k) })).filter((p, i, all) => i === 0 || p.t > all[i - 1]!.t);
  const calibration: Calibration = {
    method: "canvas",
    price: { a: A, b: B, rmse, n: pairs.length },
    time: { kind: "piecewise", anchors, fit: { a: (xEnd - xStart) / (shown.at(-1)!.t - shown[0]!.t || 1), b: xStart - ((xEnd - xStart) / (shown.at(-1)!.t - shown[0]!.t || 1)) * shown[0]!.t, rmse: 0, n: anchors.length } },
    plot,
    priceSide: "right",
  };
  return { ok: true, r2, rangeError, a, b, reason: `R^2 ${r2.toFixed(3)}, range off ${(rangeError * 100).toFixed(1)}%, x by ${axis}`, calibration, dots: shown.map((bar, k) => ({ x: xAt(first + k), y: A * bar.price + B })) };
}
