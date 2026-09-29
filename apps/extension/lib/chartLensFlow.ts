/**
 * "Explain this chart", "show me the dip on this chart": Show me on a chart on someone else's page.
 *
 *   1. which chart, which stock, which range (lib/pageChart.ts); unsure: one short question first ("Which chart:
 *      TSLA 5 days?"), never a guess
 *   2. calibrate: the DOM labels, else a screenshot crop read by the vision model (needs activeTab: Option+G); no
 *      screenshot possible: "Press ⌥G once so I can see this chart", and the lens is offered instead. A vision
 *      calibration is kept for 10 minutes per page URL + chart box + range, so asking about the same chart again makes
 *      no new vision call; past the API's daily vision limit (CHART_VISION_DAILY_LIMIT), the lens
 *   3. check: our high and low inside the plot, our line on the page's; failing that, the lens
 *   4. Show me answers from Glance's computed facts, and its chart tags are drawn through the calibration on the page
 *      chart, or on the lens
 */
import type { ChartData, ChartRange } from "@glance/core/chart";
import type { ChartFacts } from "@glance/core/chart-facts";
import { calibrate, parseVisionLabels, sanityCheck, type Calibration } from "@glance/core/page-chart";
import type { ChartAnnotation } from "@glance/core/showme";

import { chartMarkGeometry, priceLookup } from "./chartMarks";
import type { ChartLens } from "./chartLens";
import { cropScreenshot, pickPageChart, pixelLineReader, readDomLabels, svgLineReader, type PageChartTarget } from "./pageChart";
import type { ShowDrawings } from "./showDraw";

export interface LensFlowDeps {
  doc: Document;
  win: Window;
  symbols: readonly string[];
  aliases?: Record<string, string[]>;
  /** The stock the question names, if any. */
  named: string | null;
  capture(): Promise<string | null>;
  /** The labels read, null if they couldn't be, or `limit` (today's vision calls are used up: the lens, saying why). */
  vision(img: { base64: string; width: number; height: number }): Promise<{ labels: unknown } | { limit: string } | null>;
  chart(symbol: string, range: ChartRange): Promise<ChartData | null>;
  facts(symbol: string, range: ChartRange): Promise<ChartFacts | null>;
  drawings(): ShowDrawings | null;
  openLens(target: Element, data: ChartData): ChartLens;
  now?(): number;
  log?(line: string): void;
  /** Crops the screenshot, and reads the page's line from its pixels (lib/pageChart.ts; tests pass their own). */
  crop?: typeof cropScreenshot;
  readLine?: typeof pixelLineReader;
}

export type PageChartSession = {
  kind: "ready";
  symbol: string;
  range: ChartRange;
  site: PageChartTarget["site"];
  /** Where the marks go: on the page's own chart (calibrated), or on the Glance lens laid over it. */
  drawOn: "page" | "lens";
  method: Calibration["method"] | null;
  reason: string;
  /** The user asked for the lens (not a fallback): no "I can't read this chart" line. */
  forced: boolean;
  annotate(a: ChartAnnotation): void;
  lens: ChartLens | null;
};

export type Prepared =
  | { kind: "none" }
  | { kind: "ask"; question: string; symbol: string | null; range: ChartRange }
  | { kind: "no-screenshot"; symbol: string; range: ChartRange }
  | { kind: "unavailable"; message: string }
  | PageChartSession;

/** How long a vision calibration is reused for the same chart (page URL, chart box on the page, range). */
export const CALIBRATION_TTL_MS = 10 * 60_000;
type Box = PageChartTarget["box"];
const calibrations = new Map<string, { at: number; cal: Calibration; lineAt?: (x: number) => number[] | null; box: Box }>();
/** The page URL, the chart's box on the page (not the viewport: scrolling doesn't change it), and the range. */
const calibrationKey = (win: Window, box: Box, range: ChartRange) =>
  [win.location.href, Math.round(box.x + win.scrollX), Math.round(box.y + win.scrollY), Math.round(box.width), Math.round(box.height), range].join("|");
/** For tests. */
export const clearCalibrations = () => calibrations.clear();

export async function preparePageChart(deps: LensFlowDeps, opts: { confirmed?: { symbol: string; range: ChartRange }; forceLens?: boolean } = {}): Promise<Prepared> {
  const log = deps.log ?? (() => {});
  const target = pickPageChart(deps.doc, deps.win, deps.symbols, deps.named, deps.aliases);
  if (!target) return { kind: "none" };
  // The page's own timeframe decides the window (TradingView's "6 months" is 6 months of candles).
  const range: ChartRange = opts.confirmed?.range ?? target.range ?? "1W";
  const symbol = opts.confirmed?.symbol ?? target.symbol;
  if (!opts.confirmed && (target.unsure || !symbol)) return { kind: "ask", question: target.unsure ?? "Which stock is this chart?", symbol, range };
  if (!symbol) return { kind: "none" };

  const [data, facts] = await Promise.all([deps.chart(symbol, range), deps.facts(symbol, range)]);
  if (!data || !facts) return { kind: "unavailable", message: `I don't have ${symbol}'s prices for that range right now.` };
  const lens = (reason: string, forced = false): PageChartSession => {
    const l = deps.openLens(target.el, data);
    return { kind: "ready", symbol, range, site: target.site, drawOn: "lens", method: null, reason, forced, annotate: (a) => l.annotate(a), lens: l };
  };
  if (opts.forceLens) return lens("asked for the lens", true);

  const nowMs = deps.now?.() ?? Date.now();
  const asOf = Math.floor(nowMs / 1000);
  let cal: Calibration | null = null;
  let lineAt: ((x: number) => number[] | null) | undefined;
  /** Where the chart was when it was calibrated (the marks follow it from there). */
  let calibratedAt = target.box;
  const key = calibrationKey(deps.win, target.box, range);
  const kept = calibrations.get(key);
  // a) the DOM's own labels
  const dom = calibrate(readDomLabels(target.el, deps.win), target.box, "dom", asOf);
  if (dom.ok) cal = dom.calibration;
  else if (kept && nowMs - kept.at < CALIBRATION_TTL_MS) {
    // b) this chart was read in the last 10 minutes: no new screenshot or vision call
    ({ cal, lineAt, box: calibratedAt } = kept);
    log(`[glance] chart: calibration reused (${Math.round((nowMs - kept.at) / 1000)}s old)`);
  } else {
    // b) a screenshot, read by the vision model (only the labels; the scale is fitted here)
    const shot = await deps.capture();
    if (!shot) return { kind: "no-screenshot", symbol, range };
    const crop = await (deps.crop ?? cropScreenshot)(shot, target.box, { width: deps.win.innerWidth, height: deps.win.innerHeight, dpr: deps.win.devicePixelRatio || 1 });
    const read = await deps.vision(crop);
    if (!read) return lens("the chart's labels couldn't be read");
    if ("limit" in read) return lens(read.limit);
    const vision = calibrate(parseVisionLabels(read.labels, crop.crop, crop.scale), crop.crop, "vision", asOf);
    if (!vision.ok) return lens(vision.reason);
    cal = vision.calibration;
    lineAt = (deps.readLine ?? pixelLineReader)(crop.pixels, crop.crop, crop.scale);
    for (const [k, v] of calibrations) if (nowMs - v.at >= CALIBRATION_TTL_MS) calibrations.delete(k);
    calibrations.set(key, { at: nowMs, cal, lineAt, box: target.box });
  }
  lineAt ??= svgLineReader(target.el) ?? undefined;

  // c) the check, before anything is drawn
  const probes = data.points.map((p) => ({ t: p.t, price: p.price }));
  const check = sanityCheck(cal, { high: facts.high, low: facts.low, probes, lineAt });
  if (!check.ok) return lens(check.reason);

  const priceAt = priceLookup(
    data.points.map((p) => ({ t: p.t, price: p.price })),
    [facts.first, facts.last, facts.high, facts.low, ...[facts.biggestDrop, facts.biggestRise, facts.maxDrawdown].flatMap((m) => (m ? [m.from, m.to] : []))],
  );
  const anchor = { at: calibratedAt, now: () => (target.el.isConnected ? rectOf(target.el) : null) };
  return {
    kind: "ready",
    symbol,
    range,
    site: target.site,
    drawOn: "page",
    method: cal.method,
    reason: `${cal.time.kind} time axis; ${check.reason}`,
    forced: false,
    annotate: (a) => void deps.drawings()?.drawChart(a.kind, chartMarkGeometry(a, cal!, anchor, priceAt), target.el),
    lens: null,
  };
}

/**
 * The one log line for a chart request: which path was chosen (the page's chart, calibrated from its DOM labels or by
 * vision; Glance's overlay; Glance's own chart) and why.
 */
export function chartPathLine(p: Prepared, question: string): string {
  const q = JSON.stringify(question.slice(0, 60));
  switch (p.kind) {
    case "ready":
      return p.drawOn === "page"
        ? `[glance] chart ${q}: page chart via ${p.method === "dom" ? "DOM labels" : "vision"} (${p.symbol} ${p.range}; ${p.reason})`
        : `[glance] chart ${q}: Glance overlay (${p.symbol} ${p.range}; ${p.reason})`;
    case "ask":
      return `[glance] chart ${q}: asked first (${p.question})`;
    case "no-screenshot":
      return `[glance] chart ${q}: no screenshot yet (${p.symbol} ${p.range}; the page's labels aren't text and the glance key hasn't been pressed)`;
    case "unavailable":
      return `[glance] chart ${q}: no prices (${p.message})`;
    case "none":
      return `[glance] chart ${q}: Glance's own chart (no chart on this page)`;
  }
}

const rectOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
