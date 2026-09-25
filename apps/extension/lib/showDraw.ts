/**
 * Show me's drawings: a full-viewport SVG overlay inside Glance's shadow root (the page's DOM is never touched), with
 * hand-drawn marks (@glance/core/sketch), each stroked in over about 600ms. Marks follow their words as the page
 * scrolls or resizes. After the reply ends they fade out 4 seconds later; Escape clears at once.
 *
 * Visible on every page: the color comes from the background under the target (markColors: lime on dark pages, the
 * darker limeMark on light ones, where lime is 1.3:1 on white), with a faint halo under the stroke. The stroke is heavy
 * and hand-drawn, so it never reads as the passive dotted company underline.
 */
import { isLightColor, markColors } from "@glance/design";
import { arrowPath, boxPath, circlePath, highlightPath, seedOf, underlinePath, type Box } from "@glance/core/sketch";

export const STROKE_MS = 600;
export const FADE_AFTER_MS = 4_000;
const SVG = "http://www.w3.org/2000/svg";

export type MarkKind = "CIRCLE" | "UNDERLINE" | "BOX" | "HIGHLIGHT" | "ARROW" | "BOX_FIGURE" | "CHART_POINT" | "CHART_LEVEL" | "CHART_RANGE" | "CHART_TREND";

/** A mark's shapes for the current layout (re-measured on scroll and resize); null when its target has no box. */
export type Geometry = () => { strokes: string[]; fill?: string; label?: { text: string; x: number; y: number } } | null;

interface Mark {
  kind: MarkKind;
  geometry: Geometry;
  paths: Array<{ el: SVGPathElement; part: "stroke" | "fill"; index: number }>;
  label?: SVGTextElement;
}

/** The block a quote sits in, for BOX: its paragraph, list item, table cell, caption or quote. */
export function blockOf(range: Range): Element | null {
  const start = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
  return start?.closest("p, li, td, th, figcaption, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, pre") ?? start ?? null;
}

/** Every line box of a range (for HIGHLIGHT): the rects on each line joined. */
export function lineBoxes(range: Range): Box[] {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const lines: Box[] = [];
  for (const r of rects) {
    const line = lines.find((l) => Math.abs(l.y - r.top) < r.height / 2);
    if (line) {
      const right = Math.max(line.x + line.width, r.right);
      line.x = Math.min(line.x, r.left);
      line.width = right - line.x;
    } else lines.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  return lines;
}

const elementBox = (el: Element): Box | null => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
};

/** The background color actually behind a node: the nearest ancestor with a mostly opaque background ("" for none). */
export function backgroundUnder(node: Node, win: Window = window): string {
  for (let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement; el; el = el.parentElement) {
    const bg = win.getComputedStyle(el).backgroundColor;
    const m = /rgba?\([^)]*?([\d.]+)\)$/.exec(bg);
    const alpha = /rgba/.test(bg) && m ? Number(m[1]) : bg && bg !== "transparent" ? 1 : 0;
    if (alpha >= 0.5) return bg;
  }
  return ""; // nothing opaque: the browser's default canvas, which is white (isLightColor treats "" as light)
}

/** Lime on dark, limeMark on light: picked from the background under the range. */
export function marksFor(range: Range, win: Window = window) {
  return markColors(isLightColor(backgroundUnder(range.startContainer, win)));
}

/** The bounding box of a range's first line (a quote that wraps is marked on its first line). */
export function rangeBox(range: Range): Box | null {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const first = rects[0];
  if (!first) return null;
  // Every rect on the first line, joined.
  const line = rects.filter((r) => Math.abs(r.top - first.top) < first.height / 2);
  const left = Math.min(...line.map((r) => r.left));
  const right = Math.max(...line.map((r) => r.right));
  return { x: left, y: first.top, width: right - left, height: first.height };
}

export class ShowDrawings {
  private svg: SVGSVGElement;
  private marks: Mark[] = [];
  private raf = 0;
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onMove = () => this.schedule();

  constructor(
    private readonly host: Element,
    private readonly win: Window = window,
  ) {
    this.svg = host.ownerDocument.createElementNS(SVG, "svg");
    this.svg.setAttribute("class", "g-show-layer");
    this.svg.setAttribute("aria-hidden", "true");
    Object.assign(this.svg.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: "2147483646", overflow: "visible", transition: "opacity 400ms ease" });
    host.append(this.svg);
    win.addEventListener("scroll", this.onMove, { passive: true, capture: true });
    win.addEventListener("resize", this.onMove, { passive: true });
  }

  get count(): number {
    return this.marks.length;
  }

  /** Draws a circle, underline, box or highlight for the range. False if it has no box (hidden): skipped. */
  draw(kind: "CIRCLE" | "UNDERLINE" | "BOX" | "HIGHLIGHT", range: Range): boolean {
    const seed = seedOf(`${kind}:${range.toString()}`);
    const geometry: Geometry =
      kind === "HIGHLIGHT"
        ? () => {
            const lines = lineBoxes(range);
            return lines.length ? { strokes: [], fill: highlightPath(lines, seed) } : null;
          }
        : kind === "BOX"
          ? () => {
              const block = blockOf(range);
              const box = (block ? elementBox(block) : null) ?? rangeBox(range);
              return box ? { strokes: [boxPath(box, seed)] } : null;
            }
          : () => {
              const box = rangeBox(range);
              return box ? { strokes: [kind === "CIRCLE" ? circlePath(box, seed) : underlinePath(box, seed)] } : null;
            };
    return this.add(kind, geometry, marksFor(range, this.win));
  }

  /** A curved arrow from one range to another. False if either has no box: skipped. */
  drawArrow(from: Range, to: Range): boolean {
    const seed = seedOf(`${from.toString()}->${to.toString()}`);
    return this.add(
      "ARROW",
      () => {
        const a = rangeBox(from);
        const b = rangeBox(to);
        if (!a || !b) return null;
        const { shaft, head } = arrowPath(a, b, seed);
        return { strokes: [shaft, head] };
      },
      marksFor(from, this.win),
    );
  }

  /** A box around a figure (an image, a canvas, a chart). */
  drawFigure(el: Element): boolean {
    const seed = seedOf(`figure:${el.tagName}:${el.getAttribute("src") ?? ""}`);
    return this.add(
      "BOX_FIGURE",
      () => {
        const box = elementBox(el);
        return box ? { strokes: [boxPath(box, seed, 8)] } : null;
      },
      markColors(isLightColor(backgroundUnder(el.parentElement ?? el, this.win))),
    );
  }

  /**
   * A mark on a chart on the page (the chart lens): its geometry comes from the chart's calibration and the element's
   * box at this moment, so it follows scroll and resize like every other mark. Colored for the background under `on`.
   */
  drawChart(kind: "CHART_POINT" | "CHART_LEVEL" | "CHART_RANGE" | "CHART_TREND", geometry: Geometry, on: Element): boolean {
    return this.add(kind, geometry, markColors(isLightColor(backgroundUnder(on, this.win))));
  }

  private add(kind: MarkKind, geometry: Geometry, colors: { stroke: string; halo: string; highlight: string }): boolean {
    const g = geometry();
    if (!g) return false;
    clearTimeout(this.fadeTimer);
    this.svg.style.opacity = "1";
    const paths: Mark["paths"] = [];
    if (g.fill) {
      // A marker swipe: a translucent wash that blends with the page, so the words under it stay readable.
      const fill = this.host.ownerDocument.createElementNS(SVG, "path");
      fill.setAttribute("d", g.fill);
      fill.setAttribute("fill", colors.highlight);
      fill.setAttribute("data-mark", "highlight");
      // A plain translucent wash (at most .35 opaque: the words stay readable). No blend mode: our overlay is its own
      // layer above the page, so a multiply or screen blend would have nothing under it to blend with and vanish.
      const reduced = this.win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      Object.assign(fill.style, { clipPath: reduced ? "none" : "inset(0 100% 0 0)", transition: `clip-path ${STROKE_MS}ms cubic-bezier(.3,.7,.2,1)` });
      this.svg.append(fill);
      if (!reduced) this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(() => (fill.style.clipPath = "inset(0 0 0 0)")));
      setTimeout(() => (fill.style.clipPath = "none"), STROKE_MS + 100);
      paths.push({ el: fill, part: "fill", index: 0 });
    }
    g.strokes.forEach((d, index) => {
      // A faint halo under the stroke, then the stroke: both drawn in together.
      const halo = this.stroke(d, colors.halo, kind === "UNDERLINE" ? 6.5 : 6);
      const pen = this.stroke(d, colors.stroke, kind === "UNDERLINE" ? 3.4 : 3);
      pen.setAttribute("data-mark", kind.toLowerCase());
      paths.push({ el: halo, part: "stroke", index }, { el: pen, part: "stroke", index });
    });
    let label: SVGTextElement | undefined;
    if (g.label) {
      // A short factual label (a level's "Week low $362.20"), with the halo color behind it so it reads on any chart.
      label = this.host.ownerDocument.createElementNS(SVG, "text");
      label.textContent = g.label.text;
      label.setAttribute("x", String(g.label.x));
      label.setAttribute("y", String(g.label.y));
      label.setAttribute("text-anchor", "end");
      label.setAttribute("fill", colors.stroke);
      label.setAttribute("stroke", colors.halo);
      label.setAttribute("stroke-width", "3");
      label.setAttribute("paint-order", "stroke");
      label.setAttribute("data-mark", "label");
      Object.assign(label.style, { font: "600 12px var(--g-font, system-ui)" });
      this.svg.append(label);
    }
    this.marks.push({ kind, geometry, paths, ...(label ? { label } : {}) });
    return true;
  }

  private stroke(d: string, color: string, width: number): SVGPathElement {
    const path = this.host.ownerDocument.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", String(width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    this.svg.append(path);
    // The pen stroke: dash the whole length and draw it in.
    const length = typeof path.getTotalLength === "function" ? path.getTotalLength() : 1_000;
    const reduced = this.win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    Object.assign(path.style, { strokeDasharray: `${length}`, strokeDashoffset: reduced ? "0" : `${length}`, transition: `stroke-dashoffset ${STROKE_MS}ms cubic-bezier(.3,.7,.2,1)` });
    if (!reduced) this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(() => (path.style.strokeDashoffset = "0")));
    // Whatever the animation does, the mark is fully drawn once it should have finished.
    setTimeout(() => (path.style.strokeDashoffset = "0"), STROKE_MS + 100);
    return path;
  }

  /**
   * Developer check: every shape on `range` (the selection), and an arrow to `next` (the following sentence), so
   * drawings can be checked by eye in seconds. Returns the shapes drawn.
   */
  drawTest(range: Range, next: Range | null = null): string[] {
    const drawn: string[] = [];
    for (const kind of ["CIRCLE", "UNDERLINE", "HIGHLIGHT", "BOX"] as const) if (this.draw(kind, range)) drawn.push(kind);
    if (next && this.drawArrow(range, next)) drawn.push("ARROW");
    return drawn;
  }

  /** The reply ended: fade the marks out after FADE_AFTER_MS. */
  fadeLater(ms = FADE_AFTER_MS) {
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => {
      this.svg.style.opacity = "0";
      this.fadeTimer = setTimeout(() => this.clear(), 450);
    }, ms);
  }

  clear() {
    clearTimeout(this.fadeTimer);
    this.marks = [];
    this.svg.replaceChildren();
    this.svg.style.opacity = "1";
  }

  destroy() {
    this.clear();
    this.win.removeEventListener("scroll", this.onMove, { capture: true });
    this.win.removeEventListener("resize", this.onMove);
    this.win.cancelAnimationFrame(this.raf);
    this.svg.remove();
  }

  /** Re-measures every mark on the next frame (scrolls, resizes). */
  private schedule() {
    if (this.raf || this.marks.length === 0) return;
    this.raf = this.win.requestAnimationFrame(() => {
      this.raf = 0;
      for (const m of this.marks) {
        const g = m.geometry();
        if (!g) continue;
        if (m.label && g.label) {
          m.label.setAttribute("x", String(g.label.x));
          m.label.setAttribute("y", String(g.label.y));
        }
        for (const p of m.paths) {
          const d = p.part === "fill" ? g.fill : g.strokes[p.index];
          if (!d) continue;
          p.el.setAttribute("d", d);
          // Already drawn: no replay of the stroke.
          p.el.style.transition = "none";
          if (p.part === "stroke") p.el.style.strokeDasharray = "none";
        }
      }
    });
  }
}
