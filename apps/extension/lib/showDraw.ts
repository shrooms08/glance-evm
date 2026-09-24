/**
 * Show me's drawings: a full-viewport SVG overlay inside Glance's shadow root (the page's DOM is never touched), with
 * hand-drawn circles and underlines (@glance/core/sketch) in lime, each stroked in over about 600ms. Marks follow their
 * words as the page scrolls or resizes. After the reply ends they fade out 4 seconds later; Escape clears at once.
 */
import { circlePath, seedOf, underlinePath, type Box } from "@glance/core/sketch";

export const STROKE_MS = 600;
export const FADE_AFTER_MS = 4_000;
const SVG = "http://www.w3.org/2000/svg";

interface Mark {
  kind: "CIRCLE" | "UNDERLINE";
  range: Range;
  path: SVGPathElement;
  seed: number;
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
    private readonly color: string,
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
    const path = this.host.ownerDocument.createElementNS(SVG, "path");
    path.setAttribute("d", kind === "CIRCLE" ? circlePath(box, seed) : underlinePath(box, seed));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", this.color);
    path.setAttribute("stroke-width", kind === "CIRCLE" ? "2.4" : "2.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    this.svg.append(path);
    // The pen stroke: dash the whole length and draw it in.
    const length = typeof path.getTotalLength === "function" ? path.getTotalLength() : 1_000;
    const reduced = this.win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    Object.assign(path.style, { strokeDasharray: `${length}`, strokeDashoffset: reduced ? "0" : `${length}`, transition: `stroke-dashoffset ${STROKE_MS}ms cubic-bezier(.3,.7,.2,1)` });
    if (!reduced) this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(() => (path.style.strokeDashoffset = "0")));
    this.marks.push({ kind, range, path, seed });
    return true;
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
        m.path.setAttribute("d", m.kind === "CIRCLE" ? circlePath(box, m.seed) : underlinePath(box, m.seed));
        // Already drawn: no replay of the stroke.
        m.path.style.transition = "none";
        m.path.style.strokeDasharray = "none";
      }
    });
  }
}
