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
    const mount = vi.fn(async () => ({ update: vi.fn(), destroy: vi.fn() }));
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
    const handle = { update: vi.fn(), destroy: vi.fn() };
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
  function fakeLibrary() {
    const series = { setData: vi.fn() };
    const markers = { setMarkers: vi.fn() };
    let onMove: ((p: unknown) => void) | undefined;
    let onClick: ((p: unknown) => void) | undefined;
    const timeScale = {
      fitContent: vi.fn(),
      timeToCoordinate: (t: number) => (t - (T - 7_200)) / 10,
      width: () => 800,
      subscribeVisibleTimeRangeChange: vi.fn(),
      subscribeSizeChange: vi.fn(),
    };
    const api = {
      addSeries: vi.fn(() => series),
      timeScale: () => timeScale,
      subscribeCrosshairMove: (f: (p: unknown) => void) => (onMove = f),
      subscribeClick: (f: (p: unknown) => void) => (onClick = f),
      remove: vi.fn(),
    };
    const lib = {
      createChart: vi.fn(() => api),
      createSeriesMarkers: vi.fn(() => markers),
      AreaSeries: "Area",
      ColorType: { Solid: "solid" },
      CrosshairMode: { Normal: 0 },
      LineType: { WithSteps: 1 },
    };
    return { lib, series, markers, api, move: (p: unknown) => onMove!(p), click: (p: unknown) => onClick!(p) };
  }

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
