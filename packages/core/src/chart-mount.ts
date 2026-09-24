/**
 * The full price chart, drawn with TradingView Lightweight Charts (Apache-2.0, pinned; its attribution logo stays on,
 * as its license notice asks). The library is only ever loaded by `mountChart`, with a dynamic import, so a bundle that
 * never draws a full chart never contains it (the hover card's sparkline is plain SVG, from ./chart.ts).
 */
import { font } from "@glance/design";

import { chartColors, localTime, MARKET_CLOSED_LABEL, placeMarkers, toLineData, type ChartData, type ChartMarker } from "./chart.ts";
import type { ChartAnnotation } from "./showme.ts";

/** How long a drawing takes to draw in. */
export const ANNOTATION_MS = 550;
import type { ThemeName } from "@glance/design";

// ---------------------------------------------------------------------------------------------------------------------
// The full chart (Lightweight Charts, loaded on first use)
// ---------------------------------------------------------------------------------------------------------------------

export interface ChartHandle {
  update(data: ChartData): void;
  /** Show me's drawings on this chart (drawn in, each with a short animation). */
  annotate(annotations: readonly ChartAnnotation[]): void;
  clearAnnotations(): void;
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

  // ---- Show me's drawings: levels as the library's own dashed price lines; points, bands and trend lines through one
  // series primitive (drawn in media coordinates, animated in).
  let levels: Array<ReturnType<typeof series.createPriceLine>> = [];
  const shapes: Array<{ a: ChartAnnotation; born: number }> = [];
  let requestUpdate: (() => void) | null = null;
  let anim = 0;
  const priceAt = (t: number) => {
    const line = toLineData(current.points, current.asOf);
    let best = line[0];
    for (const p of line) if (best && Math.abs(p.time - t) < Math.abs(best.time - t)) best = p;
    return best?.value ?? null;
  };
  const now = () => (doc.defaultView?.performance ?? performance).now();
  const tick = () => {
    requestUpdate?.();
    if (shapes.some((s) => now() - s.born < ANNOTATION_MS)) anim = (doc.defaultView ?? window).requestAnimationFrame(tick);
    else anim = 0;
  };
  const primitive = {
    attached(p: { requestUpdate: () => void }) {
      requestUpdate = p.requestUpdate;
    },
    detached() {
      requestUpdate = null;
    },
    updateAllViews() {},
    paneViews() {
      return [
        {
          zOrder: () => "top" as const,
          renderer: () => ({
            draw(target: { useMediaCoordinateSpace<T>(f: (s: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => T): T }) {
              target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
                const ts = chart.timeScale();
                for (const { a, born } of shapes) {
                  const k = Math.min(1, (now() - born) / ANNOTATION_MS);
                  const ease = 1 - (1 - k) ** 3;
                  ctx.save();
                  if (a.kind === "CHART_RANGE") {
                    const x1 = ts.timeToCoordinate(a.t1 as never);
                    const x2 = ts.timeToCoordinate(a.t2 as never);
                    if (x1 !== null && x2 !== null) {
                      ctx.fillStyle = c.band;
                      ctx.fillRect(x1, 0, (x2 - x1) * ease, mediaSize.height);
                    }
                  } else if (a.kind === "CHART_TREND") {
                    const x1 = ts.timeToCoordinate(a.t1 as never);
                    const x2 = ts.timeToCoordinate(a.t2 as never);
                    const p1 = priceAt(a.t1);
                    const p2 = priceAt(a.t2);
                    const y1 = p1 === null ? null : series.priceToCoordinate(p1);
                    const y2 = p2 === null ? null : series.priceToCoordinate(p2);
                    if (x1 !== null && x2 !== null && y1 !== null && y2 !== null) {
                      ctx.strokeStyle = c.line;
                      ctx.lineWidth = 2;
                      ctx.lineCap = "round";
                      ctx.beginPath();
                      ctx.moveTo(x1, y1);
                      ctx.lineTo(x1 + (x2 - x1) * ease, y1 + (y2 - y1) * ease);
                      ctx.stroke();
                    }
                  } else if (a.kind === "CHART_POINT") {
                    const x = ts.timeToCoordinate(a.t as never);
                    const p = priceAt(a.t);
                    const y = p === null ? null : series.priceToCoordinate(p);
                    if (x !== null && y !== null) {
                      // A hand-drawn loop: a slightly oval circle that overshoots its start.
                      ctx.strokeStyle = c.line;
                      ctx.lineWidth = 2.2;
                      ctx.lineCap = "round";
                      ctx.beginPath();
                      const start = -Math.PI / 2 - 0.3;
                      ctx.ellipse(x, y, 11, 9, 0.2, start, start + (Math.PI * 2 + 0.4) * ease);
                      ctx.stroke();
                    }
                  }
                  ctx.restore();
                }
              });
            },
          }),
        },
      ];
    },
  };
  series.attachPrimitive(primitive as never);

  const annotate = (list: readonly ChartAnnotation[]) => {
    for (const a of list) {
      if (a.kind === "CHART_LEVEL") {
        levels.push(series.createPriceLine({ price: a.price, color: c.line, lineWidth: 1, lineStyle: lw.LineStyle.Dashed, axisLabelVisible: true, title: a.label }));
      } else shapes.push({ a, born: now() });
    }
    if (!anim) anim = (doc.defaultView ?? window).requestAnimationFrame(tick);
  };
  const clearAnnotations = () => {
    for (const l of levels) series.removePriceLine(l);
    levels = [];
    shapes.length = 0;
    requestUpdate?.();
  };

  draw(data);
  return {
    update: draw,
    annotate,
    clearAnnotations,
    destroy() {
      if (anim) (doc.defaultView ?? window).cancelAnimationFrame(anim);
      chart.remove();
      tooltip.remove();
      band.remove();
    },
  };
}
