/**
 * The full price chart, drawn with TradingView Lightweight Charts (Apache-2.0, pinned; its attribution logo stays on,
 * as its license notice asks). The library is only ever loaded by `mountChart`, with a dynamic import, so a bundle that
 * never draws a full chart never contains it (the hover card's sparkline is plain SVG, from ./chart.ts).
 */
import { font } from "@glance/design";

import { chartColors, localTime, MARKET_CLOSED_LABEL, placeMarkers, toLineData, type ChartData, type ChartMarker } from "./chart.ts";
import type { ThemeName } from "@glance/design";

// ---------------------------------------------------------------------------------------------------------------------
// The full chart (Lightweight Charts, loaded on first use)
// ---------------------------------------------------------------------------------------------------------------------

export interface ChartHandle {
  update(data: ChartData): void;
  destroy(): void;
}

export interface MountOptions {
  theme: ThemeName;
  /** Opens a news source (defaults to window.open). */
  openUrl?(url: string): void;
  /** For tests: the library module to use instead of importing it. */
  library?: typeof import("lightweight-charts");
}

/**
 * Draws `data` into `el` (which must be sized by its container; the chart follows it). A price tooltip follows the
 * crosshair; a news dot shows its headline on hover and opens its source on click. When the market isn't open, the
 * stretch after the last published price is shaded and labelled "Market closed".
 */
export async function mountChart(el: HTMLElement, data: ChartData, opts: MountOptions): Promise<ChartHandle> {
  const lw = opts.library ?? (await import("lightweight-charts"));
  const c = chartColors(opts.theme);
  const doc = el.ownerDocument;
  el.style.position = "relative";
  const chart = lw.createChart(el, {
    autoSize: true,
    layout: { background: { type: lw.ColorType.Solid, color: c.background }, textColor: c.text, fontFamily: font.mono, fontSize: 11, attributionLogo: true },
    grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: lw.CrosshairMode.Normal, vertLine: { color: c.text, labelVisible: false }, horzLine: { color: c.text, labelBackgroundColor: c.line } },
    localization: { timeFormatter: (t: number) => localTime(t), priceFormatter: (p: number) => `$${p.toFixed(2)}` },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false, axisDoubleClickReset: true },
  });
  const series = chart.addSeries(lw.AreaSeries, {
    lineColor: c.line,
    topColor: c.fillTop,
    bottomColor: c.fillBottom,
    lineWidth: 2,
    lineType: lw.LineType.WithSteps,
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerRadius: 3,
    crosshairMarkerBorderColor: c.background,
    crosshairMarkerBackgroundColor: c.line,
  });
  const markersApi = lw.createSeriesMarkers(series, []);

  const tooltip = doc.createElement("div");
  tooltip.setAttribute("role", "status");
  Object.assign(tooltip.style, {
    position: "absolute",
    top: "6px",
    left: "8px",
    zIndex: "3",
    pointerEvents: "none",
    font: `11px ${font.mono}`,
    color: c.text,
    background: c.background,
    padding: "2px 6px",
    borderRadius: "6px",
    maxWidth: "70%",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const band = doc.createElement("div");
  Object.assign(band.style, {
    position: "absolute",
    top: "0",
    bottom: "26px",
    zIndex: "2",
    pointerEvents: "none",
    background: c.closedBand,
    display: "none",
    font: `10px ${font.mono}`,
    color: c.text,
    padding: "6px 6px 0",
    boxSizing: "border-box",
    textAlign: "right",
    overflow: "hidden",
    whiteSpace: "nowrap",
  } satisfies Partial<CSSStyleDeclaration>);
  band.textContent = MARKET_CLOSED_LABEL;
  el.append(tooltip, band);

  let current = data;
  let news: Array<Extract<ChartMarker, { kind: "news" }> & { at: number }> = [];

  const placeBand = () => {
    const last = current.points.length ? Math.max(...current.points.map((p) => p.t)) : null;
    if (current.marketState === "OPEN" || current.marketState === null || last === null || current.asOf <= last) {
      band.style.display = "none";
      return;
    }
    const x = chart.timeScale().timeToCoordinate(last as never);
    const right = chart.timeScale().width();
    if (x === null || x >= right) {
      band.style.display = "none";
      return;
    }
    Object.assign(band.style, { display: "block", left: `${x}px`, width: `${right - x}px` });
  };

  const draw = (d: ChartData) => {
    current = d;
    const line = toLineData(d.points, d.asOf);
    series.setData(line.map((p) => ({ time: p.time as never, value: p.value })));
    const placed = placeMarkers(d.markers, line);
    news = placed.filter((m): m is (typeof news)[number] => m.kind === "news");
    markersApi.setMarkers(
      placed.map((m) =>
        m.kind === "news"
          ? { time: m.at as never, position: "aboveBar" as const, shape: "circle" as const, color: c.news, size: 0.5 }
          : m.kind === "buy"
            ? { time: m.at as never, position: "belowBar" as const, shape: "arrowUp" as const, color: c.buy, size: 0.8 }
            : { time: m.at as never, position: "aboveBar" as const, shape: "arrowDown" as const, color: c.sell, size: 0.8 },
      ),
    );
    chart.timeScale().fitContent();
    requestAnimationFrame(placeBand);
  };

  /** The news marker nearest the crosshair's time, within 8px. */
  const newsAt = (x: number | undefined) => {
    if (x === undefined) return null;
    let best: (typeof news)[number] | null = null;
    let dist = 9;
    for (const n of news) {
      const nx = chart.timeScale().timeToCoordinate(n.at as never);
      if (nx !== null && Math.abs(nx - x) < dist) {
        dist = Math.abs(nx - x);
        best = n;
      }
    }
    return best;
  };

  chart.subscribeCrosshairMove((param) => {
    const value = param.time !== undefined ? (param.seriesData.get(series) as { value?: number } | undefined)?.value : undefined;
    if (value === undefined || param.point === undefined) {
      tooltip.style.display = "none";
      el.style.cursor = "";
      return;
    }
    const hovered = newsAt(param.point.x);
    tooltip.textContent = hovered ? `${hovered.title} · ${hovered.site}` : `$${value.toFixed(2)} · ${localTime(param.time as number)}`;
    tooltip.style.display = "block";
    el.style.cursor = hovered ? "pointer" : "";
  });
  chart.subscribeClick((param) => {
    const hit = newsAt(param.point?.x);
    if (hit) (opts.openUrl ?? ((u: string) => doc.defaultView?.open(u, "_blank", "noopener,noreferrer")))(hit.url);
  });
  chart.timeScale().subscribeVisibleTimeRangeChange(placeBand);
  chart.timeScale().subscribeSizeChange(placeBand);

  draw(data);
  return {
    update: draw,
    destroy() {
      chart.remove();
      tooltip.remove();
      band.remove();
    },
  };
}
