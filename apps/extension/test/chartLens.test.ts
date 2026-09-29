/**
 * The chart lens: calibrating charts on other sites, checked on saved captures of real pages (test/fixtures/charts:
 * Google Finance's SVG chart, Yahoo Finance's and TradingView's canvas charts, captured 25 Sep 2026 with Chainlink's
 * TSLA prices of the same day) and on TradingView-like and Yahoo-like fixture pages. DOM-label calibration (known
 * answers), vision calibration from the models' saved real replies, the sanity check keeping good calibrations and
 * sending bad ones to the lens, marks following scroll and resize, the lens itself, and which stock and range a page
 * shows. jsdom has no layout, so boxes come from data-rect attributes. No network.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartData } from "@glance/core/chart";
import type { ChartFacts } from "@glance/core/chart-facts";
import { calibrate, calibrationError, datedTimes, detectSymbol, fitLine, parsePrice, parseTimeLabel, parseVisionLabels, rangeFromButton, rangeFromSpan, sanityCheck, timeToPx, type AxisLabel, type Box, type Calibration } from "@glance/core/page-chart";

import { chartMarkGeometry, priceLookup } from "../lib/chartMarks";
import { ChartLayer, MARK_GAP_MS, markShapes } from "../lib/chartLayer";
import { fitTrace, traceSeries, type Pixels } from "../lib/canvasTrace";
import { intersects, placeOwnChart, wantsOwnChart } from "../lib/ownChart";
import { CALIBRATION_TTL_MS, chartPathLine, clearCalibrations, defaultMarks, preparePageChart, validateScale, visionLabels, type LensFlowDeps, type MarkLayer, type Prepared } from "../lib/chartLensFlow";
import { asksAboutPriceMove, chooseChartRoute, pageStock, pickPageChart, readDomLabels, selectedRange, wantsPageChart } from "../lib/pageChart";
import { parseCommand } from "../lib/commands";
import { LINES } from "@glance/core/persona";
import { ShowDrawings } from "../lib/showDraw";

const DIR = resolve(import.meta.dirname, "fixtures/charts");
const json = <T>(name: string) => JSON.parse(readFileSync(`${DIR}/${name}`, "utf8")) as T;
type Truth = { price: Array<[number, number]>; time: Array<[string, number, number]> };
const truthPairs = (t: Truth) => ({ price: t.price, time: t.time.map(([, ts, px]) => [ts, px] as [number, number]) });
const capture = (name: string) => json<{ chart: Box; capturedAt: string; viewport: [number, number]; labels: AxisLabel[] }>(`${name}.page.json`);
const asOfOf = (name: string) => Math.floor(Date.parse(capture(name).capturedAt) / 1000);
const facts = json<{ facts: ChartFacts[] }>("tsla-1d.facts.json").facts[0]!;
const chartData = json<ChartData>("tsla-1d.chart.json");
const points = chartData.points.map((p) => ({ t: p.t, price: p.price }));
/** The page's line, as read from the screenshot's pixels by the extension's reader (saved by e2e/calibration-sanity.ts). */
const lineOf = (name: string) => {
  const line = json<Record<string, number[]>>(`${name}.line.json`);
  return (x: number) => line[Math.round(x)] ?? null;
};

// ---- layout, from data-rect="x,y,width,height" (minus a scroll offset) -----------------------------------------------
let scrollY = 0;
const rectOf = (el: Element | null): DOMRect => {
  const r = el?.getAttribute("data-rect")?.split(",").map(Number);
  const [x, y, w, h] = r && r.length === 4 ? r : [0, 0, 0, 0];
  const top = y! - scrollY;
  return { x: x!, y: top, left: x!, top, width: w!, height: h!, right: x! + w!, bottom: top + h!, toJSON: () => ({}) } as DOMRect;
};
beforeEach(() => {
  scrollY = 0;
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 1250, configurable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  (Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = function (this: Range) {
    const n = this.startContainer;
    return rectOf(n.nodeType === 3 ? n.parentElement : (n as Element));
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.title = "";
});

const span = (text: string, cx: number, cy: number, w = 34, h = 12) => `<span data-rect="${cx - w / 2},${cy - h / 2},${w},${h}">${text}</span>`;

/** A TradingView-like page: the canvas chart, its price and time labels as DOM text (positions from the real capture). */
function tradingViewLike(opts: { selected?: string; labels?: boolean } = {}) {
  const t = json<Truth>("tradingview.truth.json");
  const labels = opts.labels === false ? "" : `<div>${t.price.map(([v, y]) => span(v.toFixed(2), 1210, y)).join("")}</div><div>${t.time.map(([text, , x]) => span(text, x, 828)).join("")}</div>`;
  const tabs = ["1 day", "5 days", "1 month", "6 months"].map((r) => `<button role="tab" aria-selected="${r === (opts.selected ?? "1 day")}">${r}</button>`).join("");
  document.title = "TSLA Stock Price — Tesla Chart — TradingView";
  history.replaceState({}, "", "/symbols/NASDAQ-TSLA/");
  document.body.innerHTML = `<main><section><h1>Tesla, Inc.</h1><span>TSLA · Nasdaq Stock Market</span>
    <div class="chart-container" data-rect="32,522,1210,320"><canvas data-rect="32,522,1148,292"></canvas><canvas data-rect="1180,522,62,292"></canvas>${labels}</div>
    <div role="tablist">${tabs}</div></section></main>`;
}

/** A Yahoo-like page: the quote heading with its ticker, a canvas chart, range buttons with an "active" class. */
function yahooLike(selected = "1D") {
  document.title = "Tesla, Inc. (TSLA) Stock Price, News, Quote & History - Yahoo Finance";
  history.replaceState({}, "", "/quote/TSLA/");
  const buttons = ["1D", "5D", "1M", "6M", "YTD"].map((r) => `<button class="tab${r === selected ? " active" : ""}">${r}</button>`).join("");
  document.body.innerHTML = `<main><section><h1>Tesla, Inc. (TSLA)</h1><p>NasdaqGS - BOATS Real Time Price • USD</p>
    <div data-testid="chart-container" data-rect="201,482,682,285"><canvas data-rect="201,482,682,285"></canvas></div>
    <div>${buttons}</div><aside><a>AMD</a> <a>COST</a></aside></section></main>`;
}

// ---------------------------------------------------------------------------------------------------------------------

describe("reading axis labels", () => {
  it.each([
    ["382.50", 382.5],
    ["$1,234.5", 1234.5],
    ["1.2K", 1200],
    ["−3.50", -3.5],
    ["12:00", null],
    ["Sep 23", null],
  ])("price %s -> %s", (text, value) => expect(parsePrice(text)).toBe(value));

  it.each([
    ["10:00", { kind: "tod", minutes: 600 }],
    ["2:30 PM", { kind: "tod", minutes: 870 }],
    ["12:00 PM", { kind: "tod", minutes: 720 }],
    ["3 PM", { kind: "tod", minutes: 900 }],
    ["Sep 23", { kind: "date", month: 8, day: 23 }],
    ["Mon 22", { kind: "date", month: null, day: 22 }],
    ["25", { kind: "date", month: null, day: 25 }],
    ["Sep", { kind: "month", month: 8 }],
    ["382.00", null],
  ])("time %s", (text, parsed) => expect(parseTimeLabel(text)).toEqual(parsed));

  it("dates a row of times right to left across midnight (TradingView's real 1 day axis, in market time)", () => {
    const t = json<Truth>("tradingview.truth.json");
    const got = datedTimes(t.time.map(([text, , x]) => ({ text, x })), asOfOf("tradingview"));
    expect(got).toEqual(t.time.map(([, ts]) => ts));
  });
});

describe("DOM-label calibration (known answers)", () => {
  it("the real Google Finance SVG chart: its <text> labels give an exact scale", () => {
    const cap = capture("google");
    document.body.innerHTML = `<div data-rect="117,346,726,200.66">${readFileSync(`${DIR}/google.chart.svg`, "utf8")}</div>`;
    const svg = document.querySelector("svg")!;
    svg.setAttribute("data-rect", "117,346,726,200.66");
    // Each <text> where the browser drew it (from the capture).
    for (const el of svg.querySelectorAll("text")) {
      const l = cap.labels.find((x) => x.text === el.textContent?.trim());
      if (l) el.setAttribute("data-rect", `${l.x - 12},${l.y - 7},24,14`);
    }
    const labels = readDomLabels(svg);
    const cal = calibrate(labels, cap.chart, "dom", asOfOf("google"));
    expect(cal.ok).toBe(true);
    const c = (cal as { calibration: Calibration }).calibration;
    const err = calibrationError(c, truthPairs(json<Truth>("google.truth.json")));
    expect(err.price.max).toBeLessThan(0.01);
    expect(err.time.max).toBeLessThan(0.1);
    expect([c.priceSide, c.time.kind]).toEqual(["left", "linear"]);
  });

  it("an HTML chart (TradingView-like): price column on the right, a time row that isn't linear (bars, not hours)", () => {
    tradingViewLike();
    const target = pickPageChart(document, window, ["TSLA", "AMD"], null)!;
    const cal = calibrate(readDomLabels(target.el), target.box, "dom", asOfOf("tradingview"));
    expect(cal.ok).toBe(true);
    const c = (cal as { calibration: Calibration }).calibration;
    const t = json<Truth>("tradingview.truth.json");
    const err = calibrationError(c, truthPairs(t));
    expect(err.price.max).toBeLessThan(1.5); // the real labels are 40.2 px a dollar, give or take a pixel
    expect(err.time.max).toBeLessThan(0.01); // piecewise through the labels: exact at each
    expect([c.priceSide, c.time.kind]).toEqual(["right", "piecewise"]);
    // A straight time line would be wrong by tens of pixels on this axis.
    const straight = fitLine(t.time.map(([, ts, px]) => [ts, px] as const))!;
    expect(Math.max(...t.time.map(([, ts, px]) => Math.abs(straight.a * ts + straight.b - px)))).toBeGreaterThan(20);
  });

  it("a label off the line the others make (a misplaced read) is left out of the fit", () => {
    const labels: AxisLabel[] = [
      { text: "382.00", x: 1210, y: 565 },
      { text: "380.00", x: 1210, y: 580 }, // 30px from where 380 is
      { text: "379.00", x: 1210, y: 686 },
      { text: "377.00", x: 1210, y: 766 },
      { text: "10:00", x: 67, y: 828 },
      { text: "12:00", x: 208.5, y: 828 },
    ];
    const cal = calibrate(labels, { x: 32, y: 522, width: 1210, height: 320 }, "dom", asOfOf("tradingview"));
    expect((cal as { calibration: Calibration }).calibration.price.n).toBe(3);
  });

  it("not enough labels (Yahoo's are drawn in the canvas): no DOM calibration, so vision is next", () => {
    yahooLike();
    const target = pickPageChart(document, window, ["TSLA"], null)!;
    expect(calibrate(readDomLabels(target.el), target.box, "dom", asOfOf("yahoo"))).toMatchObject({ ok: false });
  });
});

describe("vision calibration: the models' saved real replies, fitted in code", () => {
  const fitted = (name: string, model: string) => {
    const v = json<{ labels: unknown; crop: Box; scale: number }>(`${name}.vision.${model}.json`);
    const cal = calibrate(parseVisionLabels(v.labels, v.crop, v.scale), v.crop, "vision", asOfOf(name));
    if (!cal.ok) throw new Error(cal.reason);
    return { cal: cal.calibration, err: calibrationError(cal.calibration, truthPairs(json<Truth>(`${name}.truth.json`))) };
  };

  it.each(["google", "yahoo", "tradingview"])("%s with Sonnet: within 2px of the truth on both axes", (name) => {
    const { err } = fitted(name, "claude-sonnet-4-5");
    expect(err.price.max).toBeLessThanOrEqual(2);
    expect(err.time.max).toBeLessThanOrEqual(1.5);
  });

  it.each(["google", "yahoo", "tradingview"])("%s with Haiku: tens of pixels off (it reads the text, not where it is)", (name) => {
    const { err } = fitted(name, "claude-haiku-4-5");
    expect(Math.max(err.price.mean, err.time.mean)).toBeGreaterThan(20);
  });

  it("parsing: crop pixels to page pixels (and the downscale), bad entries dropped", () => {
    const crop = { x: 20, y: 510, width: 1250, height: 348 };
    expect(
      parseVisionLabels(
        {
          labels: [
            { axis: "price", text: "382.00", x: 952, y: 44 },
            { axis: "y", value: 376, x: 952, y: 237 },
            { axis: "time", text: "10:00", x: 37, y: 254 },
            { axis: "time", text: "far outside", x: 5000, y: 10 },
            { axis: "price", text: "a very long label indeed", x: 10, y: 10 },
            { text: 42 },
          ],
        },
        crop,
        0.8,
      ),
    ).toEqual([
      { axis: "price", text: "382.00", x: 1210, y: 565 },
      { axis: "price", text: "376", x: 1210, y: 806.25 },
      { axis: "time", text: "10:00", x: 66.25, y: 827.5 },
    ]);
  });
});

describe("the sanity check (real captures, real Chainlink prices, the page's line from the pixels)", () => {
  const check = (name: string, cal: Calibration) => sanityCheck(cal, { high: facts.high, low: facts.low, probes: points, lineAt: lineOf(name) });
  const vision = (name: string, model: string) => {
    const v = json<{ labels: unknown; crop: Box; scale: number }>(`${name}.vision.${model}.json`);
    return (calibrate(parseVisionLabels(v.labels, v.crop, v.scale), v.crop, "vision", asOfOf(name)) as { calibration: Calibration }).calibration;
  };

  it("keeps the good calibrations: Google's DOM labels and Sonnet's reads on all three pages", () => {
    const dom = (calibrate(capture("google").labels, capture("google").chart, "dom", asOfOf("google")) as { calibration: Calibration }).calibration;
    expect(check("google", dom)).toMatchObject({ ok: true, checkedLine: true });
    for (const name of ["google", "yahoo", "tradingview"]) {
      const s = check(name, vision(name, "claude-sonnet-4-5"));
      expect(s.ok).toBe(true);
      expect(s.agreement).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("rejects Haiku's on all three: our line doesn't land on the page's, so the lens is used", () => {
    for (const name of ["google", "yahoo", "tradingview"]) {
      const s = check(name, vision(name, "claude-haiku-4-5"));
      expect(s.ok).toBe(false);
      expect(s.reason).toMatch(/of our points on the page's line/);
    }
  });

  it("rejects a scale that puts our high or low outside the plot", () => {
    const good = vision("tradingview", "claude-sonnet-4-5");
    const shifted = { ...good, price: { ...good.price, b: good.price.b + 400 } };
    expect(sanityCheck(shifted, { high: facts.high, low: facts.low, probes: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/maps outside the chart's plot/) });
  });
});

/**
 * A chart's pane as pixels, drawn from prices the way a line chart draws them: white, gray gridlines, the series as a
 * 2 CSS px line in `rgb`, and a dotted last-price line in the same color across the pane (to be ignored).
 */
function drawLine(prices: readonly number[], width: number, height: number, dpr = 1, rgb: [number, number, number] = [242, 54, 69]): Pixels {
  const W = Math.round(width * dpr);
  const H = Math.round(height * dpr);
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const k = (y * W + x) * 4;
    [data[k], data[k + 1], data[k + 2], data[k + 3]] = [c[0], c[1], c[2], 255];
  };
  for (let y = 0; y < H; y += Math.round(40 * dpr)) for (let x = 0; x < W; x++) put(x, y, [225, 225, 228]);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = 20 * dpr;
  const yOf = (p: number) => pad + ((hi - p) / (hi - lo)) * (H - 2 * pad);
  const n = prices.length;
  for (let x = 0; x < W; x++) {
    const f = (x / (W - 1)) * (n - 1);
    const a = Math.floor(f);
    const b = Math.min(n - 1, a + 1);
    const y = Math.round(yOf(prices[a]! + (prices[b]! - prices[a]!) * (f - a)));
    for (let t = 0; t < 2 * dpr; t++) put(x, y + t, rgb);
  }
  const last = Math.round(yOf(prices.at(-1)!)) - 6 * dpr;
  for (let x = 0; x < W; x += 6) for (let t = 0; t < 3; t++) put(x + t, last, rgb);
  return { width: W, height: H, data };
}

/** Candles as pixels: green bodies up, red bodies down, a 1px wick through each, on white. */
function drawCandles(bars: ReadonlyArray<{ open: number; close: number; high: number; low: number }>, width: number, height: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  const yOf = (p: number) => Math.round(10 + ((hi - p) / (hi - lo)) * (height - 20));
  const step = width / bars.length;
  bars.forEach((bar, i) => {
    const c: [number, number, number] = bar.close >= bar.open ? [8, 153, 129] : [242, 54, 69];
    const x0 = Math.round(i * step + step * 0.2);
    const x1 = Math.round((i + 1) * step - step * 0.2);
    const mid = Math.round((x0 + x1) / 2);
    const fill = (x: number, y0: number, y1: number) => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        const k = (y * width + x) * 4;
        [data[k], data[k + 1], data[k + 2]] = c;
      }
    };
    fill(mid, yOf(bar.high), yOf(bar.low));
    for (let x = x0; x <= x1; x++) fill(x, yOf(bar.open), yOf(bar.close));
  });
  return { width, height, data };
}

/** A fake mark layer: what was drawn, and when it closed. */
function fakeLayer(): MarkLayer & { marks: unknown[]; closed: boolean } {
  const l = { marks: [] as unknown[], closed: false, drawn: 0, isOpen: true, add: (a: unknown) => (l.marks.push(a), (l.drawn = l.marks.length)), close: () => ((l.closed = true), (l.isOpen = false)) };
  return l as never;
}

describe("the flow: canvas, then DOM labels, then vision; else nothing drawn and a question (rule 3)", () => {
  beforeEach(clearCalibrations);
  const facts1D = { ...facts, range: "1D" as const };
  const pane = { x: 32, y: 522, width: 1148, height: 292 };
  const deps = (over: Partial<LensFlowDeps> = {}) => {
    const layer = fakeLayer();
    const openLayer = vi.fn(() => layer);
    const d: LensFlowDeps = {
      doc: document,
      win: window,
      symbols: ["TSLA", "AMD"],
      named: null,
      capture: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
      vision: vi.fn(async () => ({ labels: json<{ labels: unknown }>("tradingview.vision.claude-sonnet-4-5.json").labels })),
      facts: vi.fn(async () => facts1D),
      marketCandles: vi.fn(async () => chartData),
      openLayer,
      // No canvas pixels in jsdom: each test that wants the canvas path gives its own.
      readPixels: () => ({ error: "no canvas pixels in this test" }),
      now: () => asOfOf("tradingview") * 1000,
      crop: vi.fn(async () => {
        const v = json<{ crop: Box; scale: number; width: number; height: number }>("tradingview.vision.claude-sonnet-4-5.json");
        return { base64: "BBBB", width: v.width, height: v.height, crop: v.crop, scale: v.scale, pixels: { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData };
      }),
      ...over,
    };
    return { d, openLayer, layer };
  };

  it("A. the chart's own canvas, traced and fitted: marks go on the page's chart; no DOM labels read, no screenshot", async () => {
    tradingViewLike({ labels: false });
    const prices = chartData.points.map((p) => p.price);
    const { d, openLayer, layer } = deps({ readPixels: () => ({ pixels: drawLine(prices, pane.width, pane.height) as never, pane, dpr: 1, canvases: 2 }) });
    const got = await preparePageChart(d);
    expect(got).toMatchObject({ kind: "ready", symbol: "TSLA", range: "1D", drawOn: "page", method: "canvas" });
    expect((got as { r2: number }).r2).toBeGreaterThan(0.99);
    expect(d.capture).not.toHaveBeenCalled();
    expect(openLayer).toHaveBeenCalledWith(document.querySelector(".chart-container"), expect.objectContaining({ method: "canvas" }), expect.any(Object), expect.any(Function), expect.any(Function), null, "1D");
    (got as { annotate(a: unknown): void }).annotate({ kind: "CHART_POINT", symbol: "TSLA", t: facts.high.t, at: 0 });
    expect(layer.marks).toHaveLength(1);
  });

  it("B. DOM labels that check out (the canvas unreadable): marks on the page's chart, no screenshot", async () => {
    tradingViewLike();
    const { d, openLayer } = deps();
    const got = await preparePageChart(d);
    expect(got).toMatchObject({ kind: "ready", symbol: "TSLA", range: "1D", drawOn: "page", method: "dom" });
    expect(d.capture).not.toHaveBeenCalled();
    expect(openLayer).toHaveBeenCalledTimes(1);
  });

  it("C. no DOM labels: a screenshot read by vision, fitted and validated here, drawn on the page", async () => {
    tradingViewLike({ labels: false });
    const { d } = deps();
    const got = await preparePageChart(d);
    expect(d.vision).toHaveBeenCalledWith(expect.objectContaining({ base64: "BBBB" }));
    expect(got).toMatchObject({ kind: "ready", drawOn: "page", method: "vision" });
  });

  it("D. a bad vision reading (Haiku's real reply): NOTHING drawn, no Glance chart, rule 3's question with the reasons", async () => {
    tradingViewLike({ labels: false });
    const { d, openLayer } = deps({ vision: vi.fn(async () => ({ labels: json<{ labels: unknown }>("tradingview.vision.claude-haiku-4-5.json").labels })) });
    const got = await preparePageChart({ ...d, readLine: () => lineOf("tradingview") });
    expect(got).toMatchObject({ kind: "cant-calibrate", symbol: "TSLA", range: "1D" });
    expect((got as { reasons: string[] }).reasons.map((r) => r.split(":")[0])).toEqual(["canvas", "dom", "vision"]);
    expect(openLayer).not.toHaveBeenCalled();
    expect(LINES.cantLineUp).toBe("I can't line up marks on this chart. Want me to pull up my own?");
  });

  it("no screenshot possible, or today's vision readings used up: nothing drawn, rule 3, and why", async () => {
    tradingViewLike({ labels: false });
    const none = await preparePageChart(deps({ capture: vi.fn(async () => null) }).d);
    expect(none).toMatchObject({ kind: "cant-calibrate" });
    expect((none as { reasons: string[] }).reasons.at(-1)).toMatch(/^vision: no screenshot/);
    const limit = await preparePageChart(deps({ vision: vi.fn(async () => ({ limit: "today's chart readings are used up" })) }).d);
    expect((limit as { reasons: string[] }).reasons.at(-1)).toBe("vision: today's chart readings are used up");
  });

  it("the same chart asked about again within 10 minutes: the vision calibration is reused, no screenshot or vision call", async () => {
    tradingViewLike({ labels: false });
    let now = asOfOf("tradingview") * 1000;
    const { d } = deps({ now: () => now });
    expect(await preparePageChart(d)).toMatchObject({ drawOn: "page", method: "vision" });
    now += CALIBRATION_TTL_MS - 1_000;
    expect(await preparePageChart(d)).toMatchObject({ drawOn: "page", method: "vision" });
    expect(d.vision).toHaveBeenCalledTimes(1);
    expect(d.capture).toHaveBeenCalledTimes(1);
    now += 2_000;
    await preparePageChart(d);
    expect(d.vision).toHaveBeenCalledTimes(2);
  });

  it("another range of the same chart is its own calibration", async () => {
    tradingViewLike({ labels: false });
    const { d } = deps();
    await preparePageChart(d);
    await preparePageChart(d, { confirmed: { symbol: "TSLA", range: "1M" } });
    expect(d.vision).toHaveBeenCalledTimes(2);
  });

  it("vision's structured reading (plot box, price ticks, time ticks) becomes axis labels; the 3% rule validates the scale", () => {
    const labels = visionLabels({ plot: { x: 10, y: 20, width: 500, height: 200 }, price: [{ price: 380, y: 40 }, { price: 370, y: 190 }], time: [{ time: "10:00", x: 60 }, { time: "12:00", x: 300 }] }) as Array<{ axis: string; text: string; x: number; y: number }>;
    expect(labels).toEqual([
      { axis: "price", text: "380", x: 530, y: 40 },
      { axis: "price", text: "370", x: 530, y: 190 },
      { axis: "time", text: "10:00", x: 60, y: 232 },
      { axis: "time", text: "12:00", x: 300, y: 232 },
    ]);
    // px = a * price + b: 380 at y 40, 370 at y 190 (15 px a dollar), on a plot from y 20 to 220.
    const cal = { method: "vision", price: { a: -15, b: 5_740, rmse: 0, n: 2 }, time: { kind: "linear", anchors: [], fit: { a: 1, b: 0, rmse: 0, n: 2 } }, plot: { x: 10, y: 20, width: 500, height: 200 }, priceSide: "right" } as Calibration;
    expect(validateScale(cal, 379, 371).ok).toBe(true);
    expect(validateScale(cal, 385, 371)).toMatchObject({ ok: false, reason: "the candles' high and low fall outside the plot (over 3%)" });
  });

  it("the page's own range decides (6 months: six months of prices, no question)", async () => {
    tradingViewLike({ selected: "6 months" });
    const { d } = deps();
    await preparePageChart(d);
    // Six months of the market's candles (no finer or pre-market set on a long range), and facts from the same.
    expect(d.marketCandles).toHaveBeenCalledWith("TSLA", "6M", {});
    expect(d.marketCandles).toHaveBeenCalledWith("TSLA", "6M", { fine: true });
    expect(d.marketCandles).toHaveBeenCalledTimes(2);
    expect(d.facts).toHaveBeenCalledWith("TSLA", "6M", {});
  });

  it("no stock on the page or in the question: one short question, nothing fetched", async () => {
    tradingViewLike();
    document.title = "Chart";
    history.replaceState({}, "", "/chart/");
    document.querySelector("h1")!.textContent = "A chart";
    document.querySelector("section > span")!.textContent = "Nasdaq Stock Market";
    const { d } = deps();
    expect(await preparePageChart(d)).toEqual({ kind: "ask", question: "Which stock is this chart?", symbol: null, range: "1D" });
    expect(d.marketCandles).not.toHaveBeenCalled();
  });
});

describe("marks on the page's chart follow scroll and resize", () => {
  it("a point on our high, re-placed when the page scrolls and when the chart resizes", async () => {
    tradingViewLike();
    const target = document.querySelector(".chart-container")!;
    const cal = (calibrate(readDomLabels(target), rectOf(target), "dom", asOfOf("tradingview")) as { calibration: Calibration }).calibration;
    const host = document.createElement("div");
    document.body.append(host);
    const drawings = new ShowDrawings(host);
    const at = { x: 32, y: 522, width: 1210, height: 320 };
    const anchor = { at, now: () => ({ x: rectOf(target).left, y: rectOf(target).top, width: rectOf(target).width, height: rectOf(target).height }) };
    const priceAt = priceLookup(points, [facts.high]);
    expect(drawings.drawChart("CHART_POINT", chartMarkGeometry({ kind: "CHART_POINT", symbol: "TSLA", t: facts.high.t, at: 0 }, cal, anchor, priceAt), target)).toBe(true);
    const pen = () => host.querySelector("[data-mark=chart_point]")!.getAttribute("d")!;
    const firstY = (d: string) => Number(/M[\d.]+,([\d.]+)/.exec(d)![1]);
    const before = pen();
    // The expected spot: our high's time and price through the calibration.
    const x = timeToPx(cal.time, facts.high.t);
    expect(Number(/M([\d.]+),/.exec(before)![1])).toBeGreaterThan(x - 30);
    scrollY = 200;
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(firstY(before) - firstY(pen())).toBeCloseTo(200, 0);
    // Twice as wide: x positions scale with the chart.
    target.setAttribute("data-rect", "32,522,2420,320");
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(Number(/M([\d.]+),/.exec(pen())![1]) - 32).toBeCloseTo((Number(/M([\d.]+),/.exec(before)![1]) - 32) * 2, -1);
    drawings.destroy();
  });

  it("a level gets its factual label; a mark outside the plot is skipped, never guessed", () => {
    tradingViewLike();
    const target = document.querySelector(".chart-container")!;
    const cal = (calibrate(readDomLabels(target), rectOf(target), "dom", asOfOf("tradingview")) as { calibration: Calibration }).calibration;
    const host = document.createElement("div");
    document.body.append(host);
    const drawings = new ShowDrawings(host);
    const anchor = { at: rectOf(target), now: () => rectOf(target) };
    drawings.drawChart("CHART_LEVEL", chartMarkGeometry({ kind: "CHART_LEVEL", symbol: "TSLA", price: facts.high.price, label: `High ${facts.high.price}`, at: 0 }, cal, anchor, () => null), target);
    expect(host.querySelector("[data-mark=label]")!.textContent).toBe(`High ${facts.high.price}`);
    expect(drawings.drawChart("CHART_LEVEL", chartMarkGeometry({ kind: "CHART_LEVEL", symbol: "TSLA", price: 999, label: "x", at: 0 }, cal, anchor, () => null), target)).toBe(false);
    drawings.destroy();
  });
});

describe("the annotation layer: marks on the page's own chart", () => {
  const cal = { method: "canvas", price: { a: -2, b: 900, rmse: 0, n: 2 }, time: { kind: "linear", anchors: [], fit: { a: 0.5, b: -500, rmse: 0, n: 2 } }, plot: { x: 100, y: 200, width: 600, height: 240 }, priceSide: "right" } as Calibration;
  const at = { x: 100, y: 200, width: 600, height: 240 };
  // price 300 -> y 300 (100 into the box); t 1600 -> x 300 (200 into the box)
  const priceAt = () => 300;

  it("each primitive, in the chart box's coordinates: a circle with its price, a dashed level with its label, a trend line with an arrow, a shaded box", () => {
    expect(markShapes({ kind: "CHART_POINT", symbol: "X", t: 1600, at: 0 }, cal, at, priceAt, () => [])).toEqual([
      { kind: "circle", cx: 200, cy: 100, r: 9 },
      { kind: "text", x: 200, y: 85, text: "$300.00", anchor: "middle" },
    ]);
    expect(markShapes({ kind: "CHART_LEVEL", symbol: "X", price: 300, label: "Support $300.00, 2 touches", at: 0 }, cal, at, priceAt, () => [])).toEqual([
      { kind: "line", x1: 0, y1: 100, x2: 600, y2: 100, dashed: true },
      { kind: "text", x: 594, y: 94, text: "Support $300.00, 2 touches", anchor: "end" },
    ]);
    const trend = markShapes({ kind: "CHART_TREND", symbol: "X", t1: 1400, t2: 1800, at: 0 }, cal, at, (t) => (t === 1400 ? 290 : 310), () => [])!;
    expect(trend[0]).toEqual({ kind: "line", x1: 100, y1: 120, x2: 300, y2: 80 });
    expect(trend[1]!.kind).toBe("polygon");
    expect(markShapes({ kind: "CHART_RANGE", symbol: "X", t1: 1400, t2: 1800, at: 0 }, cal, at, priceAt, () => [295, 305])).toEqual([{ kind: "polygon", points: [[100, 87], [300, 87], [300, 113], [100, 113]] }]);
  });

  it("a shaded zone over nearly the whole chart marks nothing: skipped", () => {
    expect(markShapes({ kind: "CHART_RANGE", symbol: "X", t1: 1200, t2: 2400, at: 0 }, cal, at, priceAt, () => [295, 305])).toBeNull();
  });

  it("a mark outside the plot is skipped, never guessed", () => {
    expect(markShapes({ kind: "CHART_LEVEL", symbol: "X", price: 900, label: "x", at: 0 }, cal, at, priceAt, () => [])).toBeNull();
    expect(markShapes({ kind: "CHART_POINT", symbol: "X", t: 99_999, at: 0 }, cal, at, priceAt, () => [])).toBeNull();
  });

  it("pinned to the chart's box (click-through), follows scroll, marks 400ms apart, x and range change clear it", async () => {
    vi.useFakeTimers();
    tradingViewLike();
    const target = document.querySelector(".chart-container")!;
    const host = document.createElement("div");
    document.body.append(host);
    let range = "1D";
    const onClose = vi.fn();
    const layer = new ChartLayer(host, target, cal, rectOf(target), priceAt, () => [], { onClose, range: "1D", rangeNow: () => range });
    expect([layer.root.style.left, layer.root.style.top, layer.root.style.width, layer.root.style.height]).toEqual(["32px", "522px", "1210px", "320px"]);
    expect(layer.root.className).toBe("g-chart-layer");
    layer.add({ kind: "CHART_LEVEL", symbol: "X", price: 300, label: "Low", at: 0 });
    layer.add({ kind: "CHART_LEVEL", symbol: "X", price: 310, label: "High", at: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(layer.drawn).toBe(1);
    await vi.advanceTimersByTimeAsync(MARK_GAP_MS - 50);
    expect(layer.drawn).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(layer.drawn).toBe(2);
    scrollY = 300;
    window.dispatchEvent(new Event("scroll"));
    expect(layer.root.style.top).toBe("222px");
    // The page's range changes: those marks are for another chart.
    range = "1W";
    await vi.advanceTimersByTimeAsync(900);
    expect(layer.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalled();
    const again = new ChartLayer(host, target, cal, rectOf(target), priceAt, () => []);
    (again.root.querySelector("button[aria-label=\"Clear Glance's marks from this chart\"]") as HTMLButtonElement).click();
    expect(host.contains(again.root)).toBe(false);
    vi.useRealTimers();
  });
});

describe("Glance's own chart: only when asked, docked, never over the page's chart", () => {
  it("explicit requests only", () => {
    for (const q of ["show me your chart", "pull up Glance's chart", "open your chart", "use your chart", "Pull up your own"]) expect(wantsOwnChart(q), q).toBe(true);
    for (const q of ["explain this chart", "what's this chart doing", "show me Tesla's chart", "where did it bounce", "show me support", "is this a good entry"]) expect(wantsOwnChart(q), q).toBe(false);
  });

  it("regression: wherever the panel and the page's chart are, the dock never intersects the page's chart", () => {
    const viewport = { width: 1440, height: 900 };
    const charts = [
      { x: 40, y: 478, width: 1292, height: 292 }, // TradingView's symbol page
      { x: 0, y: 0, width: 1440, height: 400 },
      { x: 700, y: 100, width: 740, height: 700 },
      { x: 200, y: 300, width: 600, height: 300 },
    ];
    const panels = [null, { x: 1056, y: 244, width: 360, height: 560 }, { x: 24, y: 24, width: 360, height: 500 }, { x: 540, y: 300, width: 360, height: 300 }];
    let placed = 0;
    for (const chart of charts) {
      for (const panel of panels) {
        const box = placeOwnChart(panel, viewport, [chart]);
        if (!box) continue;
        placed++;
        expect(intersects(box, chart, 4), JSON.stringify({ chart, panel, box })).toBe(false);
        if (panel) expect(intersects(box, panel, 4)).toBe(false);
        expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height).toBe(true);
      }
    }
    expect(placed).toBeGreaterThan(10);
    // No room anywhere: none (never over the chart).
    expect(placeOwnChart(null, viewport, [{ x: 0, y: 0, width: 1440, height: 900 }])).toBeNull();
  });
});

describe("which chart, which stock, which range", () => {
  it("a TradingView-like page: TSLA from the URL and heading, 1 day from the selected tab", () => {
    tradingViewLike();
    expect(pickPageChart(document, window, ["TSLA", "AMD"], null)).toMatchObject({ symbol: "TSLA", range: "1D", unsure: null, box: { x: 32, y: 522, width: 1210, height: 320 } });
    tradingViewLike({ selected: "5 days" });
    expect(pickPageChart(document, window, ["TSLA", "AMD"], null)).toMatchObject({ range: "1W", unsure: null });
  });

  it("a Yahoo-like page: TSLA from /quote/TSLA and \"(TSLA)\", 1D from the active button, the AMD link nearby doesn't win", () => {
    yahooLike();
    expect(pickPageChart(document, window, ["TSLA", "AMD"], null)).toMatchObject({ symbol: "TSLA", range: "1D", unsure: null });
    yahooLike("5D");
    expect(pickPageChart(document, window, ["TSLA", "AMD"], null)!.range).toBe("1W");
  });

  it("the question's company is used unless the page clearly shows another (then it asks); unlisted stocks aren't guessed", () => {
    yahooLike();
    expect(pickPageChart(document, window, ["TSLA", "AMD"], "TSLA")).toMatchObject({ symbol: "TSLA", unsure: null });
    expect(pickPageChart(document, window, ["TSLA", "AMD"], "AMD")).toMatchObject({ symbol: "TSLA", unsure: "This chart looks like TSLA. Which chart: TSLA 1 day?" });
    expect(detectSymbol({ url: "https://example.com/quote/AAPL", headings: ["Apple Inc. (AAPL)"], nearChart: [] }, ["TSLA"])).toEqual({ symbol: null, confident: false, candidates: [] });
  });

  it("range words, and the span of the time labels when no button says", () => {
    expect(["1D", "1 day", "5D", "5 days", "1M", "1 month", "3 months", "6M", "6 months", "YTD", "1 year", "5 years", "10 years", "All time", "Max"].map(rangeFromButton)).toEqual([
      "1D", "1D", "1W", "1W", "1M", "1M", "3M", "6M", "6M", "YTD", "1Y", "5Y", "10Y", "ALL", "ALL",
    ]);
    expect(rangeFromButton("Overview")).toBeNull();
    expect([20 * 3600, 5 * 86_400, 28 * 86_400, 80 * 86_400, 180 * 86_400, 360 * 86_400, 4 * 365 * 86_400, 20 * 365 * 86_400].map(rangeFromSpan)).toEqual(["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"]);
  });

  it("which questions are about a chart on the page", () => {
    for (const q of ["explain this chart", "show me the dip on this chart", "what happened here?", "what's this spike?"]) expect(wantsPageChart(q)).toBe(true);
    for (const q of ["how did Tesla do this week?", "what's this article saying?"]) expect(wantsPageChart(q)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Any US stock: TradingView's real layout (checked on the live NVDA and TSLA pages, 29 Sep 2026)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * TradingView's symbol page as it really is: the chart inside a container with the same box (both are chart
 * candidates), its axis labels drawn on canvas (no DOM text), and range buttons whose selected class is hashed and
 * whose text carries the range's change ("1 day1.68%").
 */
function tradingViewReal(ticker = "NVDA", name = "NVIDIA Corporation", selected = "1 day") {
  document.title = `${name.split(" ")[0]} Stock Price Chart — NASDAQ:${ticker} — TradingView`;
  history.replaceState({}, "", `/symbols/NASDAQ-${ticker}/`);
  const ranges = [["1 day", "LASTSESSION"], ["5 days", "5D"], ["1 month", "1M"], ["6 months", "6M"], ["1 year", "12M"], ["5 years", "60M"], ["All time", "ALL"]];
  const buttons = ranges
    .map(([label, id]) => `<button data-qa-id="time-range-button-${id}" class="rangeButtonGreen-zQg8sTYo rangeButton-zQg8sTYo${label === selected ? " selected-zQg8sTYo" : ""}"><span class="content-zQg8sTYo"><span>${label}</span><span>1.68%</span></span></button>`)
    .join("");
  document.body.innerHTML = `<main><h1>${name}</h1>
    <div data-rect="40,538,1360,320"><div class="tv-lightweight-charts" data-rect="40,538,1360,320"><canvas data-rect="40,538,1300,300"></canvas><canvas data-rect="1340,538,60,300"></canvas></div></div>
    <div class="block-fLCQaGQP">${buttons}</div></main>`;
}

describe("any US stock on a page", () => {
  it("the stock from TradingView's URL and title, any US ticker (not only the catalog's); bare capitals never count", () => {
    const d = (url: string, headings: string[], symbols = ["TSLA", "AMD"]) => detectSymbol({ url, headings, nearChart: [] }, symbols, { anyTicker: true });
    expect(d("https://www.tradingview.com/symbols/NASDAQ-NVDA/", ["Nvidia Stock Price Chart — NASDAQ:NVDA — TradingView"])).toMatchObject({ symbol: "NVDA", confident: true });
    expect(d("https://www.tradingview.com/chart/", ["Apple Stock Price Chart — NASDAQ:AAPL — TradingView"])).toMatchObject({ symbol: "AAPL", confident: true });
    expect(d("https://finance.yahoo.com/quote/AAPL/", ["Apple Inc. (AAPL)"])).toMatchObject({ symbol: "AAPL", confident: true });
    expect(d("https://www.google.com/finance/quote/NVDA:NASDAQ", [])).toMatchObject({ symbol: "NVDA", confident: true });
    expect(d("https://www.tradingview.com/symbols/NASDAQ-TSLA/", ["TSLA Stock Price — Tesla Chart — TradingView"])).toMatchObject({ symbol: "TSLA", confident: true });
    // A news page: capitalised words aren't tickers unless they're the catalog's.
    expect(d("https://news.example/story", ["CEO says USA sales rose"]).symbol).toBeNull();
    // Without anyTicker (the old behaviour), only the catalog counted: this is why NVDA's chart asked "Which stock?".
    expect(detectSymbol({ url: "https://www.tradingview.com/symbols/NASDAQ-NVDA/", headings: [], nearChart: [] }, ["TSLA"]).symbol).toBeNull();
  });

  it("the page's stock and the name people say: NVIDIA, not NVIDIA Corporation", () => {
    tradingViewReal();
    expect(pageStock(document, ["TSLA", "AMD"])).toEqual({ symbol: "NVDA", name: "NVIDIA" });
  });

  it("TradingView's real layout: one chart (not two), its range read from the hashed 'selected' class, no question", () => {
    tradingViewReal("NVDA", "NVIDIA Corporation", "1 day");
    const t = pickPageChart(document, window, ["TSLA", "AMD"], null)!;
    expect(t).toMatchObject({ symbol: "NVDA", range: "1D", alternatives: 0, unsure: null });
    tradingViewReal("NVDA", "NVIDIA Corporation", "6 months");
    expect(selectedRange(document.querySelector(".tv-lightweight-charts")!)).toBe("6M");
  });

  it("NVDA's chart: its own prices for its own range (the extension asks for NVDA 1D), never a catalog stand-in", async () => {
    tradingViewReal();
    const marketCandles = vi.fn(async () => null);
    const facts = vi.fn(async () => null);
    const prep = await preparePageChart({ doc: document, win: window, symbols: ["TSLA", "AMD"], named: null, capture: async () => null, vision: async () => null, facts, marketCandles, openLayer: vi.fn() as never, readPixels: () => ({ error: "none" }) });
    expect(marketCandles).toHaveBeenCalledWith("NVDA", "1D", {});
    expect(marketCandles).toHaveBeenCalledWith("NVDA", "1D", { fine: true, prepost: true });
    expect(prep).toEqual({ kind: "unavailable", message: "I don't have NVDA's prices for that range right now." });
  });
});

describe("which chart a question is about, and the one log line", () => {
  it("'explain this chart' and a price-move question go to the page's chart when it has one", () => {
    const page = { hasChart: true, pageSymbol: "NVDA", named: null };
    expect(chooseChartRoute("Explain this chart", page)).toEqual({ route: "page", reason: "the question is about this chart" });
    // The reported bug: this never reached the page's chart ("this chart" wasn't in it).
    expect(wantsPageChart("Show me where it bounced this week")).toBe(false);
    expect(asksAboutPriceMove("Show me where it bounced this week")).toBe(true);
    expect(chooseChartRoute("Show me where it bounced this week", page)).toEqual({ route: "page", reason: "a price question, with a chart on the page" });
    expect(chooseChartRoute("how did it do today?", page).route).toBe("page");
  });

  it("no chart on the page, another stock named, or not a chart question: not the page's chart", () => {
    expect(chooseChartRoute("Show me where it bounced this week", { hasChart: false, pageSymbol: null, named: null })).toEqual({ route: "glance", reason: "no chart on this page" });
    expect(chooseChartRoute("where did AMD bounce this week?", { hasChart: true, pageSymbol: "NVDA", named: "AMD" })).toEqual({ route: "glance", reason: "the question names AMD, the page shows NVDA" });
    expect(chooseChartRoute("what's this article saying?", { hasChart: true, pageSymbol: "NVDA", named: null }).route).toBe("none");
  });

  it("one line per chart request: site, symbol, range, method, R^2 or the error, marks, and Glance's own chart", () => {
    const layer = fakeLayer();
    const ready = (method: "canvas" | "dom" | "vision", r2: number | null, reason: string) =>
      ({ kind: "ready", symbol: "HOG", range: "1D", site: "tradingview", drawOn: "page", method, reason, r2, forced: false, annotate: () => {}, annotated: 0, facts, layer, box: { x: 0, y: 0, width: 1, height: 1 } }) as unknown as Prepared;
    const q = "Explain this chart";
    expect(chartPathLine(ready("canvas", 0.9768, "line #f23645, R^2 0.977, range off 1.2%"), q, { marks: 4 })).toBe(
      '[glance] chart "Explain this chart": site=tradingview symbol=HOG range=1D method=canvas r2=0.977 (line #f23645, R^2 0.977, range off 1.2%) marks=4 ownChart=no',
    );
    expect(chartPathLine(ready("dom", null, "linear time axis; ok"), q, { marks: 2 })).toBe('[glance] chart "Explain this chart": site=tradingview symbol=HOG range=1D method=dom (linear time axis; ok) marks=2 ownChart=no');
    expect(chartPathLine({ kind: "cant-calibrate", symbol: "HOG", range: "1D", site: "tradingview", reasons: ["canvas: R^2 0.812 under 0.95", "dom: no price axis", "vision: no screenshot"], box: { x: 0, y: 0, width: 1, height: 1 } }, q)).toBe(
      '[glance] chart "Explain this chart": site=tradingview symbol=HOG range=1D method=none error="canvas: R^2 0.812 under 0.95; dom: no price axis; vision: no screenshot" marks=0 ownChart=offered (rule 3)',
    );
    expect(chartPathLine({ kind: "none" }, q)).toContain("no chart on this page");
  });

  it("an answer that mentioned no marks still marks the chart: high, low, trend, and levels touched twice (computed)", () => {
    const f = { ...facts, trend: { direction: "up" as const, from: facts.first, to: facts.last, pct: 1.2 }, levels: { support: { price: 360.5, touches: 2, times: [1, 2] }, resistance: { price: 380, touches: 1, times: [3] } } };
    expect(defaultMarks(f, "TSLA")).toEqual([
      { kind: "CHART_POINT", symbol: "TSLA", t: facts.high.t, at: 0 },
      { kind: "CHART_POINT", symbol: "TSLA", t: facts.low.t, at: 0 },
      { kind: "CHART_TREND", symbol: "TSLA", t1: facts.first.t, t2: facts.last.t, at: 0 },
      { kind: "CHART_LEVEL", symbol: "TSLA", price: 360.5, label: "Support $360.50, 2 touches", at: 0 },
    ]);
  });

  it("'show me Tesla's chart' on a page with no chart: Glance's own (the one case besides an explicit request)", () => {
    expect(chooseChartRoute("show me Tesla's chart", { hasChart: false, pageSymbol: null, named: "TSLA" }).route).not.toBe("page");
  });

  it("support and entry questions are about the chart on the page (annotated), not Glance's own", () => {
    const page = { hasChart: true, pageSymbol: "HOG", named: null };
    for (const q of ["what's this chart doing", "where did it bounce", "show me support", "is this a good entry"]) expect(chooseChartRoute(q, page).route, q).toBe("page");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Tracing the page's canvas (lib/canvasTrace.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** A real TradingView pane, captured from the live page (29 Sep 2026) with Yahoo's candles for the same range. */
function capturedPane(name: string): { pixels: Pixels; meta: { width: number; height: number; dpr: number; pane: Box; candles: Array<{ t: number; price: number }> } } {
  const meta = json<{ width: number; height: number; dpr: number; pane: Box; candles: Array<{ t: number; price: number }> }>(`${name}.json`);
  const data = new Uint8ClampedArray(gunzipSync(readFileSync(`${DIR}/${name}.rgba.gz`)));
  return { pixels: { width: meta.width, height: meta.height, data }, meta };
}

describe("tracing the page's own chart and fitting it", () => {
  it.each([
    ["tv-hog-1D", 0.97],
    ["tv-tsla-1W", 0.99],
    ["tv-nvda-1M", 0.99],
  ])("%s: the real TradingView line traced, fitted to the candles (R^2 >= %s, range within 3%)", (name, minR2) => {
    const { pixels, meta } = capturedPane(name);
    const trace = traceSeries(pixels, meta.dpr)!;
    expect(trace.kind).toBe("line");
    expect(trace.points.length).toBeGreaterThan(pixels.width * 0.9);
    const pts = trace.points.map((p) => ({ x: meta.pane.x + p.x / meta.dpr, y: meta.pane.y + p.y / meta.dpr }));
    const fit = fitTrace(pts, meta.candles, meta.pane);
    expect(fit.ok, fit.reason).toBe(true);
    expect(fit.r2).toBeGreaterThanOrEqual(minR2 as number);
    expect(fit.rangeError).toBeLessThanOrEqual(0.03);
  });

  it("devicePixelRatio 1 and 2: the same line, the same fit (the trace is in device px, the fit in CSS px)", () => {
    const prices = [100, 102, 101, 105, 104, 108, 107, 103, 106, 110, 109, 112];
    const candles = prices.map((price, i) => ({ t: 1_790_000_000 + i * 300, price }));
    const pane = { x: 50, y: 60, width: 400, height: 200 };
    for (const dpr of [1, 2]) {
      const trace = traceSeries(drawLine(prices, pane.width, pane.height, dpr), dpr)!;
      const pts = trace.points.map((p) => ({ x: pane.x + p.x / dpr, y: pane.y + p.y / dpr }));
      const fit = fitTrace(pts, candles, pane);
      expect(fit.ok, `dpr ${dpr}: ${fit.reason}`).toBe(true);
      expect(fit.r2).toBeGreaterThan(0.99);
      // Price to pixel and back: the high sits 20px below the pane's top, the low 20px above its bottom.
      expect(fit.a * (pane.y + 20) + fit.b).toBeCloseTo(112, 0);
      expect(fit.a * (pane.y + pane.height - 20) + fit.b).toBeCloseTo(100, 0);
      // Time to pixel: the first candle at the left edge, the last at the right.
      const anchors = fit.calibration!.time.anchors;
      expect(anchors[0]!.px).toBeCloseTo(pane.x, 0);
      expect(anchors.at(-1)!.px).toBeCloseTo(pane.x + pane.width, -1);
    }
  });

  it("a chart spaced by clock time (Yahoo's day, sparse pre-market bars): fitted by time, not bar order", () => {
    // Bars at irregular times: a quiet stretch (few bars) then a busy one; the page spaces them by time.
    const times = [0, 600, 1200, 5400, 5460, 5520, 5580, 5640, 5700, 5760, 5820, 5880, 5940, 6000];
    const prices = [100, 101, 99, 104, 105, 103, 106, 108, 107, 109, 110, 108, 111, 112];
    const W = 600;
    const H = 200;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const yOf = (p: number) => Math.round(20 + ((112 - p) / 13) * (H - 40));
    for (let x = 0; x < W; x++) {
      const t = (x / (W - 1)) * 6000;
      let i = 0;
      while (i < times.length - 2 && times[i + 1]! <= t) i++;
      const w = (t - times[i]!) / (times[i + 1]! - times[i]!);
      const y = yOf(prices[i]! + (prices[i + 1]! - prices[i]!) * w);
      for (const dy of [0, 1]) {
        const k = ((y + dy) * W + x) * 4;
        [data[k], data[k + 1], data[k + 2]] = [189, 20, 20];
      }
    }
    const trace = traceSeries({ width: W, height: H, data }, 1)!;
    const fit = fitTrace(trace.points, times.map((t, i) => ({ t: 1_790_000_000 + t, price: prices[i]! })), { x: 0, y: 0, width: W, height: H });
    expect(fit.ok, fit.reason).toBe(true);
    expect(fit.reason).toMatch(/x by time/);
    expect(fit.r2).toBeGreaterThan(0.98);
  });

  it("gridlines, the dotted last-price line and gray text are ignored; the series color is found", () => {
    const trace = traceSeries(drawLine([10, 12, 11, 15, 13, 17, 16, 14, 18, 20], 300, 150), 1)!;
    expect(trace.color).toBe("#f23645");
    // One y per column, following the line, never jumping to the dotted line.
    const ys = trace.points.map((p) => p.y);
    for (let i = 1; i < ys.length; i++) expect(Math.abs(ys[i]! - ys[i - 1]!)).toBeLessThan(20);
  });

  it("candles: each body's close (top of an up candle, bottom of a down one), then the same fit", () => {
    const closes = [100, 103, 101, 106, 104, 109, 107, 111, 108, 113, 112, 115];
    const bars = closes.map((close, i) => {
      const open = i === 0 ? 99 : closes[i - 1]!;
      return { open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1 };
    });
    const pixels = drawCandles(bars, 480, 240);
    const trace = traceSeries(pixels, 1)!;
    expect(trace.kind).toBe("candles");
    expect(trace.points).toHaveLength(bars.length);
    const fit = fitTrace(trace.points, closes.map((price, i) => ({ t: 1_790_000_000 + i * 86_400, price })), { x: 0, y: 0, width: 480, height: 240 });
    expect(fit.ok, fit.reason).toBe(true);
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  it("the gates: R^2 under 0.95, or a fitted range more than 3% off, is refused (and says why)", () => {
    const pane = { x: 0, y: 0, width: 400, height: 200 };
    const prices = [100, 104, 99, 106, 101, 108, 100, 110];
    const trace = traceSeries(drawLine(prices, 400, 200), 1)!;
    // Candles of another shape: the fit is poor.
    const other = [110, 100, 108, 101, 106, 99, 104, 100].map((price, i) => ({ t: i, price }));
    const bad = fitTrace(trace.points, other, pane);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/R\^2 [\d.]+ under 0.95|no alignment/);
    // The same shape: accepted; its range within 3%.
    const good = fitTrace(trace.points, prices.map((price, i) => ({ t: i, price })), pane);
    expect(good).toMatchObject({ ok: true });
    expect(good.rangeError).toBeLessThanOrEqual(0.03);
    // Too little to fit.
    expect(fitTrace(trace.points.slice(0, 3), other, pane).ok).toBe(false);
  });
});

describe("trading a stock outside the catalog, typed", () => {
  const companies = [
    { symbol: "TSLA", aliases: ["Tesla"] },
    { symbol: "AMD", aliases: ["AMD"] },
  ];
  const nvda = { symbol: "NVDA", name: "NVIDIA" };

  it("on NVDA's page, 'buy $10 of Nvidia', 'sell this', or a ticker typed in capitals: refused, with the catalog's list", () => {
    expect(parseCommand("buy $10 of Nvidia", companies, [], nvda)).toEqual({ kind: "notTradable", symbol: "NVDA", name: "NVIDIA" });
    expect(parseCommand("sell this", companies, [], nvda)).toEqual({ kind: "notTradable", symbol: "NVDA", name: "NVIDIA" });
    expect(parseCommand("buy $10 of AAPL", companies)).toEqual({ kind: "notTradable", symbol: "AAPL", name: "AAPL" });
    expect(LINES.notTradable("NVIDIA", ["TSLA", "AMZN", "PLTR", "NFLX", "AMD", "SPY", "QQQ"])).toBe("I can explain NVIDIA, but your vault only trades TSLA, AMZN, PLTR, NFLX, AMD, SPY and QQQ.");
  });

  it("a catalog stock still trades on the same page", () => {
    expect(parseCommand("buy $10 of Tesla", companies, [], nvda)).toEqual({ kind: "buy", symbol: "TSLA", amount: "10" });
  });
});
