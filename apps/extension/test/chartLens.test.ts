/**
 * The chart lens: calibrating charts on other sites, checked on saved captures of real pages (test/fixtures/charts:
 * Google Finance's SVG chart, Yahoo Finance's and TradingView's canvas charts, captured 25 Sep 2026 with Chainlink's
 * TSLA prices of the same day) and on TradingView-like and Yahoo-like fixture pages. DOM-label calibration (known
 * answers), vision calibration from the models' saved real replies, the sanity check keeping good calibrations and
 * sending bad ones to the lens, marks following scroll and resize, the lens itself, and which stock and range a page
 * shows. jsdom has no layout, so boxes come from data-rect attributes. No network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartData } from "@glance/core/chart";
import type { ChartFacts } from "@glance/core/chart-facts";
import { calibrate, calibrationError, datedTimes, detectSymbol, fitLine, parsePrice, parseTimeLabel, parseVisionLabels, rangeFromButton, rangeFromSpan, sanityCheck, timeToPx, type AxisLabel, type Box, type Calibration } from "@glance/core/page-chart";

import { chartMarkGeometry, priceLookup } from "../lib/chartMarks";
import { ChartLens, LENS_LABEL } from "../lib/chartLens";
import { CALIBRATION_TTL_MS, clearCalibrations, preparePageChart, type LensFlowDeps } from "../lib/chartLensFlow";
import { pickPageChart, readDomLabels, wantsPageChart } from "../lib/pageChart";
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

describe("the flow: page chart, lens, or a question first", () => {
  beforeEach(clearCalibrations);
  const facts1D = { ...facts, range: "1D" as const };
  const deps = (over: Partial<LensFlowDeps> = {}) => {
    const lensAnnotate = vi.fn();
    const openLens = vi.fn(() => ({ annotate: lensAnnotate, clearAnnotations: vi.fn(), close: vi.fn() }) as unknown as ChartLens);
    const d: LensFlowDeps = {
      doc: document,
      win: window,
      symbols: ["TSLA", "AMD"],
      named: null,
      capture: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
      vision: vi.fn(async () => ({ labels: json<{ labels: unknown }>("tradingview.vision.claude-sonnet-4-5.json").labels })),
      chart: vi.fn(async () => chartData),
      facts: vi.fn(async () => facts1D),
      drawings: () => null,
      openLens,
      now: () => asOfOf("tradingview") * 1000,
      crop: vi.fn(async () => {
        const v = json<{ crop: Box; scale: number; width: number; height: number }>("tradingview.vision.claude-sonnet-4-5.json");
        return { base64: "BBBB", width: v.width, height: v.height, crop: v.crop, scale: v.scale, pixels: { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData };
      }),
      ...over,
    };
    return { d, openLens, lensAnnotate };
  };

  it("DOM labels that check out: drawn on the page's own chart, no screenshot taken", async () => {
    tradingViewLike();
    const { d, openLens } = deps();
    const got = await preparePageChart(d);
    expect(got).toMatchObject({ kind: "ready", symbol: "TSLA", range: "1D", drawOn: "page", method: "dom" });
    expect(d.capture).not.toHaveBeenCalled();
    expect(openLens).not.toHaveBeenCalled();
  });

  it("no DOM labels: a screenshot read by vision, fitted, and (the line not readable in this test) drawn on the page", async () => {
    tradingViewLike({ labels: false });
    const { d } = deps();
    const got = await preparePageChart(d);
    expect(d.vision).toHaveBeenCalledWith(expect.objectContaining({ base64: "BBBB" }));
    expect(got).toMatchObject({ kind: "ready", drawOn: "page", method: "vision" });
  });

  it("a bad calibration (Haiku's real reply): the Glance lens over the page's chart, and the marks go on it", async () => {
    tradingViewLike({ labels: false });
    const { d, openLens, lensAnnotate } = deps({ vision: vi.fn(async () => ({ labels: json<{ labels: unknown }>("tradingview.vision.claude-haiku-4-5.json").labels })) });
    // The page's line, as the pixel reader saw it on the real capture.
    const got = await preparePageChart({ ...d, readLine: () => lineOf("tradingview") });
    expect(got).toMatchObject({ kind: "ready", drawOn: "lens" });
    expect(openLens).toHaveBeenCalledWith(document.querySelector(".chart-container"), chartData);
    (got as { annotate(a: unknown): void }).annotate({ kind: "CHART_POINT", symbol: "TSLA", t: facts.high.t, at: 0 });
    expect(lensAnnotate).toHaveBeenCalledTimes(1);
  });

  it("no screenshot possible (no activeTab): ask for Option+G, and offer the lens", async () => {
    tradingViewLike({ labels: false });
    const { d } = deps({ capture: vi.fn(async () => null) });
    expect(await preparePageChart(d)).toEqual({ kind: "no-screenshot", symbol: "TSLA", range: "1D" });
    const { d: d2, openLens } = deps({ capture: vi.fn(async () => null) });
    expect(await preparePageChart(d2, { confirmed: { symbol: "TSLA", range: "1D" }, forceLens: true })).toMatchObject({ drawOn: "lens" });
    expect(openLens).toHaveBeenCalled();
  });

  it("the same chart asked about again within 10 minutes: the calibration is reused, no screenshot or vision call", async () => {
    tradingViewLike({ labels: false });
    let now = asOfOf("tradingview") * 1000;
    const { d } = deps({ now: () => now });
    expect(await preparePageChart(d)).toMatchObject({ drawOn: "page", method: "vision" });
    now += CALIBRATION_TTL_MS - 1_000;
    expect(await preparePageChart(d)).toMatchObject({ drawOn: "page", method: "vision" });
    expect(d.vision).toHaveBeenCalledTimes(1);
    expect(d.capture).toHaveBeenCalledTimes(1);
    // Ten minutes on: read again.
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

  it("the API's daily vision limit reached: the Glance lens, saying why", async () => {
    tradingViewLike({ labels: false });
    const { d, openLens } = deps({ vision: vi.fn(async () => ({ limit: "today's chart readings are used up" })) });
    expect(await preparePageChart(d)).toMatchObject({ kind: "ready", drawOn: "lens", reason: "today's chart readings are used up" });
    expect(openLens).toHaveBeenCalled();
  });

  it("unsure (a range Glance doesn't have, or no stock): one short question, nothing fetched", async () => {
    tradingViewLike({ selected: "6 months" });
    const { d } = deps();
    expect(await preparePageChart(d)).toEqual({ kind: "ask", question: "Glance can show 1 day, 5 days or 1 month. Which chart: TSLA 1 month?", symbol: "TSLA", range: "1W" });
    expect(d.chart).not.toHaveBeenCalled();
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

describe("the Glance lens", () => {
  it("sits exactly over the page's chart, says what it is, follows scroll, draws once its chart is up, and closes", async () => {
    tradingViewLike();
    const target = document.querySelector(".chart-container")!;
    const host = document.createElement("div");
    document.body.append(host);
    const annotate = vi.fn();
    let ready: (h: unknown) => void = () => {};
    const mount = vi.fn(() => new Promise((r) => (ready = r)));
    const onClose = vi.fn();
    const lens = new ChartLens(host, target, chartData, mount as never, onClose);
    expect([lens.root.style.left, lens.root.style.top, lens.root.style.width, lens.root.style.height]).toEqual(["32px", "522px", "1210px", "320px"]);
    expect(lens.root.textContent).toContain(LENS_LABEL);
    lens.annotate({ kind: "CHART_POINT", symbol: "TSLA", t: facts.high.t, at: 0 });
    ready({ annotate, clearAnnotations: vi.fn(), destroy: vi.fn(), update: vi.fn() });
    await Promise.resolve();
    expect(annotate).toHaveBeenCalledTimes(1);
    scrollY = 300;
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(lens.root.style.top).toBe("222px");
    (lens.root.querySelector("button[aria-label='Close the Glance lens']") as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalled();
    expect(host.contains(lens.root)).toBe(false);
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
    expect(["1D", "1 day", "5D", "5 days", "1M", "1 month", "6M", "YTD", "Max"].map(rangeFromButton)).toEqual(["1D", "1D", "1W", "1W", "1M", "1M", "other", "other", "other"]);
    expect([rangeFromSpan(20 * 3600), rangeFromSpan(5 * 86_400), rangeFromSpan(28 * 86_400), rangeFromSpan(180 * 86_400)]).toEqual(["1D", "1W", "1M", "other"]);
  });

  it("which questions are about a chart on the page", () => {
    for (const q of ["explain this chart", "show me the dip on this chart", "what happened here?", "what's this spike?"]) expect(wantsPageChart(q)).toBe(true);
    for (const q of ["how did Tesla do this week?", "what's this article saying?"]) expect(wantsPageChart(q)).toBe(false);
  });
});
