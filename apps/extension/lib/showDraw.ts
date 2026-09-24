/**
 * Show me's drawings: a full-viewport SVG overlay inside Glance's shadow root (the page's DOM is never touched), with
 * hand-drawn marks (@glance/core/sketch), each stroked in over about 600ms. Marks follow their words as the page
 * scrolls or resizes. After the reply ends they fade out 4 seconds later; Escape clears at once.
 *
 * Visible on every page: the color comes from the background under the target (markColors: lime on dark pages, the
 * darker limeMark on light ones, where lime is 1.3:1 on white), with a faint halo under the stroke. The stroke is heavy
 * and hand-drawn, so it never reads as the passive dotted company underline.
 */
import { markColors, isLightColor } from "@glance/design";
import { circlePath, seedOf, underlinePath, type Box } from "@glance/core/sketch";

export const STROKE_MS = 600;
export const FADE_AFTER_MS = 4_000;
const SVG = "http://www.w3.org/2000/svg";

interface Mark {
  kind: "CIRCLE" | "UNDERLINE";
  range: Range;
  paths: SVGPathElement[];
  seed: number;
}

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

  /** Draws a circle or underline around the range. Returns false if the words have no box (hidden): skipped. */
  draw(kind: "CIRCLE" | "UNDERLINE", range: Range): boolean {
    const box = rangeBox(range);
    if (!box) return false;
    clearTimeout(this.fadeTimer);
    this.svg.style.opacity = "1";
    const seed = seedOf(range.toString());
    const d = kind === "CIRCLE" ? circlePath(box, seed) : underlinePath(box, seed);
    const colors = marksFor(range, this.win);
    // A faint halo under the stroke, then the stroke: both drawn in together.
    const halo = this.stroke(d, colors.halo, kind === "CIRCLE" ? 6 : 6.5);
    const pen = this.stroke(d, colors.stroke, kind === "CIRCLE" ? 3 : 3.4);
    pen.setAttribute("data-mark", kind.toLowerCase());
    this.marks.push({ kind, range, paths: [halo, pen], seed });
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
   * Developer check: every shape on `range` (the selection), so drawings can be checked by eye in seconds. Returns the
   * shapes drawn.
   */
  drawTest(range: Range): string[] {
    const drawn: string[] = [];
    for (const kind of ["CIRCLE", "UNDERLINE"] as const) if (this.draw(kind, range)) drawn.push(kind);
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
        const box = rangeBox(m.range);
        if (!box) continue;
        const d = m.kind === "CIRCLE" ? circlePath(box, m.seed) : underlinePath(box, m.seed);
        for (const p of m.paths) {
          p.setAttribute("d", d);
          // Already drawn: no replay of the stroke.
          p.style.transition = "none";
          p.style.strokeDasharray = "none";
        }
      }
    });
  }
}
