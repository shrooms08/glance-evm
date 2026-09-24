/**
 * The Prices page chart: draws the points (theme passed to the chart), the change coloured by direction, the range
 * buttons, and "No chart data yet." when there's nothing to draw. The chart library is faked.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChartData } from "@glance/core/chart";

import { PriceChartView } from "../components/PriceChart";

afterEach(cleanup);
const T = 1_790_000_000;
const data: ChartData = {
  symbol: "AMD",
  range: "1W",
  points: [
    { t: T - 86_400, price: 600, formatted: "$600" },
    { t: T - 60, price: 598.37, formatted: "$598.37" },
  ],
  source: { label: "Chainlink", detail: "RHAMD / USD, Robinhood Chain mainnet feed 0x943A" },
  lastUpdated: T - 60,
  asOf: T,
  marketState: "OPEN",
  markers: [],
};

describe("PriceChartView", () => {
  it("renders the points into the chart with the page's theme, and the change over the range", async () => {
    const mount = vi.fn(async () => ({ update: vi.fn(), destroy: vi.fn() }));
    render(<PriceChartView symbol="AMD" range="1W" onRange={() => {}} theme="light" loading={false} data={data} mount={mount} />);
    await act(async () => {});
    expect(mount).toHaveBeenCalledTimes(1);
    expect((mount.mock.calls[0] as unknown[])[1]).toBe(data);
    expect((mount.mock.calls[0] as unknown[])[2]).toEqual({ theme: "light" });
    expect(screen.getByText("$598.37")).toBeTruthy();
    const change = screen.getByTestId("chart-change");
    expect(change.textContent).toBe("-$1.63 (-0.27%) · 1W");
    expect(change.className).toContain("pnl-down");
    expect(screen.getByText(/Updates when Chainlink publishes a new price, not on every trade\./)).toBeTruthy();
  });

  it("range buttons switch the range", () => {
    const onRange = vi.fn();
    render(<PriceChartView symbol="AMD" range="1W" onRange={onRange} theme="dark" loading={false} data={data} mount={vi.fn(async () => ({ update: vi.fn(), destroy: vi.fn() }))} />);
    expect(screen.getByRole("tab", { name: "1W" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "1M" }));
    expect(onRange).toHaveBeenCalledWith("1M");
  });

  it("nothing to draw, or the API failed: 'No chart data yet.' and no canvas", () => {
    const mount = vi.fn();
    const { rerender } = render(<PriceChartView symbol="AMD" range="1D" onRange={() => {}} theme="dark" loading={false} data={{ ...data, points: [] }} mount={mount} />);
    expect(screen.getByText("No chart data yet.")).toBeTruthy();
    rerender(<PriceChartView symbol="AMD" range="1D" onRange={() => {}} theme="dark" loading={false} data={null} mount={mount} />);
    expect(screen.getByText("No chart data yet.")).toBeTruthy();
    expect(screen.queryByTestId("chart-canvas")).toBeNull();
    expect(mount).not.toHaveBeenCalled();
  });

  it("a chart that fails to draw falls back to the empty state, never a broken canvas", async () => {
    const mount = vi.fn(async () => Promise.reject(new Error("no canvas")));
    render(<PriceChartView symbol="AMD" range="1D" onRange={() => {}} theme="dark" loading={false} data={data} mount={mount} />);
    await act(async () => {});
    expect(screen.getByText("No chart data yet.")).toBeTruthy();
  });
});
