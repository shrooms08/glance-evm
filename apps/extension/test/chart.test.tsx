/**
 * Price charts in the extension: the side panel's chart (points drawn, the empty state, range switching, the change
 * header), marker placement on the chart (buys up, sells down, news dots with their headline), the hover card's
 * sparkline (cached 60s per symbol), and "show me Tesla's chart". The API and the chart library are faked.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChartData } from "@glance/core/chart";
import { placeMarkers, rangeChange, sparklinePath, toLineData } from "@glance/core/chart";
import { mountChart } from "@glance/core/chart-mount";

const chart = vi.fn();
vi.mock("../lib/api", () => ({ api: { chart: (...a: unknown[]) => chart(...a) } }));
vi.mock("../components/context", () => ({
  useGlance: () => ({ catalog: [{ symbol: "TSLA", name: "Tesla" }], vaultAddress: "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113" }),
}));

import StockChart from "../components/StockChart";
import { makeFake } from "./chartFake";
import { clearSparklineCache, sparklineData, SPARKLINE_TTL_MS } from "../components/Sparkline";
import { parseCommand } from "../lib/commands";

const T = 1_790_000_000;
const data = (over: Partial<ChartData> = {}): ChartData => ({
  symbol: "TSLA",
  range: "1D",
  points: [
    { t: T - 7_200, price: 370, formatted: "$370" },
    { t: T - 3_600, price: 375.81, formatted: "$375.81" },
  ],
  source: { label: "Chainlink", detail: "RHTSLA / USD, Robinhood Chain mainnet feed 0x4A11" },
  lastUpdated: T - 3_600,
  asOf: T,
  marketState: "CLOSED",
  markers: [
    { kind: "buy", t: T - 5_000, amount: "$10", price: "$372", txHash: "0x1", explorerUrl: null },
    { kind: "sell", t: T - 3_000, amount: "$5", price: "$376", txHash: "0x2", explorerUrl: null },
    { kind: "news", t: T - 3_500, title: "Tesla deliveries beat", url: "https://news.example/a", site: "Example" },
  ],
  ...over,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  chart.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("side panel chart", () => {
  it("draws the points, with the price, the change over the range and the Chainlink note", async () => {
    chart.mockResolvedValue({ ok: true, data: data() });
    const mount = vi.fn(async () => ({ update: vi.fn(), destroy: vi.fn(), annotate: vi.fn(), clearAnnotations: vi.fn() }));
    await act(async () => root.render(createElement(StockChart, { symbol: "TSLA", mount })));
    await flush();
    expect(chart).toHaveBeenCalledWith("TSLA", "1D", "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113");
    expect(mount).toHaveBeenCalledTimes(1);
    expect((mount.mock.calls[0] as unknown[])[1]).toMatchObject({ points: data().points });
    expect(host.textContent).toContain("$375.81");
    const change = host.querySelector('[data-testid="chart-change"]')!;
    expect(change.textContent).toBe("+$5.81 (+1.57%) · 1D");
    expect(change.className).toContain("g-up");
    expect(host.textContent).toContain("Updates when Chainlink publishes a new price, not on every trade.");
  });

  it("switching the range reloads and updates the same chart in place", async () => {
    chart.mockResolvedValue({ ok: true, data: data() });
    const handle = { update: vi.fn(), destroy: vi.fn(), annotate: vi.fn(), clearAnnotations: vi.fn() };
    const mount = vi.fn(async () => handle);
    await act(async () => root.render(createElement(StockChart, { symbol: "TSLA", mount })));
    await flush();
    const down = data({ range: "1W", points: [{ t: T - 86_400, price: 400, formatted: "$400" }, { t: T - 60, price: 380, formatted: "$380" }] });
    chart.mockResolvedValue({ ok: true, data: down });
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "1W")!;
    await act(async () => tab.click());
    await flush();
    expect(chart).toHaveBeenLastCalledWith("TSLA", "1W", expect.any(String));
    expect(tab.getAttribute("aria-selected")).toBe("true");
    // While loading, the old canvas is replaced by a skeleton; the new data mounts or updates the chart.
    expect(mount.mock.calls.length + handle.update.mock.calls.length).toBeGreaterThanOrEqual(2);
    const change = host.querySelector('[data-testid="chart-change"]')!;
    expect(change.textContent).toBe("-$20.00 (-5.00%) · 1W");
    expect(change.className).toContain("g-down");
  });

  it("no points, or an error: 'No chart data yet.', and no canvas", async () => {
    const mount = vi.fn();
    chart.mockResolvedValue({ ok: true, data: data({ points: [] }) });
    await act(async () => root.render(createElement(StockChart, { symbol: "TSLA", mount })));
    await flush();
    expect(host.textContent).toContain("No chart data yet.");
    expect(host.querySelector('[data-testid="chart-canvas"]')).toBeNull();
    chart.mockResolvedValue({ ok: false, message: "down" });
    await act(async () => root.render(createElement(StockChart, { symbol: "AMD", mount })));
    await flush();
    expect(host.textContent).toContain("No chart data yet.");
    expect(mount).not.toHaveBeenCalled();
  });
});

describe("the chart itself (a fake Lightweight Charts)", () => {
  const fakeLibrary = () => makeFake(T);

  it("draws a stepped line carried to now, keeps the attribution, and places buys, sells and news", async () => {
    const f = fakeLibrary();
    const el = document.createElement("div");
    document.body.append(el);
    const opened: string[] = [];
    await mountChart(el, data(), { theme: "dark", library: f.lib as never, openUrl: (u) => opened.push(u) });
    const options = (f.lib.createChart.mock.calls[0] as unknown[])[1] as { layout: { attributionLogo: boolean; background: { color: string } } };
    expect(options.layout.attributionLogo).toBe(true);
    expect(options.layout.background.color).toBe("#000000");
    expect((f.api.addSeries.mock.calls[0] as unknown[])[1]).toMatchObject({ lineType: 1, lineColor: "#C4F135" });
    expect(f.series.setData).toHaveBeenCalledWith([
      { time: T - 7_200, value: 370 },
      { time: T - 3_600, value: 375.81 },
      { time: T, value: 375.81 },
    ]);
    const placed = f.markers.setMarkers.mock.calls.at(-1)![0] as Array<{ time: number; shape: string; position: string }>;
    expect(placed).toHaveLength(3);
    expect(placed[0]).toEqual(expect.objectContaining({ time: T - 7_200, shape: "arrowUp", position: "belowBar" }));
    expect(placed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ time: T - 3_600, shape: "circle" }), // news at T-3500: on the price standing then
        expect.objectContaining({ time: T - 3_600, shape: "arrowDown", position: "aboveBar" }),
      ]),
    );
    // Hovering the news dot shows its headline; clicking it opens the source.
    const newsX = (T - 3_600 - (T - 7_200)) / 10;
    f.move({ time: T - 3_600, point: { x: newsX, y: 10 }, seriesData: new Map([[f.series, { value: 375.81 }]]) });
    expect(el.textContent).toContain("Tesla deliveries beat · Example");
    f.click({ point: { x: newsX, y: 10 } });
    expect(opened).toEqual(["https://news.example/a"]);
    // Anywhere else: the price and the local time, and a click opens nothing.
    f.move({ time: T - 7_200, point: { x: 0, y: 10 }, seriesData: new Map([[f.series, { value: 370 }]]) });
    expect(el.textContent).toContain("$370.00 · ");
    f.click({ point: { x: 0, y: 10 } });
    expect(opened).toHaveLength(1);
  });

  it("marker placement: each marker sits on the price that stood when it happened", () => {
    const line = toLineData(data().points, T);
    expect(placeMarkers([{ t: T - 5_000 }, { t: T - 10 }, { t: T - 99_999 }], line).map((m) => m.at)).toEqual([T - 7_200, T - 3_600]);
    expect(rangeChange([data().points[0]!])).toBeNull();
    expect(sparklinePath(data().points, 100, 20)).toMatch(/^M2\.0,18\.0H98\.0V2\.0$/);
  });
});

describe("Show me drawings on the chart", () => {
  it("a level is the library's dashed price line with its label; points, bands and trends draw through the primitive", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const fake = makeFake(T);
    const h = await mountChart(el, data(), { theme: "dark", library: fake.lib as never });
    h.annotate([
      { kind: "CHART_LEVEL", symbol: "TSLA", price: 370, label: "Week low $370", at: 0 },
      { kind: "CHART_RANGE", symbol: "TSLA", t1: T - 7_200, t2: T - 3_600, at: 0 },
      { kind: "CHART_POINT", symbol: "TSLA", t: T - 3_600, at: 0 },
      { kind: "CHART_TREND", symbol: "TSLA", t1: T - 7_200, t2: T - 3_600, at: 0 },
    ]);
    expect(fake.series.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 370, title: "Week low $370", lineStyle: 2, color: "#C4F135" }));
    // The primitive draws the band, the circle and the line (a fake canvas records the calls).
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (typeof k === "string" && !["fillStyle", "strokeStyle", "lineWidth", "lineCap"].includes(k) ? (..._a: unknown[]) => calls.push(k) : undefined), set: () => true });
    fake.primitive()!.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (fn: (s: unknown) => void) => fn({ context: ctx, mediaSize: { width: 800, height: 300 } }) });
    expect(calls).toEqual(expect.arrayContaining(["fillRect", "ellipse", "lineTo"]));
    h.clearAnnotations();
    expect(fake.series.removePriceLine).toHaveBeenCalledTimes(1);
  });
});

describe("hover card sparkline", () => {
  beforeEach(() => clearSparklineCache());
  it("loads 1D once per symbol for 60 seconds", async () => {
    chart.mockResolvedValue({ ok: true, data: data() });
    await sparklineData("TSLA", T * 1000);
    await sparklineData("TSLA", T * 1000 + SPARKLINE_TTL_MS - 1);
    expect(chart).toHaveBeenCalledTimes(1);
    expect(chart).toHaveBeenCalledWith("TSLA", "1D");
    await sparklineData("TSLA", T * 1000 + SPARKLINE_TTL_MS + 1);
    expect(chart).toHaveBeenCalledTimes(2);
  });
});

describe("typed chart commands", () => {
  const companies = [
    { symbol: "TSLA", aliases: ["Tesla", "Tesla Inc"] },
    { symbol: "AMD", aliases: ["AMD", "Advanced Micro Devices"] },
    { symbol: "PLTR", aliases: ["Palantir"] },
  ];
  it.each([
    ["show me Tesla's chart", "TSLA"],
    ["chart AMD", "AMD"],
    ["open the Palantir chart", "PLTR"],
    ["Tesla price chart", "TSLA"],
  ])("%s -> chart %s", (said, symbol) => {
    expect(parseCommand(said, companies)).toEqual({ kind: "chart", symbol });
  });
});
