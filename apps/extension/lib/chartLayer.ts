/**
 * The annotation layer: Glance's marks drawn ON the page's own chart, which stays visible underneath. One transparent
 * SVG pinned to the chart's box (pointer-events none, above the page), re-placed on scroll, resize and layout changes
 * (a ResizeObserver on the chart, and scroll and resize listeners), in the chart's calibrated scale.
 *
 *   CHART_LEVEL   a horizontal line across the plot (support, resistance, a high or a low) with its label
 *   CHART_TREND   a line between two prices, with an arrow at the end (the direction)
 *   CHART_POINT   a circle on a price (a bounce, the high, the low) with a small label
 *   CHART_RANGE   a shaded box: that stretch of time, from its low to its high (a range, a consolidation)
 *
 * Every time and price is one of Glance's computed facts; the model only chose which to mention. Marks appear one by
 * one: as their sentence reaches them, and never closer than 400ms apart. Glance lime with a thin dark outline, so
 * they read on light and dark charts. They stay until Escape, the layer's x, the next chart question, navigation, or
 * the page's range changing (the page's chart is then a different chart).
 */
import { color } from "@glance/design";
import { priceToPx, timeToPx, type Box, type Calibration } from "@glance/core/page-chart";
import type { ChartAnnotation } from "@glance/core/showme";

const SVG = "http://www.w3.org/2000/svg";
/** Marks never appear closer together than this. */
export const MARK_GAP_MS = 400;
const OUTLINE = color.canvas;
const MARK = color.lime;

/** A mark's shapes, in the chart box's coordinates (0,0 is the chart's top-left when it was calibrated). */
export type MarkShape =
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; dashed?: boolean }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "polygon"; points: Array<[number, number]> }
  | { kind: "text"; x: number; y: number; text: string; anchor: "start" | "end" | "middle" };

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Where a chart tag goes, in the chart box's coordinates: the calibration maps the fact's time and price to page px (as
 * they were at calibration), minus the box's corner. Null when it would fall outside the plot (never guessed).
 */
export function markShapes(
  a: ChartAnnotation,
  c: Calibration,
  at: Box,
  priceAt: (t: number) => number | null,
  pricesBetween: (t1: number, t2: number) => number[],
): MarkShape[] | null {
  const bx = (x: number) => x - at.x;
  const by = (y: number) => y - at.y;
  const plot = { x0: bx(c.plot.x), y0: by(c.plot.y), x1: bx(c.plot.x + c.plot.width), y1: by(c.plot.y + c.plot.height) };
  const inX = (x: number) => x >= plot.x0 - 2 && x <= plot.x1 + 2;
  const inY = (y: number) => y >= plot.y0 - 2 && y <= plot.y1 + 2;
  const X = (t: number) => bx(timeToPx(c.time, t));
  const Y = (p: number) => by(priceToPx(c.price, p));
  switch (a.kind) {
    case "CHART_POINT": {
      const price = priceAt(a.t);
      if (price === null) return null;
      const x = X(a.t);
      const y = Y(price);
      if (!inX(x) || !inY(y)) return null;
      const above = y - plot.y0 > 26;
      return [
        { kind: "circle", cx: x, cy: y, r: 9 },
        { kind: "text", x, y: above ? y - 15 : y + 24, text: usd(price), anchor: "middle" },
      ];
    }
    case "CHART_LEVEL": {
      const y = Y(a.price);
      if (!inY(y)) return null;
      return [
        { kind: "line", x1: plot.x0, y1: y, x2: plot.x1, y2: y, dashed: true },
        { kind: "text", x: plot.x1 - 6, y: y - 6, text: a.label || usd(a.price), anchor: "end" },
      ];
    }
    case "CHART_TREND": {
      const p1 = priceAt(a.t1);
      const p2 = priceAt(a.t2);
      if (p1 === null || p2 === null) return null;
      const [x1, y1, x2, y2] = [X(a.t1), Y(p1), X(a.t2), Y(p2)];
      if (!inX(x1) || !inX(x2) || !inY(y1) || !inY(y2)) return null;
      // The arrowhead at the end: the line's direction.
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = (d: number) => [x2 - 11 * Math.cos(ang + d), y2 - 11 * Math.sin(ang + d)] as [number, number];
      return [
        { kind: "line", x1, y1, x2, y2 },
        { kind: "polygon", points: [[x2, y2], head(0.45), head(-0.45)] },
      ];
    }
    case "CHART_RANGE": {
      const prices = pricesBetween(a.t1, a.t2);
      const xa = Math.max(plot.x0, X(a.t1));
      const xb = Math.min(plot.x1, X(a.t2));
      // A box around (nearly) the whole chart marks nothing: skipped.
      if (xb - xa < 2 || xb - xa > (plot.x1 - plot.x0) * 0.8) return null;
      const ya = prices.length ? Math.max(plot.y0, Y(Math.max(...prices))) : plot.y0;
      const yb = prices.length ? Math.min(plot.y1, Y(Math.min(...prices))) : plot.y1;
      const pad = 3;
      return [
        {
          kind: "polygon",
          points: [
            [xa, ya - pad],
            [xb, ya - pad],
            [xb, yb + pad],
            [xa, yb + pad],
          ],
        },
      ];
    }
  }
}

export interface LayerOptions {
  win?: Window;
  onClose?(): void;
  /** The "Show calibration points" dots (Settings, Developer): where the fit puts each candle's close, in page px. */
  dots?: ReadonlyArray<{ x: number; y: number }> | null;
  /** The page's range now: when it differs from `range`, the marks are for another chart and go. */
  rangeNow?(): string | null;
  range?: string;
  now?(): number;
}

export class ChartLayer {
  readonly root: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly win: Window;
  private readonly observer: ResizeObserver | null;
  private readonly timer: number;
  private queue: ChartAnnotation[] = [];
  private lastDrawn = -Infinity;
  private drain: number | null = null;
  private closed = false;
  private readonly href: string;
  /** How many marks are on the chart. */
  drawn = 0;
  private readonly onMove = () => this.place();

  constructor(
    host: Element,
    private readonly target: Element,
    private readonly cal: Calibration,
    private readonly at: Box,
    private readonly priceAt: (t: number) => number | null,
    private readonly pricesBetween: (t1: number, t2: number) => number[],
    private readonly opts: LayerOptions = {},
  ) {
    this.win = opts.win ?? window;
    const doc = host.ownerDocument;
    this.href = this.win.location.href;
    this.root = doc.createElement("div");
    this.root.className = "g-chart-layer";
    this.root.setAttribute("data-glance-layer", "chart");
    this.svg = doc.createElementNS(SVG, "svg");
    this.svg.setAttribute("viewBox", `0 0 ${at.width} ${at.height}`);
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.svg.setAttribute("aria-hidden", "true");
    const close = doc.createElement("button");
    close.className = "g-btn g-btn-ghost g-icon-btn g-chart-layer-close";
    close.setAttribute("aria-label", "Clear Glance's marks from this chart");
    close.textContent = "×";
    close.addEventListener("click", () => this.close());
    this.root.append(this.svg, close);
    // First in Glance's layer: above the page, under Glance's own panel and cards (they come later, and paint over it).
    host.prepend(this.root);
    this.place();
    this.win.addEventListener("scroll", this.onMove, { passive: true, capture: true });
    this.win.addEventListener("resize", this.onMove, { passive: true });
    const RO = (this.win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    this.observer = RO ? new RO(() => this.place()) : null;
    this.observer?.observe(target);
    // Layout changes that move the chart without resizing it, the page's range changing, and navigation.
    this.timer = this.win.setInterval(() => {
      if (this.win.location.href !== this.href || !this.target.isConnected) return this.close();
      if (opts.range && opts.rangeNow && opts.rangeNow() && opts.rangeNow() !== opts.range) return this.close();
      this.place();
    }, 800);
    for (const d of opts.dots ?? []) this.shape({ kind: "circle", cx: d.x - at.x, cy: d.y - at.y, r: 2 }, "dot");
  }

  get isOpen() {
    return !this.closed;
  }

  /** Draws one computed mark, as soon as the last one is at least MARK_GAP_MS old. */
  add(a: ChartAnnotation) {
    if (this.closed) return;
    this.queue.push(a);
    this.pump();
  }

  private pump() {
    if (this.drain !== null || this.queue.length === 0 || this.closed) return;
    const now = this.opts.now?.() ?? Date.now();
    const wait = Math.max(0, this.lastDrawn + MARK_GAP_MS - now);
    this.drain = this.win.setTimeout(() => {
      this.drain = null;
      const a = this.queue.shift();
      if (a) this.draw(a);
      this.lastDrawn = this.opts.now?.() ?? Date.now();
      this.pump();
    }, wait);
  }

  private draw(a: ChartAnnotation) {
    const shapes = markShapes(a, this.cal, this.at, this.priceAt, this.pricesBetween);
    if (!shapes) return;
    const g = this.svg.ownerDocument.createElementNS(SVG, "g");
    g.setAttribute("data-mark", a.kind.toLowerCase());
    for (const s of shapes) this.shape(s, a.kind, g);
    this.svg.append(g);
    this.drawn++;
  }

  /** One shape: a dark outline under a lime stroke (text: a dark halo), so it reads on any chart. */
  private shape(s: MarkShape, kind: string, parent: Element = this.svg) {
    const doc = this.svg.ownerDocument;
    const el = (name: string, attrs: Record<string, string | number>) => {
      const e = doc.createElementNS(SVG, name);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      e.setAttribute("vector-effect", "non-scaling-stroke");
      parent.append(e);
      return e;
    };
    if (kind === "dot") {
      el("circle", { cx: s.kind === "circle" ? s.cx : 0, cy: s.kind === "circle" ? s.cy : 0, r: 2, fill: MARK, stroke: OUTLINE, "stroke-width": 0.8, "data-dot": "1" });
      return;
    }
    const fillZone = kind === "CHART_RANGE";
    const both = (name: string, attrs: Record<string, string | number>, width: number) => {
      el(name, { ...attrs, fill: fillZone && name === "polygon" ? MARK : name === "polygon" ? MARK : "none", "fill-opacity": fillZone ? 0.08 : 1, stroke: OUTLINE, "stroke-width": width + 2, "stroke-opacity": 0.55 });
      el(name, { ...attrs, fill: fillZone && name === "polygon" ? MARK : name === "polygon" ? MARK : "none", "fill-opacity": fillZone ? 0.08 : 1, stroke: MARK, "stroke-width": width });
    };
    switch (s.kind) {
      case "line":
        both("line", { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, "stroke-linecap": "round", ...(s.dashed ? { "stroke-dasharray": "7 5" } : {}) }, 2);
        break;
      case "circle":
        both("circle", { cx: s.cx, cy: s.cy, r: s.r }, 2.5);
        break;
      case "polygon":
        both("polygon", { points: s.points.map((p) => p.join(",")).join(" "), "stroke-linejoin": "round" }, 1.5);
        break;
      case "text": {
        const t = el("text", { x: s.x, y: s.y, "text-anchor": s.anchor, fill: MARK, stroke: OUTLINE, "stroke-width": 3, "paint-order": "stroke", "font-size": 12, "font-weight": 600 });
        t.textContent = s.text;
        break;
      }
    }
  }

  /** Exactly over the chart's box, as it is now (the SVG scales with it). */
  place() {
    const r = this.target.getBoundingClientRect();
    Object.assign(this.root.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  /** Removes every mark (the layer stays for the next answer). */
  clear() {
    this.queue = [];
    for (const g of [...this.svg.querySelectorAll("g[data-mark]")]) g.remove();
    this.drawn = 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    if (this.drain !== null) this.win.clearTimeout(this.drain);
    this.win.clearInterval(this.timer);
    this.win.removeEventListener("scroll", this.onMove, { capture: true });
    this.win.removeEventListener("resize", this.onMove);
    this.observer?.disconnect();
    this.root.remove();
    this.opts.onClose?.();
  }
}
