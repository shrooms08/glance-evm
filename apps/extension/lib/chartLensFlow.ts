/**
 * "Explain this chart", "where did it bounce", "show me support" on a chart on someone else's page: Glance marks the
 * page's OWN chart, which stays visible underneath. Never Glance's own chart for these (that only comes when asked
 * for, lib/ownChart.ts).
 *
 *   1. which chart, which stock, which range (lib/pageChart.ts); unsure: one short question first
 *   2. calibrate, the first that passes wins:
 *        A. canvas   the chart's own canvases traced (lib/canvasTrace.ts), fitted to the market's candles for the same
 *                    stock and range: R^2 >= 0.95, the fitted high to low within 3% of the candles'
 *        B. DOM      axis labels that are real text, checked (our high and low inside the plot, our line on the page's)
 *        C. vision   a screenshot crop, the model reading ONLY the plot box and the axis ticks (price at y, time at x);
 *                    the scale fitted and validated here (the same 3% rule); counts toward CHART_VISION_DAILY_LIMIT.
 *                    A vision calibration is kept for 10 minutes per page URL + chart box + range.
 *        D. none     nothing is drawn: "I can't line up marks on this chart. Want me to pull up my own?" (rule 3)
 *   3. the marks go on an SVG layer pinned to the chart (lib/chartLayer.ts), from Glance's computed facts
 */
import { during, yieldToPage } from "./workLabel";
import type { ChartData, ChartRange } from "@glance/core/chart";
import type { ChartFacts } from "@glance/core/chart-facts";
import { calibrate, parseVisionLabels, priceToPx, sanityCheck, type AxisLabel, type Box, type Calibration } from "@glance/core/page-chart";
import type { ChartAnnotation } from "@glance/core/showme";

import { betterFit, fitTraceBy, MAX_RANGE_ERROR, traceSeries, type TraceFit } from "./canvasTrace";
import { priceLookup } from "./chartMarks";
import { cropScreenshot, pickPageChart, pixelLineReader, readChartPixels, readDomLabels, svgLineReader, type ChartPixels, type PageChartTarget } from "./pageChart";

/** What the layer needs (lib/chartLayer.ts's ChartLayer; tests pass a fake). */
export interface MarkLayer {
  add(a: ChartAnnotation): void;
  close(): void;
  readonly drawn: number;
  readonly isOpen: boolean;
}

export interface LensFlowDeps {
  doc: Document;
  win: Window;
  symbols: readonly string[];
  aliases?: Record<string, string[]>;
  /** The stock the question names, if any. */
  named: string | null;
  capture(): Promise<string | null>;
  /** The vision model's reading: the plot box and ticks, null if it couldn't, or `limit` (today's readings used up). */
  vision(img: { base64: string; width: number; height: number }): Promise<{ labels: unknown } | { limit: string } | null>;
  /**
   * The facts of the page's chart: computed from the same market candles the page draws (the set the canvas fit
   * matched), so the answer and its marks describe the page's chart, not Glance's own.
   */
  facts(symbol: string, range: ChartRange, candles: CandleSet): Promise<ChartFacts | null>;
  /**
   * The market's own candles for the same stock and range, what the page's chart draws (the canvas fit): `fine` a
   * finer step (a page's 1 day chart may draw every minute), `prepost` with the pre- and after-market (a page showing
   * the pre-market before the open).
   */
  marketCandles(symbol: string, range: ChartRange, opts?: { fine?: boolean; prepost?: boolean }): Promise<ChartData | null>;
  openLayer(target: Element, cal: Calibration, at: Box, priceAt: (t: number) => number | null, pricesBetween: (t1: number, t2: number) => number[], dots: ReadonlyArray<{ x: number; y: number }> | null, range: ChartRange): MarkLayer;
  /** "Show calibration points" (Settings, Developer). */
  showDots?(): Promise<boolean>;
  now?(): number;
  log?(line: string): void;
  /** The chart's pixels (lib/pageChart.ts readChartPixels; tests pass their own). */
  readPixels?(el: Element, win: Window): ChartPixels | { error: string };
  crop?: typeof cropScreenshot;
  readLine?: typeof pixelLineReader;
}

/** Which market candles: the default step, a finer one, and with the pre- and after-market. */
export type CandleSet = { fine?: boolean; prepost?: boolean };

export type PageChartSession = {
  kind: "ready";
  symbol: string;
  range: ChartRange;
  site: PageChartTarget["site"];
  /** Always the page's own chart. */
  drawOn: "page";
  method: Calibration["method"];
  reason: string;
  /** The canvas fit's R^2 (null for DOM labels and vision). */
  r2: number | null;
  forced: false;
  annotate(a: ChartAnnotation): void;
  /** How many marks the answer asked for (they appear at most every 400ms, so fewer may be drawn yet). */
  readonly annotated: number;
  /** The chart's computed facts: the default marks when an answer mentions none. */
  facts: ChartFacts;
  /** The candle set the page's chart matched (the API computes the answer's facts from the same). */
  candles: CandleSet;
  layer: MarkLayer;
  /** The chart's box on the page, when calibrated (Glance's own chart never goes over it). */
  box: Box;
};

export type Prepared =
  | { kind: "none" }
  | { kind: "ask"; question: string; symbol: string | null; range: ChartRange }
  /** Rule 3: no method could line up marks. Nothing is drawn; the user is asked whether to pull up Glance's own. */
  | { kind: "cant-calibrate"; symbol: string; range: ChartRange; site: PageChartTarget["site"]; reasons: string[]; box: Box }
  | { kind: "unavailable"; message: string }
  | PageChartSession;

/** How long a vision calibration is reused for the same chart (page URL, chart box on the page, range). */
export const CALIBRATION_TTL_MS = 10 * 60_000;
const calibrations = new Map<string, { at: number; cal: Calibration; box: Box }>();
const calibrationKey = (win: Window, box: Box, range: ChartRange) =>
  [win.location.href, Math.round(box.x + win.scrollX), Math.round(box.y + win.scrollY), Math.round(box.width), Math.round(box.height), range].join("|");
/** For tests. */
export const clearCalibrations = () => calibrations.clear();

/**
 * The vision model's structured reading, as axis labels in the crop's pixels: { plot, price: [{price, y}], time:
 * [{time, x}] } (the model never places a mark; the scale is fitted here). An older list of labels passes through.
 */
export function visionLabels(raw: unknown): unknown {
  const r = raw as { plot?: { x?: number; width?: number; y?: number; height?: number }; price?: Array<{ price?: unknown; y?: unknown }>; time?: Array<{ time?: unknown; x?: unknown }> } | null;
  if (!r || (!Array.isArray(r.price) && !Array.isArray(r.time))) return raw;
  const plot = r.plot ?? {};
  const right = Number(plot.x ?? 0) + Number(plot.width ?? 0);
  const bottom = Number(plot.y ?? 0) + Number(plot.height ?? 0);
  return [
    ...(r.price ?? []).map((p) => ({ axis: "price", text: String(p.price), x: right + 20, y: Number(p.y) })),
    ...(r.time ?? []).map((t) => ({ axis: "time", text: String(t.time), x: Number(t.x), y: bottom + 12 })),
  ];
}

/** The 3% rule for a scale read from labels: the candles' high and low must land inside the plot, give or take 3%. */
export function validateScale(cal: Calibration, high: number, low: number): { ok: boolean; reason: string } {
  const top = cal.plot.y;
  const bottom = cal.plot.y + cal.plot.height;
  const slack = cal.plot.height * MAX_RANGE_ERROR;
  const yHigh = priceToPx(cal.price, high);
  const yLow = priceToPx(cal.price, low);
  if (yHigh >= yLow) return { ok: false, reason: "the scale runs the wrong way" };
  if (yHigh < top - slack || yLow > bottom + slack) return { ok: false, reason: "the candles' high and low fall outside the plot (over 3%)" };
  return { ok: true, reason: "the candles' high and low sit inside the plot" };
}

export async function preparePageChart(deps: LensFlowDeps, opts: { confirmed?: { symbol: string; range: ChartRange } } = {}): Promise<Prepared> {
  const log = deps.log ?? (() => {});
  const target = pickPageChart(deps.doc, deps.win, deps.symbols, deps.named, deps.aliases);
  if (!target) return { kind: "none" };
  // The page's own timeframe decides the window (TradingView's "6 months" is 6 months of candles).
  const range: ChartRange = opts.confirmed?.range ?? target.range ?? "1W";
  const symbol = opts.confirmed?.symbol ?? target.symbol;
  if (!opts.confirmed && (target.unsure || !symbol)) return { kind: "ask", question: target.unsure ?? "Which stock is this chart?", symbol, range };
  if (!symbol) return { kind: "none" };

  const short = range === "1D" || range === "1W";
  const options: CandleSet[] = [{}, { fine: true }, ...(short ? [{ fine: true, prepost: true }] : [])];
  const sets = (await Promise.all(options.map((o) => deps.marketCandles(symbol, range, o).then((data) => ({ opts: o, data })))))
    .filter((x): x is { opts: CandleSet; data: ChartData } => x.data !== null && x.data.points.length > 1);
  if (sets.length === 0) return { kind: "unavailable", message: `I don't have ${symbol}'s prices for that range right now.` };
  let chosen = sets[0]!;
  const candles = chosen.data.points.map((p) => ({ t: p.t, price: p.price }));
  const high = Math.max(...candles.map((c) => c.price));
  const low = Math.min(...candles.map((c) => c.price));
  const reasons: string[] = [];
  let cal: Calibration | null = null;
  let r2: number | null = null;
  let why = "";
  let dots: Array<{ x: number; y: number }> | null = null;

  // A. The chart's own canvas, traced and fitted.
  // In slices, handing the page back between them (reading, tracing, each fit), so no long task holds the page.
  const px = during("canvas trace", () => (deps.readPixels ?? readChartPixels)(target.el, deps.win));
  if ("error" in px) reasons.push(`canvas: ${px.error}`);
  else {
    await yieldToPage();
    const trace = during("canvas trace", () => traceSeries(px.pixels, px.dpr));
    if (!trace) reasons.push("canvas: no series found in the chart's pixels");
    else {
      const points = trace.points.map((p) => ({ x: px.pane.x + p.x / px.dpr, y: px.pane.y + p.y / px.dpr }));
      // The page may draw at its own step, and with or without the pre- and after-market: fit each candle set we
      // have, keep the best one that passes.
      const fits: Array<{ set: (typeof sets)[number]; fit: TraceFit }> = [];
      for (const set of sets) {
        const candles = set.data.points.map((p) => ({ t: p.t, price: p.price }));
        await yieldToPage();
        const byBar = during("canvas trace", () => fitTraceBy(points, candles, px.pane, "bar"));
        await yieldToPage();
        const byTime = during("canvas trace", () => fitTraceBy(points, candles, px.pane, "time"));
        fits.push({ set, fit: betterFit(byBar, byTime) });
      }
      const best = fits.filter((f) => f.fit.ok).sort((a, b) => b.fit.r2 - a.fit.r2)[0] ?? fits.sort((a, b) => b.fit.r2 - a.fit.r2)[0]!;
      const fit = best.fit;
      if (fit.ok && fit.calibration) {
        chosen = best.set;
        cal = fit.calibration;
        r2 = fit.r2;
        why = `${trace.kind} ${trace.color}, ${fit.reason}`;
        dots = fit.dots ?? null;
      } else reasons.push(`canvas: ${fit.reason}`);
    }
  }

  // The facts, from the candles the page's chart matched (or the default set).
  const data = chosen.data;
  const facts = await deps.facts(symbol, range, chosen.opts);
  if (!facts) return { kind: "unavailable", message: `I don't have ${symbol}'s prices for that range right now.` };

  // B. The DOM's own labels, checked against our line.
  if (!cal) {
    const dom = calibrate(readDomLabels(target.el, deps.win), target.box, "dom", Math.floor((deps.now?.() ?? Date.now()) / 1000));
    if (dom.ok) {
      const check = sanityCheck(dom.calibration, { high: facts.high, low: facts.low, probes: data.points.map((p) => ({ t: p.t, price: p.price })), lineAt: svgLineReader(target.el) ?? undefined });
      const scale = validateScale(dom.calibration, high, low);
      if (check.ok && scale.ok) {
        cal = dom.calibration;
        why = `${cal.time.kind} time axis; ${check.reason}`;
      } else reasons.push(`dom: ${check.ok ? scale.reason : check.reason}`);
    } else reasons.push(`dom: ${dom.reason}`);
  }

  // C. Vision: the plot box and the ticks, read from a screenshot; validated here.
  if (!cal) {
    const nowMs = deps.now?.() ?? Date.now();
    const key = calibrationKey(deps.win, target.box, range);
    const kept = calibrations.get(key);
    if (kept && nowMs - kept.at < CALIBRATION_TTL_MS) {
      cal = kept.cal;
      why = `vision, reused (${Math.round((nowMs - kept.at) / 1000)}s old)`;
    } else {
      const shot = await deps.capture();
      if (!shot) reasons.push("vision: no screenshot (the glance key hasn't been pressed on this page)");
      else {
        const crop = await (deps.crop ?? cropScreenshot)(shot, target.box, { width: deps.win.innerWidth, height: deps.win.innerHeight, dpr: deps.win.devicePixelRatio || 1 });
        const read = await during("vision", () => deps.vision(crop));
        if (!read) reasons.push("vision: the model couldn't read the axes");
        else if ("limit" in read) reasons.push(`vision: ${read.limit}`);
        else {
          const labels: AxisLabel[] = parseVisionLabels(visionLabels(read.labels), crop.crop, crop.scale);
          const vision = calibrate(labels, crop.crop, "vision", Math.floor(nowMs / 1000));
          if (!vision.ok) reasons.push(`vision: ${vision.reason}`);
          else {
            // Two checks: the candles' high and low inside the plot (3%), and our line on the page's (its pixels).
            const scale = validateScale(vision.calibration, high, low);
            const lineAt = (deps.readLine ?? pixelLineReader)(crop.pixels, crop.crop, crop.scale);
            const check = sanityCheck(vision.calibration, { high: facts.high, low: facts.low, probes: data.points.map((p) => ({ t: p.t, price: p.price })), lineAt });
            if (!scale.ok || !check.ok) reasons.push(`vision: ${!scale.ok ? scale.reason : check.reason}`);
            else {
              cal = vision.calibration;
              why = scale.reason;
              for (const [k, v] of calibrations) if (nowMs - v.at >= CALIBRATION_TTL_MS) calibrations.delete(k);
              calibrations.set(key, { at: nowMs, cal, box: target.box });
            }
          }
        }
      }
    }
  }

  // D. Nothing lines up: draw nothing, and ask (rule 3).
  if (!cal) {
    log(`[glance] chart: can't calibrate ${symbol} ${range} (${reasons.join("; ")})`);
    return { kind: "cant-calibrate", symbol, range, site: target.site, reasons, box: target.box };
  }

  const pts = data.points.map((p) => ({ t: p.t, price: p.price }));
  const priceAt = priceLookup(pts, [facts.first, facts.last, facts.high, facts.low, ...[facts.biggestDrop, facts.biggestRise, facts.maxDrawdown, ...(facts.bounces ?? [])].flatMap((m) => (m ? [m.from, m.to] : []))]);
  const pricesBetween = (t1: number, t2: number) => pts.filter((p) => p.t >= Math.min(t1, t2) && p.t <= Math.max(t1, t2)).map((p) => p.price);
  const showDots = (await deps.showDots?.().catch(() => false)) ?? false;
  const layer = deps.openLayer(target.el, cal, target.box, priceAt, pricesBetween, showDots ? dots : null, range);
  let annotated = 0;
  return {
    kind: "ready",
    symbol,
    range,
    site: target.site,
    drawOn: "page",
    method: cal.method,
    reason: why,
    r2,
    forced: false,
    annotate: (a) => {
      annotated++;
      layer.add(a);
    },
    get annotated() {
      return annotated;
    },
    facts,
    candles: chosen.opts,
    layer,
    box: target.box,
  };
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The marks drawn when an answer about the page's chart mentioned none (an explanation always marks the chart): the
 * high and the low, the trend when it isn't flat, and support and resistance where the price turned more than once.
 * All computed facts; nothing is said about them that the answer didn't say.
 */
export function defaultMarks(f: ChartFacts, symbol: string): ChartAnnotation[] {
  const out: ChartAnnotation[] = [
    { kind: "CHART_POINT", symbol, t: f.high.t, at: 0 },
    { kind: "CHART_POINT", symbol, t: f.low.t, at: 0 },
  ];
  if (f.trend && f.trend.direction !== "flat") out.push({ kind: "CHART_TREND", symbol, t1: f.first.t, t2: f.last.t, at: 0 });
  for (const [name, level] of [["Support", f.levels?.support], ["Resistance", f.levels?.resistance]] as const) {
    if (level && level.touches > 1) out.push({ kind: "CHART_LEVEL", symbol, price: level.price, label: `${name} ${usd(level.price)}, ${level.touches} touches`, at: 0 });
  }
  return out;
}

/**
 * The one log line for a chart request: the site, stock and range, how the chart was calibrated (canvas, dom, vision,
 * or none) with its R^2 or why not, how many marks were drawn, and whether Glance's own chart was shown and why.
 */
export function chartPathLine(p: Prepared, question: string, extra: { marks?: number; ownChart?: string } = {}): string {
  const q = JSON.stringify(question.slice(0, 60));
  const own = `ownChart=${extra.ownChart ?? "no"}`;
  switch (p.kind) {
    case "ready":
      return `[glance] chart ${q}: site=${p.site} symbol=${p.symbol} range=${p.range} method=${p.method}${p.r2 !== null ? ` r2=${p.r2.toFixed(3)}` : ""} (${p.reason}) marks=${extra.marks ?? p.layer.drawn} ${own}`;
    case "cant-calibrate":
      return `[glance] chart ${q}: site=${p.site} symbol=${p.symbol} range=${p.range} method=none error="${p.reasons.join("; ")}" marks=0 ${extra.ownChart ? own : "ownChart=offered (rule 3)"}`;
    case "ask":
      return `[glance] chart ${q}: asked first (${p.question}) marks=0 ${own}`;
    case "unavailable":
      return `[glance] chart ${q}: no prices (${p.message}) marks=0 ${own}`;
    case "none":
      return `[glance] chart ${q}: no chart on this page marks=0 ${own}`;
  }
}
