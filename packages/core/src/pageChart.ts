/**
 * The chart lens: explaining and drawing on a chart on someone else's page (TradingView, Yahoo Finance, Google Finance,
 * CNBC). Every number and every mark comes from Glance's own computed chart facts; the page's chart only gives the
 * position and scale to draw on. This module is the pure part: reading axis labels, fitting the scale, checking it,
 * and working out which stock and range the page shows. (The DOM and screenshot work is in the extension.)
 *
 * Calibration, most reliable first:
 *   DOM labels     axis tick labels that are real text (HTML or SVG <text>): exact positions and values.
 *   vision         the chart box's screenshot, read by the model, which returns ONLY the tick labels it can see
 *                  ([{axis, text, x, y}]); the values are parsed and the scale fitted here, in code.
 * Either way: price is a straight line (least squares, at least 2 labels); time is a straight line when the labels
 * fit one, else piecewise through them (most sites space bars, not hours, so nights and weekends shrink).
 * A calibration is only used when our own high and low land inside the plot and, when it can be checked, our line
 * lands on the page's line; otherwise Glance's own chart is laid over the page's (the lens).
 */
import type { ChartRange } from "./chart.ts";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An axis tick label: its text and its center (and size, when known), in the same coordinates as the chart box. */
export interface AxisLabel {
  axis?: "price" | "time";
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** px = a * value + b, with the fit's root-mean-square error in pixels. */
export interface LineFit {
  a: number;
  b: number;
  rmse: number;
  n: number;
}

export interface TimeMap {
  kind: "linear" | "piecewise";
  /** Labels as (unix time, px), sorted by time. */
  anchors: Array<{ t: number; px: number }>;
  fit: LineFit;
}

export interface Calibration {
  /** How the scale was found: the page's own canvas traced and fitted, its DOM labels, or the vision model's ticks. */
  method: "canvas" | "dom" | "vision";
  price: LineFit;
  time: TimeMap;
  /** The plotting area (chart box minus the axis labels), in the chart box's coordinates. */
  plot: Box;
  /** Which side the price labels are on. */
  priceSide: "left" | "right";
}

// ---------------------------------------------------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------------------------------------------------

/** Least squares px = a * value + b. Null with fewer than 2 distinct values. */
export function fitLine(pairs: ReadonlyArray<readonly [value: number, px: number]>): LineFit | null {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = pairs.reduce((s, [v]) => s + v, 0) / n;
  const my = pairs.reduce((s, [, p]) => s + p, 0) / n;
  const sxx = pairs.reduce((s, [v]) => s + (v - mx) ** 2, 0);
  if (sxx === 0) return null;
  const a = pairs.reduce((s, [v, p]) => s + (v - mx) * (p - my), 0) / sxx;
  const b = my - a * mx;
  const rmse = Math.sqrt(pairs.reduce((s, [v, p]) => s + (a * v + b - p) ** 2, 0) / n);
  return { a, b, rmse, n };
}

export const priceToPx = (f: LineFit, price: number) => f.a * price + f.b;
export const pxToPrice = (f: LineFit, px: number) => (px - f.b) / f.a;

/** A time map fits a line when the labels are within this many px of one; else it goes through them piecewise. */
export const LINEAR_TIME_TOLERANCE = 2;

export function fitTime(points: ReadonlyArray<{ t: number; px: number }>): TimeMap | null {
  const anchors = [...points].sort((a, b) => a.t - b.t).filter((p, i, all) => i === 0 || p.t > all[i - 1]!.t);
  // Time runs left to right: drop anything that doesn't.
  if (anchors.some((p, i) => i > 0 && p.px <= anchors[i - 1]!.px)) return null;
  const fit = fitLine(anchors.map((p) => [p.t, p.px] as const));
  if (!fit || fit.a <= 0) return null;
  const maxErr = Math.max(...anchors.map((p) => Math.abs(fit.a * p.t + fit.b - p.px)));
  return { kind: maxErr <= LINEAR_TIME_TOLERANCE || anchors.length === 2 ? "linear" : "piecewise", anchors, fit };
}

/** Where time t is along the time axis: on the line, or between the two labels around it (the end segments extend). */
export function timeToPx(m: TimeMap, t: number): number {
  if (m.kind === "linear") return m.fit.a * t + m.fit.b;
  const a = m.anchors;
  let i = a.findIndex((p) => p.t >= t);
  if (i <= 0) i = i === 0 ? 1 : a.length - 1;
  const p0 = a[i - 1]!;
  const p1 = a[i]!;
  return p0.px + ((t - p0.t) / (p1.t - p0.t)) * (p1.px - p0.px);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading labels
// ---------------------------------------------------------------------------------------------------------------------

/** "382.50", "$1,234.5", "1.2K", "−3.5": a price, or null. Anything with letters (other than K/M) or a colon isn't. */
export function parsePrice(text: string): number | null {
  const t = text.replace(/[\u2212\u2013]/g, "-").replace(/\s+/g, "").replace(/^\$/, "").replace(/^USD/i, "");
  const m = /^(-?\d{1,3}(?:,\d{3})+|-?\d+)(\.\d+)?([KkMm])?$/.exec(t);
  if (!m) return null;
  const n = Number(`${m[1]!.replace(/,/g, "")}${m[2] ?? ""}`) * (m[3] ? (/k/i.test(m[3]) ? 1e3 : 1e6) : 1);
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * What a time-axis label says: a time of day ("10:00", "2:30 PM", "3 PM"), a date ("Sep 23", "23 Sep", "9/23",
 * "Mon 22", a bare day "25" when `bareDay`), or a month ("Sep"). Null for anything else.
 */
export type TimeLabel = { kind: "tod"; minutes: number } | { kind: "date"; month: number | null; day: number } | { kind: "month"; month: number };

export function parseTimeLabel(text: string, bareDay = true): TimeLabel | null {
  const t = text.replace(/[\u202f\u00a0]/g, " ").trim().toLowerCase();
  let m = /^(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?$/.exec(t) ?? /^(\d{1,2})()\s*([ap])\.?m\.?$/.exec(t);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (m[3]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[3] === "p" ? 12 : 0);
    }
    return h < 24 && min < 60 ? { kind: "tod", minutes: h * 60 + min } : null;
  }
  const month = (s: string) => MONTHS.indexOf(s.slice(0, 3));
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})$/.exec(t);
  if (m && month(m[1]!) >= 0) return { kind: "date", month: month(m[1]!), day: Number(m[2]) };
  m = /^(\d{1,2})\s+([a-z]{3,9})\.?$/.exec(t);
  if (m && month(m[2]!) >= 0) return { kind: "date", month: month(m[2]!), day: Number(m[1]) };
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) return { kind: "date", month: Number(m[1]) - 1, day: Number(m[2]) };
  m = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+(\d{1,2})$/.exec(t);
  if (m) return { kind: "date", month: null, day: Number(m[2]) };
  if (/^[a-z]{3,9}\.?$/.test(t) && month(t) >= 0 && t.length <= 9) return { kind: "month", month: month(t) };
  if (bareDay && /^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 31) return { kind: "date", month: null, day: Number(t) };
  return null;
}

/** Offset of `tz` from UTC at `unix`, in seconds (America/New_York: -14400 in summer). */
export function tzOffset(unix: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(unix * 1000))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) / 1000;
  return asUtc - unix;
}

/** Midnight at the start of the day containing `unix`, in `tz`, and that day's year, month and day. */
function dayOf(unix: number, tz: string): { start: number; y: number; m: number; d: number } {
  const local = unix + tzOffset(unix, tz);
  const date = new Date(local * 1000);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  return { start: zoned(y, m, d, 0, tz), y, m, d };
}

/** Unix time of a wall-clock moment in `tz`. */
export function zoned(y: number, m: number, d: number, minutes: number, tz: string): number {
  const guess = Date.UTC(y, m, d, 0, minutes) / 1000;
  const off = tzOffset(guess, tz);
  const t = guess - off;
  return t - (tzOffset(t, tz) - off); // across a DST change
}

/**
 * Unix times for a row of time labels, read left to right. The rightmost is the latest time not after `asOf`; each
 * label to its left is earlier (a time of day later than the one to its right is the day before); a date label sets
 * the day (midnight). Market time by default (America/New_York). Null for a label that can't be read.
 */
export function datedTimes(labels: ReadonlyArray<{ text: string; x: number }>, asOf: number, tz = "America/New_York"): Array<number | null> {
  const order = labels.map((l, i) => ({ l, i })).sort((a, b) => a.l.x - b.l.x);
  const out: Array<number | null> = labels.map(() => null);
  let next: number | null = null; // the time of the label to the right
  let day = dayOf(asOf, tz);
  for (let k = order.length - 1; k >= 0; k--) {
    const { l, i } = order[k]!;
    const p = parseTimeLabel(l.text);
    if (!p) continue;
    let t: number;
    if (p.kind === "tod") {
      t = day.start + p.minutes * 60;
      if (t + 60 > (next ?? asOf + 60 * 60)) {
        // Later in the day than the label to its right (or than now): the day before.
        day = dayOf(day.start - 3600, tz);
        t = zoned(day.y, day.m, day.d, p.minutes, tz);
      }
    } else if (p.kind === "date") {
      // The latest such date before the label to its right.
      let y = day.y;
      let mo = p.month ?? day.m;
      if (p.month === null && p.day > day.d) mo -= 1;
      if (mo < 0) {
        mo += 12;
        y -= 1;
      }
      if (p.month !== null && (p.month > day.m || (p.month === day.m && p.day > day.d))) y -= 1;
      t = zoned(y, mo, p.day, 0, tz);
      if (next !== null && t >= next) t = zoned(y, mo - 1, p.day, 0, tz);
      day = dayOf(t, tz);
    } else {
      let y = day.y;
      if (p.month > day.m) y -= 1;
      t = zoned(y, p.month, 1, 0, tz);
      day = dayOf(t, tz);
    }
    out[i] = t;
    next = t;
  }
  return out;
}

/**
 * The axes from a chart's labels (from the DOM, or from vision): the price labels are a column (about the same x,
 * different y, values falling as y grows), the time labels a row (about the same y, near the bottom). The plot box
 * is the chart box less the label column and row.
 */
export function calibrate(labels: readonly AxisLabel[], box: Box, method: Calibration["method"], asOf: number, tz = "America/New_York"): { ok: true; calibration: Calibration } | { ok: false; reason: string } {
  const price = priceColumn(labels, box);
  if (!price) return { ok: false, reason: "no price axis: fewer than 2 readable price labels in a column" };
  const priceFit = fitLine(price.map((l) => [parsePrice(l.text)!, l.y] as const));
  if (!priceFit || priceFit.a >= 0) return { ok: false, reason: "the price labels don't run up the chart" };
  if (priceFit.rmse > 3) return { ok: false, reason: `the price labels aren't evenly spaced (${priceFit.rmse.toFixed(1)}px off a line)` };
  const row = timeRow(labels, box, price);
  if (!row) return { ok: false, reason: "no time axis: fewer than 2 readable time labels in a row" };
  const times = datedTimes(row, asOf, tz);
  const anchors = row.flatMap((l, i) => (times[i] === null ? [] : [{ t: times[i]!, px: l.x }]));
  const time = fitTime(anchors);
  if (!time) return { ok: false, reason: "the time labels don't run left to right" };
  const side: Calibration["priceSide"] = average(price.map((l) => l.x)) > box.x + box.width / 2 ? "right" : "left";
  const edge = side === "right" ? Math.min(...price.map((l) => l.x - (l.width ?? 30) / 2)) : Math.max(...price.map((l) => l.x + (l.width ?? 30) / 2));
  const bottom = Math.min(...row.map((l) => l.y - (l.height ?? 12) / 2));
  const plot: Box =
    side === "right"
      ? { x: box.x, y: box.y, width: Math.max(1, edge - 4 - box.x), height: Math.max(1, bottom - 2 - box.y) }
      : { x: edge + 4, y: box.y, width: Math.max(1, box.x + box.width - edge - 4), height: Math.max(1, bottom - 2 - box.y) };
  return { ok: true, calibration: { method, price: priceFit, time, plot, priceSide: side } };
}

const average = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** The best column of price labels: same x within 14px, at least 2 distinct values, price falling as y grows. */
function priceColumn(labels: readonly AxisLabel[], box: Box): AxisLabel[] | null {
  const candidates = labels.filter((l) => l.axis !== "time" && parsePrice(l.text) !== null && !/:/.test(l.text) && inside(l, box, 60));
  const columns: AxisLabel[][] = [];
  for (const l of candidates) {
    const col = columns.find((c) => Math.abs(average(c.map((x) => x.x)) - l.x) < 14 || (c.every((x) => Math.abs((x.x + (x.width ?? 0) / 2) - (l.x + (l.width ?? 0) / 2)) < 6)));
    if (col) col.push(l);
    else columns.push([l]);
  }
  const good = columns
    .map((c) => dedupeBy(c, (l) => Math.round(l.y)))
    .filter((c) => c.length >= 2 && new Set(c.map((l) => parsePrice(l.text))).size === c.length)
    .map((c) => keepMonotone(c))
    .filter((c) => c.length >= 2);
  good.sort((a, b) => b.length - a.length);
  return good[0] ?? null;
}

/** Of a column, the longest run where the price falls as y grows (a badge with the current price breaks the order). */
function keepMonotone(col: AxisLabel[]): AxisLabel[] {
  const sorted = [...col].sort((a, b) => a.y - b.y);
  // Longest decreasing subsequence of prices by y, then prefer evenly spaced values.
  const n = sorted.length;
  const len = Array(n).fill(1);
  const prev = Array(n).fill(-1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (parsePrice(sorted[j]!.text)! > parsePrice(sorted[i]!.text)! && len[j] + 1 > len[i]) {
    len[i] = len[j] + 1;
    prev[i] = j;
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (len[i] > len[best]) best = i;
  const out: AxisLabel[] = [];
  for (let i = best; i >= 0; i = prev[i]) out.unshift(sorted[i]!);
  // A label off the line the others make (a price badge that happens to fit the order) is dropped.
  while (out.length > 2) {
    const fit = fitLine(out.map((l) => [parsePrice(l.text)!, l.y] as const))!;
    const errs = out.map((l) => Math.abs(fit.a * parsePrice(l.text)! + fit.b - l.y));
    const worst = errs.indexOf(Math.max(...errs));
    if (errs[worst]! <= 3) break;
    out.splice(worst, 1);
  }
  return out;
}

function dedupeBy<T>(xs: readonly T[], key: (x: T) => number): T[] {
  const seen = new Set<number>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

const inside = (l: AxisLabel, box: Box, slack: number) => l.x >= box.x - slack && l.x <= box.x + box.width + slack && l.y >= box.y - slack && l.y <= box.y + box.height + slack;

/** The best row of time labels: same y within 6px, below the middle of the chart, at least 2 readable. */
function timeRow(labels: readonly AxisLabel[], box: Box, price: readonly AxisLabel[]): AxisLabel[] | null {
  const priceSet = new Set(price);
  const candidates = labels.filter((l) => l.axis !== "price" && !priceSet.has(l) && parseTimeLabel(l.text) !== null && inside(l, box, 60) && l.y > box.y + box.height / 2);
  const rows: AxisLabel[][] = [];
  for (const l of candidates) {
    const row = rows.find((r) => Math.abs(average(r.map((x) => x.y)) - l.y) < 6);
    if (row) row.push(l);
    else rows.push([l]);
  }
  const good = rows.map((r) => dedupeBy(r, (l) => Math.round(l.x))).filter((r) => r.length >= 2);
  // Prefer rows with times of day or dates (a row of bare numbers could be anything), then the longest.
  good.sort((a, b) => score(b) - score(a));
  return good[0] ?? null;
  function score(r: AxisLabel[]) {
    return r.length + r.filter((l) => parseTimeLabel(l.text, false) !== null).length * 2;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------------------------------------------------

/** What the model is asked for: only the tick labels it can read, where they are, as JSON. */
export const VISION_INSTRUCTIONS = [
  "This image is a crop of a stock price chart. Read ONLY its geometry, never the data:",
  "plot: the plotting area's box (where the price line or candles are drawn, without the axis labels), in pixels;",
  "price: at least 2 price-axis tick labels as {price, y}: the number printed, and the y of the label's center;",
  "time: at least 2 time-axis tick labels as {time, x}: the text printed (\"10:00\", \"Sep 23\"), and the x of its center.",
  "Pixels from the image's top-left corner. Skip price badges in colored boxes (the current or previous price), legends",
  "and titles. Don't estimate any price, time or point on the line itself. No other output.",
].join("\n");

/**
 * The model's labels, checked: a known axis, text of at most 16 characters, positions inside the crop, then moved from
 * the crop's pixels (scaled by `scale`, the crop's downscale) to the chart box's coordinates.
 */
export function parseVisionLabels(raw: unknown, crop: Box, scale = 1): AxisLabel[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { labels?: unknown })?.labels) ? (raw as { labels: unknown[] }).labels : [];
  const out: AxisLabel[] = [];
  for (const item of list) {
    const l = item as { axis?: unknown; text?: unknown; value?: unknown; x?: unknown; y?: unknown };
    const text = typeof l.text === "string" ? l.text : typeof l.value === "string" || typeof l.value === "number" ? String(l.value) : null;
    const x = Number(l.x);
    const y = Number(l.y);
    if (!text || text.length > 16 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || y < 0 || x > crop.width * scale + 2 || y > crop.height * scale + 2) continue;
    const axis = l.axis === "price" || l.axis === "y" ? "price" : l.axis === "time" || l.axis === "x" ? "time" : undefined;
    out.push({ ...(axis ? { axis } : {}), text, x: crop.x + x / scale, y: crop.y + y / scale });
  }
  return out;
}

/** The part of the page a vision calibration looks at: the chart box plus room for labels just outside it. */
export function cropFor(box: Box, viewport: { width: number; height: number }): Box {
  const x = Math.max(0, box.x - 12);
  const y = Math.max(0, box.y - 12);
  const right = Math.min(viewport.width, box.x + box.width + 90);
  const bottom = Math.min(viewport.height, box.y + box.height + 44);
  return { x, y, width: right - x, height: bottom - y };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mapping and the sanity check
// ---------------------------------------------------------------------------------------------------------------------

export function toPage(c: Calibration, t: number, price: number): { x: number; y: number } {
  return { x: timeToPx(c.time, t), y: priceToPx(c.price, price) };
}

export interface SanityInput {
  high: { t: number; price: number };
  low: { t: number; price: number };
  /** Our own points worth checking against the page's line (the latest, the high, the low...). */
  probes: ReadonlyArray<{ t: number; price: number }>;
  /** Where the page's line is at x (the y of each crossing), or null when that can't be checked (no path, no pixels). */
  lineAt?: (x: number) => number[] | null;
}

/**
 * How far our price may sit from the page's line and still count as on it: 0.25% of the price (about $0.95 at $380)
 * and never under 4px. Measured on real pages with correct calibrations, Chainlink's published prices sit within about
 * $0.70 of the exchange's line at the same moment (up to $0.93): sparse rounds against a dense tape.
 */
export const LINE_TOLERANCE_PCT = 0.25;
/** Of our points the page's line can be read at, the share that must be on it. */
export const LINE_AGREEMENT = 0.7;

/**
 * Before drawing on the page's chart: our high and low for the range must land inside its plot, and (when the page's
 * line can be read) most of our points inside its time span must land on it. Otherwise: the lens.
 */
export function sanityCheck(c: Calibration, s: SanityInput): { ok: boolean; reason: string; checkedLine: boolean; agreement?: number } {
  const margin = 6;
  for (const [name, p] of [["high", s.high], ["low", s.low]] as const) {
    const y = priceToPx(c.price, p.price);
    if (y < c.plot.y - margin || y > c.plot.y + c.plot.height + margin) return { ok: false, reason: `our ${name} maps outside the chart's plot (y ${y.toFixed(0)})`, checkedLine: false };
  }
  if (!s.lineAt) return { ok: true, reason: "high and low inside the plot; the page's line can't be read", checkedLine: false };
  let checked = 0;
  let on = 0;
  for (const p of s.probes) {
    const { x, y } = toPage(c, p.t, p.price);
    if (x < c.plot.x || x > c.plot.x + c.plot.width) continue;
    const ys = s.lineAt(x);
    if (!ys || ys.length === 0) continue;
    checked++;
    const tol = Math.max(4, Math.abs(c.price.a) * p.price * (LINE_TOLERANCE_PCT / 100));
    if (ys.some((ly) => Math.abs(ly - y) <= tol)) on++;
  }
  if (checked === 0) return { ok: true, reason: "high and low inside the plot; none of our points falls in the page's time span", checkedLine: false };
  const agreement = on / checked;
  const ok = agreement >= LINE_AGREEMENT;
  return { ok, reason: `${on} of ${checked} of our points on the page's line`, checkedLine: true, agreement };
}

/** Pixel error of a calibration against known labels: mean and max, per axis (for measuring vision against truth). */
export function calibrationError(c: Calibration, truth: { price: ReadonlyArray<readonly [number, number]>; time: ReadonlyArray<readonly [number, number]> }) {
  const pe = truth.price.map(([v, px]) => Math.abs(priceToPx(c.price, v) - px));
  const te = truth.time.map(([t, px]) => Math.abs(timeToPx(c.time, t) - px));
  const stats = (e: number[]) => ({ mean: e.length ? e.reduce((s, x) => s + x, 0) / e.length : 0, max: e.length ? Math.max(...e) : 0 });
  return { price: stats(pe), time: stats(te) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Which stock and which range
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The page's stock, from its URL (/quote/TSLA, /symbols/NASDAQ-TSLA, /quote/TSLA:NASDAQ, /quotes/TSLA), a ticker in
 * a heading ("Tesla, Inc. (TSLA)"), or a lone catalog ticker near the chart. Only catalog symbols count. `confident`
 * when the URL or a heading says so and nothing disagrees.
 */
/** A US ticker as a page writes it: "NVDA", "BRK.B". */
export const US_TICKER = /^[A-Z]{1,5}(?:\.[A-Z])?$/;
/** "NASDAQ:NVDA", "NYSE-KO": an exchange-prefixed ticker, as TradingView and Google Finance write them. */
const EXCHANGE_TICKER = /\b(?:NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|AMEX|ARCA|BATS|CBOE|OTC)[:-]([A-Z]{1,5}(?:\.[A-Z])?)\b/g;

/**
 * Which stock a page's chart shows: the URL (TradingView /symbols/NASDAQ-NVDA/, Yahoo /quote/NVDA, Google
 * /quote/NVDA:NASDAQ, CNBC /quotes/NVDA), the title and headings ("NASDAQ:NVDA", "(TSLA)"), the text near the chart,
 * and the question. Catalog tickers count wherever they appear; with `anyTicker`, any US ticker counts too, but only
 * from the strong signals (the URL, an exchange-prefixed or bracketed ticker), never a bare capitalised word.
 */
export function detectSymbol(
  input: { url: string; headings: readonly string[]; nearChart: readonly string[]; question?: string[] },
  symbols: readonly string[],
  opts: { anyTicker?: boolean } = {},
): { symbol: string | null; confident: boolean; candidates: string[] } {
  const known = new Set(symbols);
  const votes = new Map<string, number>();
  const vote = (s: string | undefined, w: number, strong = false) => {
    if (!s) return;
    const u = s.toUpperCase();
    if (known.has(u) || (strong && opts.anyTicker && US_TICKER.test(s))) votes.set(u, (votes.get(u) ?? 0) + w);
  };
  let path = "";
  try {
    path = decodeURIComponent(new URL(input.url).pathname);
  } catch {
    path = "";
  }
  // Google Finance writes the ticker first ("/quote/NVDA:NASDAQ"); the others put any exchange first ("NASDAQ-NVDA").
  const tickerFirst = /\/quote\/([A-Z]{1,5}(?:\.[A-Z])?):[A-Z]+\b/.exec(path);
  const fromUrl = tickerFirst ?? /\/(?:quote|quotes|symbols|stocks?)\/(?:[A-Z]+[-:])?([A-Za-z.]{1,6})(?:[:/-]|$)/i.exec(path);
  vote(fromUrl?.[1], 5, true);
  for (const h of input.headings) {
    for (const m of h.matchAll(EXCHANGE_TICKER)) vote(m[1], 4, true);
    for (const m of h.matchAll(/\(([A-Z]{1,5}(?:\.[A-Z])?)\)|\b([A-Z]{2,6})\b/g)) vote(m[1] ?? m[2], m[1] ? 4 : 1, Boolean(m[1]));
  }
  for (const t of input.nearChart) for (const m of t.matchAll(/\b([A-Z]{2,6})\b/g)) vote(m[1], 1);
  for (const s of input.question ?? []) vote(s, 6, true);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top) return { symbol: null, confident: false, candidates: [] };
  const runnerUp = ranked[1]?.[1] ?? 0;
  return { symbol: top[0], confident: top[1] >= 4 && top[1] >= runnerUp * 2, candidates: ranked.map(([s]) => s) };
}

/** A range button's words ("1D", "5 days", "6 months", "1 year", "All time") as a chart range. Null for anything else. */
export function rangeFromButton(text: string): ChartRange | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(1 ?d|1 day|today|intraday|day)$/.test(t)) return "1D";
  if (/^(5 ?d|5 days|1 ?w|1 week|week|7 ?d)$/.test(t)) return "1W";
  if (/^(1 ?m|1 month|1 mo|month|30 ?d)$/.test(t)) return "1M";
  if (/^(3 ?m|3 months|3 mo)$/.test(t)) return "3M";
  if (/^(6 ?m|6 months|6 mo)$/.test(t)) return "6M";
  if (/^(ytd|year to date)$/.test(t)) return "YTD";
  if (/^(1 ?y|1 year|12 ?m|12 months|1 yr|year)$/.test(t)) return "1Y";
  if (/^(5 ?y|5 years|5 yr|60 ?m)$/.test(t)) return "5Y";
  if (/^(10 ?y|10 years|10 yr|120 ?m)$/.test(t)) return "10Y";
  if (/^(max|all|all time)$/.test(t)) return "ALL";
  return null;
}

/** The range from the time labels' span, when no button says. */
export function rangeFromSpan(seconds: number): ChartRange {
  const days = seconds / 86_400;
  if (days <= 1.5) return "1D";
  if (days <= 8) return "1W";
  if (days <= 35) return "1M";
  if (days <= 100) return "3M";
  if (days <= 200) return "6M";
  if (days <= 400) return "1Y";
  if (days <= 5.5 * 366) return "5Y";
  if (days <= 11 * 366) return "10Y";
  return "ALL";
}

/** The page's source, when it's one we know (for the "Chainlink's prices can differ" line). */
export function chartSite(host: string): "tradingview" | "yahoo" | "google" | "cnbc" | "other" {
  const h = host.toLowerCase();
  if (h.includes("tradingview.")) return "tradingview";
  if (h.includes("finance.yahoo.") || h.endsWith("yahoo.com")) return "yahoo";
  if (h.includes("google.") && h.includes("finance")) return "google";
  if (h.includes("google.")) return "google";
  if (h.includes("cnbc.")) return "cnbc";
  return "other";
}
