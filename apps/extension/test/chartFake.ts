/** A fake Lightweight Charts: records what the chart asks of it, for tests that have no canvas. */
import { vi } from "vitest";

export function makeFake(T: number) {
  let primitive: { paneViews(): Array<{ renderer(): { draw(t: unknown): void } | null }>; attached?(p: unknown): void } | null = null;
  const series = {
    setData: vi.fn(),
    attachPrimitive: vi.fn((p: typeof primitive) => {
      primitive = p;
      p?.attached?.({ requestUpdate: () => {} });
    }),
    createPriceLine: vi.fn((o: unknown) => o),
    removePriceLine: vi.fn(),
    priceToCoordinate: (p: number) => 400 - p,
  };
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
    LineStyle: { Dashed: 2 },
  };
  return { lib, series, markers, api, move: (p: unknown) => onMove!(p), click: (p: unknown) => onClick!(p), primitive: () => primitive };
}
