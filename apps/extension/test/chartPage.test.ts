// @vitest-environment-options {"url": "https://www.tradingview.com/chart/?symbol=NASDAQ%3ATSLA"}
/**
 * TradingView's full chart page (tradingview.com/chart/...): the symbol, range and interval read from its own
 * controls (fixtures captured from the live page, 3 Oct 2026, with 5D, 1M and no range selected); with no range
 * selected, one question with range buttons, its answer used at once and remembered for this chart; the panes traced
 * with the chart page's options and fitted to the market's candles. The symbol pages' path is in chartLens.test.ts and
 * unchanged.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Box } from "@glance/core/page-chart";

import { fitTrace, traceSeries, type Pixels } from "../lib/canvasTrace";
import { ChartAnswers, chartAskKey, RANGE_BUTTON, RANGE_CHOICES, rangeFromAnswer, rangeQuestion } from "../lib/chartAsk";
import { preparePageChart, type LensFlowDeps } from "../lib/chartLensFlow";
import { isTradingViewChartPage, pickPageChart, readTradingViewChart } from "../lib/pageChart";

const DIR = resolve(import.meta.dirname, "fixtures/charts");
const CHART_URL = "/chart/?symbol=NASDAQ%3ATSLA";

/** The captured controls, plus the chart's pane (a canvas the size of the live one) laid out with data-rect. */
function chartPage(which: "5d" | "1m" | "none") {
  document.body.innerHTML = `${readFileSync(`${DIR}/tradingview-chart-page-${which}.html`, "utf8")}
    <div class="chart-container" data-rect="56,42,964,791"><canvas width="964" height="791" data-rect="56,42,964,791"></canvas></div>`;
  document.title = "TSLA 370.59 ▲ +4.65%";
}

const rectOf = (el: Element | null): DOMRect => {
  const r = el?.getAttribute("data-rect")?.split(",").map(Number);
  const [x, y, w, h] = r && r.length === 4 ? r : [0, 0, 0, 0];
  return { x: x!, y: y!, left: x!, top: y!, width: w!, height: h!, right: x! + w!, bottom: y! + h!, toJSON: () => ({}) } as DOMRect;
};
beforeEach(() => {
  history.replaceState({}, "", CHART_URL);
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rectOf(this);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.title = "";
});

describe("which page", () => {
  it("the full chart page only: never the symbol pages, never another site", () => {
    expect(isTradingViewChartPage({ hostname: "www.tradingview.com", pathname: "/chart/" })).toBe(true);
    expect(isTradingViewChartPage({ hostname: "www.tradingview.com", pathname: "/chart/aBc123/" })).toBe(true);
    expect(isTradingViewChartPage({ hostname: "uk.tradingview.com", pathname: "/chart/" })).toBe(true);
    expect(isTradingViewChartPage({ hostname: "www.tradingview.com", pathname: "/symbols/NASDAQ-TSLA/" })).toBe(false);
    expect(isTradingViewChartPage({ hostname: "finance.yahoo.com", pathname: "/chart/TSLA" })).toBe(false);
    expect(isTradingViewChartPage({ hostname: "localhost", pathname: "/chart/" })).toBe(false);
  });
});

describe("reading the chart page's own controls (live captures)", () => {
  it.each([
    ["5d", "1W", "5 minutes"],
    ["1m", "1M", "30 minutes"],
    ["none", null, "1 day"],
  ] as const)("%s selected: range %s, interval %s, symbol from the URL", (which, range, interval) => {
    chartPage(which);
    expect(readTradingViewChart(document)).toEqual({ symbol: "TSLA", range, interval });
  });

  it("every tab of the range bar maps to its range (1Y is 12M, 5Y is 60M on TradingView)", () => {
    chartPage("none");
    const tabs = [...document.querySelectorAll("[data-name^='date-range-tab-']")];
    const read = tabs.map((t) => {
      tabs.forEach((x) => x.classList.remove("isActive-zm3YRUFG"));
      t.classList.add("isActive-zm3YRUFG");
      return [t.textContent, readTradingViewChart(document).range];
    });
    expect(read).toEqual([
      ["1D", "1D"],
      ["5D", "1W"],
      ["1M", "1M"],
      ["3M", "3M"],
      ["6M", "6M"],
      ["YTD", "YTD"],
      ["1Y", "1Y"],
      ["5Y", "5Y"],
      ["All", "ALL"],
    ]);
  });

  it("a tab marked by aria state counts too", () => {
    chartPage("none");
    document.querySelector("[data-name='date-range-tab-3M']")!.setAttribute("aria-pressed", "true");
    expect(readTradingViewChart(document).range).toBe("3M");
  });

  it("no ?symbol= in the URL (a saved layout): the toolbar's symbol button", () => {
    history.replaceState({}, "", "/chart/aBc123/");
    chartPage("5d");
    expect(readTradingViewChart(document).symbol).toBe("TSLA");
  });

  it("the chart page's target: sure with a range selected, asks for the range without one", () => {
    chartPage("5d");
    expect(pickPageChart(document, window, ["TSLA"], null)).toMatchObject({ symbol: "TSLA", range: "1W", unsure: null, site: "tradingview", chartPage: { interval: "5 minutes", rangeRead: "1W" } });
    chartPage("none");
    expect(pickPageChart(document, window, ["TSLA"], null)).toMatchObject({ symbol: "TSLA", range: null, unsure: "Which range is this TSLA chart showing?", chartPage: { rangeRead: null } });
  });

  it("the question naming another stock than the chart's still asks (never AMD's marks on TSLA)", () => {
    chartPage("5d");
    expect(pickPageChart(document, window, ["TSLA", "AMD"], "AMD")).toMatchObject({ symbol: "TSLA", unsure: "This chart looks like TSLA. Which chart: TSLA 5 days?" });
  });
});

describe("asked once, with range buttons", () => {
  function deps(answers = new ChartAnswers()) {
    const d: LensFlowDeps = {
      doc: document,
      win: window,
      symbols: ["TSLA"],
      named: null,
      capture: vi.fn(async () => null),
      vision: vi.fn(async () => null),
      facts: vi.fn(async () => null),
      // No candles here: past the question, the flow stops at "unavailable" (what was fetched shows the range used).
      marketCandles: vi.fn(async () => null),
      openLayer: vi.fn(),
      answers,
    };
    return d;
  }

  it("no range selected: one question, the six ranges as buttons, nothing fetched", async () => {
    chartPage("none");
    const d = deps();
    const prep = await preparePageChart(d);
    expect(prep).toMatchObject({ kind: "ask", question: "Which range is this TSLA chart showing?", symbol: "TSLA", choices: ["1D", "1W", "1M", "3M", "6M", "1Y"], key: chartAskKey(location.href, "TSLA", null) });
    expect(RANGE_CHOICES.map((r) => RANGE_BUTTON[r])).toEqual(["1D", "5D", "1M", "3M", "6M", "1Y"]);
    expect(d.marketCandles).not.toHaveBeenCalled();
  });

  it("the answer is used for this request at once (no second question)", async () => {
    chartPage("none");
    const d = deps();
    expect((await preparePageChart(d, { confirmed: { symbol: "TSLA", range: "6M" } })).kind).toBe("unavailable");
    expect(d.marketCandles).toHaveBeenCalledWith("TSLA", "6M", {});
  });

  it("remembered for this chart: the next question isn't asked again", async () => {
    chartPage("none");
    const answers = new ChartAnswers();
    const d = deps(answers);
    const first = await preparePageChart(d);
    if (first.kind !== "ask" || !first.key) throw new Error("expected the question");
    answers.set(first.key, { symbol: "TSLA", range: "1M" });
    const next = await preparePageChart(d);
    expect(next.kind).not.toBe("ask");
    expect(d.marketCandles).toHaveBeenCalledWith("TSLA", "1M", {});
  });

  it("asked again only when the chart changes: another symbol in the URL, or a range now selected on the page", async () => {
    chartPage("none");
    const answers = new ChartAnswers();
    answers.set(chartAskKey(location.href, "TSLA", null), { symbol: "TSLA", range: "1M" });
    history.replaceState({}, "", "/chart/?symbol=NASDAQ%3ANVDA");
    expect(await preparePageChart({ ...deps(answers), symbols: ["TSLA", "NVDA"] })).toMatchObject({ kind: "ask", symbol: "NVDA" });
    // Back on TSLA with 5D selected: read from the page, nothing asked.
    history.replaceState({}, "", CHART_URL);
    chartPage("5d");
    const d = deps(answers);
    expect((await preparePageChart(d)).kind).not.toBe("ask");
    expect(d.marketCandles).toHaveBeenCalledWith("TSLA", "1W", {});
  });

  it.each([
    ["five days", "1W"],
    ["5 days", "1W"],
    ["5D", "1W"],
    ["one day", "1D"],
    ["1D", "1D"],
    ["one month", "1M"],
    ["1 month.", "1M"],
    ["three months", "3M"],
    ["6M", "6M"],
    ["six months", "6M"],
    ["one year", "1Y"],
    ["a year", "1Y"],
    ["1Y", "1Y"],
  ] as const)("said or typed: %s is %s", (said, range) => {
    expect(rangeFromAnswer(said)).toBe(range);
  });

  it("anything else isn't an answer (it goes on as a question)", () => {
    for (const said of ["explain this chart", "buy ten dollars of tesla", "yes", "four days", "two weeks"]) expect(rangeFromAnswer(said), said).toBeNull();
  });

  it("the question has no dashes", () => {
    expect(rangeQuestion("TSLA") + rangeQuestion(null)).not.toMatch(/[‒-―]/);
  });
});

describe("the chart page's panes, traced and fitted (live captures, volume in the pane)", () => {
  function pane(name: string): { pixels: Pixels; meta: { dpr: number; pane: Box; candles: Array<{ t: number; price: number }> } } {
    const meta = JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8")) as { width: number; height: number; dpr: number; pane: Box; candles: Array<{ t: number; price: number }> };
    return { pixels: { width: meta.width, height: meta.height, data: new Uint8ClampedArray(gunzipSync(readFileSync(`${DIR}/${name}.rgba.gz`))) }, meta };
  }
  const fitWith = (name: string, opts: Parameters<typeof traceSeries>[2]) => {
    const { pixels, meta } = pane(name);
    const trace = traceSeries(pixels, meta.dpr, opts);
    if (!trace) return null;
    return { trace, fit: fitTrace(trace.points.map((p) => ({ x: meta.pane.x + p.x / meta.dpr, y: meta.pane.y + p.y / meta.dpr })), meta.candles, meta.pane) };
  };

  it("5D (5 minute candles, a few px wide): traced per column, R^2 >= 0.99 and the range within 3%", () => {
    const r = fitWith("tv-chart-tsla-1W", { chartPage: true, perColumn: true })!;
    expect(r.trace.kind).toBe("candles");
    expect(r.fit.ok, r.fit.reason).toBe(true);
    expect(r.fit.r2).toBeGreaterThanOrEqual(0.99);
    expect(r.fit.rangeError).toBeLessThanOrEqual(0.03);
  });

  it("1M (30 minute candles): traced per candle, R^2 >= 0.99 and the range within 3%", () => {
    const r = fitWith("tv-chart-tsla-1M", { chartPage: true })!;
    expect(r.fit.ok, r.fit.reason).toBe(true);
    expect(r.fit.r2).toBeGreaterThanOrEqual(0.99);
    expect(r.fit.rangeError).toBeLessThanOrEqual(0.03);
  });

  it("the bug: without the chart page's options the 5D pane doesn't line up (the price line and the earnings marker)", () => {
    expect(fitWith("tv-chart-tsla-1W", {})!.fit.ok).toBe(false);
  });
});
