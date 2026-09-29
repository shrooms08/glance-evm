/**
 * The Glance lens: when a page's chart can't be calibrated reliably (or the user asks for it), Glance's own chart for
 * the same stock and range is laid exactly over the page's chart box, slightly see-through, labelled with its prices'
 * source ("Glance lens · Chainlink prices", or Yahoo Finance's for a stock outside the catalog), with a close button, and Show me draws on it. It follows the page chart through scroll and
 * resize, and never touches the page's DOM (it lives in Glance's shadow root).
 */
import type { ChartData } from "@glance/core/chart";
import type { ChartHandle } from "@glance/core/chart-mount";
import type { ChartAnnotation } from "@glance/core/showme";

import type { Mount } from "./chartLoader";

export const LENS_LABEL = "Glance lens · Chainlink prices";
/** The lens's label, naming where its prices come from. */
export const lensLabel = (source: string) => `Glance lens · ${source} prices`;

export class ChartLens {
  readonly root: HTMLDivElement;
  private handle: ChartHandle | null = null;
  private waiting: ChartAnnotation[] = [];
  private raf = 0;
  private closed = false;
  private readonly onMove = () => this.schedule();

  constructor(
    host: Element,
    private readonly target: Element,
    data: ChartData,
    mount: Mount,
    private readonly onClose: () => void = () => {},
    private readonly win: Window = window,
  ) {
    const doc = host.ownerDocument;
    this.root = doc.createElement("div");
    this.root.className = "g-lens";
    this.root.setAttribute("role", "region");
    const text = lensLabel(data.source.label);
    this.root.setAttribute("aria-label", `${data.symbol} ${text}`);
    const head = doc.createElement("div");
    head.className = "g-lens-head";
    const label = doc.createElement("span");
    label.className = "g-lens-label";
    label.textContent = text;
    const close = doc.createElement("button");
    close.className = "g-btn g-btn-ghost g-icon-btn";
    close.setAttribute("aria-label", "Close the Glance lens");
    close.textContent = "×";
    close.addEventListener("click", () => this.close());
    head.append(label, close);
    const box = doc.createElement("div");
    box.className = "g-lens-chart";
    this.root.append(head, box);
    host.append(this.root);
    this.place();
    win.addEventListener("scroll", this.onMove, { passive: true, capture: true });
    win.addEventListener("resize", this.onMove, { passive: true });
    void mount(box, data, { theme: "dark" }).then(
      (h) => {
        if (this.closed) return h.destroy();
        this.handle = h;
        if (this.waiting.length) h.annotate(this.waiting.splice(0));
      },
      () => this.close(),
    );
  }

  /** Draws on the lens (as soon as its chart is up). */
  annotate(a: ChartAnnotation) {
    if (this.handle) this.handle.annotate([a]);
    else this.waiting.push(a);
  }

  clearAnnotations() {
    this.waiting = [];
    this.handle?.clearAnnotations();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.win.removeEventListener("scroll", this.onMove, { capture: true });
    this.win.removeEventListener("resize", this.onMove);
    this.win.cancelAnimationFrame(this.raf);
    this.handle?.destroy();
    this.root.remove();
    this.onClose();
  }

  get isOpen() {
    return !this.closed;
  }

  /** Exactly over the page chart's box, as it is now. */
  place() {
    const r = this.target.getBoundingClientRect();
    Object.assign(this.root.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  private schedule() {
    if (this.raf) return;
    this.raf = this.win.requestAnimationFrame(() => {
      this.raf = 0;
      this.place();
    });
  }
}
