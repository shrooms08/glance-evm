/**
 * Price charts, shared by the extension and the console: what GET /chart/:symbol returns, the pure helpers that turn it
 * into a line (stepped, never smoothed: Chainlink publishes irregularly, on price moves and on a timer), markers, the
 * change over the range, an SVG sparkline path and the chart's colors. No DOM here: the API imports these types too.
 * The full chart itself is in ./chart-mount.ts.
 */
import { color, themes, type ThemeName } from "@glance/design";

export const CHART_RANGES = ["1D", "1W", "1M"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export const RANGE_SECONDS: Record<ChartRange, number> = { "1D": 86_400, "1W": 7 * 86_400, "1M": 30 * 86_400 };

export const CHART_NOTE = "Updates when Chainlink publishes a new price, not on every trade.";
export const NO_CHART_DATA = "No chart data yet.";
export const MARKET_CLOSED_LABEL = "Market closed";

export interface ChartPoint {
  /** Unix seconds. */
  t: number;
  /** For drawing only; `formatted` is the exact value. */
  price: number;
  formatted: string;
}

export type ChartMarker =
  | { kind: "buy" | "sell"; t: number; amount: string; price: string; txHash: string; explorerUrl: string | null }
  | { kind: "news"; t: number; title: string; url: string; site: string };

export interface ChartData {
  symbol: string;
  range: ChartRange;
  points: ChartPoint[];
  source: { label: string; detail: string; note?: string };
  /** When the source last published (unix seconds), or null with no data. */
  lastUpdated: number | null;
  /** When this answer was made (unix seconds): the line is carried flat from the last price to here. */
  asOf: number;
  marketState: "OPEN" | "CLOSED" | "STALE" | null;
  markers: ChartMarker[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Strictly increasing times (the last value wins on a tie), carried flat to `asOf`. */
export function toLineData(points: readonly ChartPoint[], asOf?: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    const last = out.at(-1);
    if (last && last.time === p.t) last.value = p.price;
    else out.push({ time: p.t, value: p.price });
  }
  const last = out.at(-1);
  if (last && asOf !== undefined && asOf > last.time) out.push({ time: asOf, value: last.value });
  return out;
}

/** The change from the first to the last point: "+$4.20 (+1.12%)", with its direction. Null with under 2 points. */
export function rangeChange(points: readonly ChartPoint[]): { up: boolean; flat: boolean; text: string } | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0]!.price;
  const last = sorted.at(-1)!.price;
  const diff = last - first;
  const pct = first === 0 ? 0 : (diff / first) * 100;
  const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
  const abs = Math.abs(diff).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { up: diff > 0, flat: diff === 0, text: `${sign}$${abs} (${sign}${Math.abs(pct).toFixed(2)}%)` };
}

/**
 * Where each marker sits on the line: the last line time at or before it (the price that stood then), or the first
 * time for a marker before the line starts. Markers outside the line's span are dropped.
 */
export function placeMarkers<M extends { t: number }>(markers: readonly M[], line: ReadonlyArray<{ time: number }>): Array<M & { at: number }> {
  if (line.length === 0) return [];
  const first = line[0]!.time;
  const last = line.at(-1)!.time;
  const out: Array<M & { at: number }> = [];
  for (const m of markers) {
    if (m.t < first || m.t > last) continue;
    let lo = 0;
    let hi = line.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (line[mid]!.time <= m.t) lo = mid;
      else hi = mid - 1;
    }
    out.push({ ...m, at: line[lo]!.time });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A stepped SVG path through the points, filling `width` x `height` (no axes). Empty with under 2 points. */
export function sparklinePath(points: readonly ChartPoint[], width: number, height: number, pad = 2): string {
  const line = toLineData(points);
  if (line.length < 2) return "";
  const t0 = line[0]!.time;
  const t1 = line.at(-1)!.time;
  const values = line.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (width - 2 * pad);
  const y = (v: number) => (hi === lo ? height / 2 : pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad));
  let d = `M${x(line[0]!.time).toFixed(1)},${y(line[0]!.value).toFixed(1)}`;
  for (let i = 1; i < line.length; i++) {
    d += `H${x(line[i]!.time).toFixed(1)}V${y(line[i]!.value).toFixed(1)}`;
  }
  return d;
}

/** "Sep 24, 14:05" in the viewer's own time zone. */
export function localTime(t: number): string {
  return new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------------------------------------------------

export interface ChartColors {
  background: string;
  text: string;
  grid: string;
  line: string;
  fillTop: string;
  fillBottom: string;
  down: string;
  buy: string;
  sell: string;
  news: string;
  closedBand: string;
}

/** Black with the lime line and a soft lime fill on dark; the paper tokens (lime ink) on light. */
export function chartColors(theme: ThemeName): ChartColors {
  const t = themes[theme];
  const dark = theme === "dark";
  const line = dark ? color.lime : t.accentText;
  return {
    background: dark ? color.canvas : t.canvas,
    text: t.mute,
    grid: dark ? color.chartGrid : color.chartGridInk,
    line,
    fillTop: dark ? color.chartFillLime : color.chartFillLimeInk,
    fillBottom: color.chartFillClear,
    down: t.down,
    buy: line,
    sell: t.down,
    news: t.soft,
    closedBand: dark ? color.chartClosed : color.chartClosedInk,
  };
}
