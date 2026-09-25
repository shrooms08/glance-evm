/**
 * The chart lens, on the page: find the chart the user means, work out its stock and range, calibrate its scale, and
 * check the calibration before anything is drawn on it. The pure maths is in @glance/core/page-chart; this is the DOM
 * and screenshot side.
 *
 *   find        canvas, svg and img charts, and the known chart containers (TradingView, Yahoo Finance, Google
 *               Finance, CNBC): visible, large, near the page's stock. A container holding several canvases (a price
 *               pane and its axes) counts as one chart.
 *   stock       the URL, headings, and text around the chart; range: the selected range button, else the axis span.
 *   calibrate   DOM labels first (text or SVG <text>: exact); else a screenshot crop read by the vision model.
 *   check       our high and low inside the plot, and our line on the page's (an SVG path, or the screenshot's pixels).
 *
 * Nothing from the page is sent anywhere except the crop, for a vision calibration, and only when the user asked.
 */
import { CHART_RANGES, type ChartRange } from "@glance/core/chart";
import { chartSite, cropFor, detectSymbol, rangeFromButton, rangeFromSpan, datedTimes, type AxisLabel, type Box } from "@glance/core/page-chart";

/** A question about a chart on the page: "explain this chart", "show me the dip on this chart", "what happened here?". */
export function wantsPageChart(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(this|that|the) (chart|graph|plot)\b|\bon (this|the) (chart|graph)\b/.test(q) ||
    /\bwhat happened here\b|\bthis (dip|drop|spike|peak|jump|move|rally|selloff|sell-off)\b|\bhere on the chart\b/.test(q)
  );
}

/** Known chart containers, by site. */
const KNOWN = [
  ".chart-container", // TradingView, Yahoo
  ".chart-markup-table",
  ".tv-lightweight-charts",
  "[data-testid*='chart' i]",
  "[class*='QuoteChart']", // CNBC
  "[class*='chart-wrapper' i]",
  "[aria-label*='chart' i]",
].join(",");

export interface ChartCandidate {
  el: Element;
  box: Box;
  kind: "canvas" | "svg" | "img" | "container";
  score: number;
}

const rectBox = (r: DOMRect): Box => ({ x: r.left, y: r.top, width: r.width, height: r.height });

function visibleArea(r: DOMRect, win: Window): number {
  const w = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
  return w * h;
}

/** A chart's container: the nearest ancestor that holds its sibling canvases (price pane and axes) and not much else. */
function chartContainer(el: Element): Element {
  const own = el.getBoundingClientRect();
  let best = el;
  for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
    const r = p.getBoundingClientRect();
    if (r.width * r.height > own.width * own.height * 1.8) break;
    if (p.querySelectorAll("canvas, svg").length > 1 || p.matches(KNOWN)) best = p;
  }
  return best;
}

/** The charts on the page, most likely first. `near` are texts naming the stock the user asked about (boost). */
export function findChartCandidates(doc: Document, win: Window = window, near: readonly string[] = []): ChartCandidate[] {
  const seen = new Set<Element>();
  const out: ChartCandidate[] = [];
  const consider = (el: Element, kind: ChartCandidate["kind"]) => {
    const container = kind === "canvas" || kind === "svg" ? chartContainer(el) : el;
    if (seen.has(container)) return;
    seen.add(container);
    const r = container.getBoundingClientRect();
    if (r.width < 200 || r.height < 110) return;
    const area = visibleArea(r, win);
    if (area < 200 * 110 * 0.6) return;
    const ratio = r.width / r.height;
    let score = area * (ratio >= 1.4 && ratio <= 6 ? 1 : 0.4);
    if (container.matches(KNOWN) || container.querySelector(KNOWN)) score *= 1.3;
    const around = (container.closest("section, article, main, [role=main]")?.textContent ?? "").slice(0, 2_000);
    if (near.some((n) => n && around.includes(n))) score *= 1.5;
    out.push({ el: container, box: rectBox(r), kind: container === el ? kind : "container", score });
  };
  for (const el of doc.querySelectorAll("canvas")) consider(el, "canvas");
  for (const el of doc.querySelectorAll("svg")) if (el.querySelectorAll("path, polyline").length > 0) consider(el, "svg");
  for (const el of doc.querySelectorAll("img")) if (/chart|graph|price/i.test(`${el.getAttribute("alt") ?? ""} ${el.getAttribute("src") ?? ""}`)) consider(el, "img");
  for (const el of doc.querySelectorAll(KNOWN)) consider(el, "container");
  return out.sort((a, b) => b.score - a.score);
}

/** Axis labels that are real text: text nodes and SVG <text> in and just around the chart (viewport px). */
export function readDomLabels(el: Element, win: Window = window): AxisLabel[] {
  const doc = el.ownerDocument;
  const box = el.getBoundingClientRect();
  const out: AxisLabel[] = [];
  const add = (text: string, r: DOMRect) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t || t.length > 16 || r.width === 0 || r.height === 0) return;
    if (r.right < box.left - 70 || r.left > box.right + 70 || r.bottom < box.top - 10 || r.top > box.bottom + 40) return;
    out.push({ text: t, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height });
  };
  // The chart's own subtree, and its parent's (labels are often siblings of the canvas).
  const root = el.parentElement ?? el;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest("button, a, [role=tab], [role=button], select, input, label")) continue;
    const style = win.getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    const range = doc.createRange();
    range.selectNodeContents(n);
    add(n.textContent ?? "", range.getBoundingClientRect());
  }
  return out;
}

/** The selected range button near the chart ("1D", "5 days"...), as Glance's range, or null when none is marked. */
export function selectedRange(el: Element): ChartRange | "other" | null {
  const scope = el.closest("section, article, main, [role=main]") ?? el.ownerDocument.body;
  for (const b of scope.querySelectorAll("button, [role=tab], [role=radio], a, li")) {
    const on = b.getAttribute("aria-selected") === "true" || b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || /(^|\s|-)(selected|active|isActive|is-active)(\s|$)/i.test(b.getAttribute("class") ?? "");
    if (!on) continue;
    const r = rangeFromButton(b.textContent ?? "");
    if (r) return r;
  }
  return null;
}

export interface PageChartTarget {
  el: Element;
  box: Box;
  symbol: string | null;
  range: ChartRange | "other" | null;
  site: ReturnType<typeof chartSite>;
  /** What to ask first when unsure: "Which chart: TSLA 5 days?" */
  unsure: string | null;
  /** Other candidates close in score (the first is the one picked). */
  alternatives: number;
}

const RANGE_WORDS: Record<ChartRange, string> = { "1D": "1 day", "1W": "5 days", "1M": "1 month" };

/**
 * Which chart, which stock, which range. `named` is the stock the question names (from the page's underlines or the
 * catalog), which wins over anything the page says. Unsure (no symbol, a range Glance doesn't have, two charts
 * alike): a short question to ask instead of guessing.
 */
export function pickPageChart(doc: Document, win: Window, symbols: readonly string[], named: string | null, aliases: Record<string, string[]> = {}): PageChartTarget | null {
  const near = named ? [named, ...(aliases[named] ?? [])] : [];
  const candidates = findChartCandidates(doc, win, near);
  const top = candidates[0];
  if (!top) return null;
  const alike = candidates.filter((c) => c.score >= top.score * 0.8).length - 1;
  const headings = [...doc.querySelectorAll("h1, h2, h3, [role=heading], title")].slice(0, 12).map((h) => h.textContent ?? "");
  const around = (top.el.closest("section, article, [role=region]")?.textContent ?? "").slice(0, 1_500).split(/\s+/);
  // What the page itself says (the question's company is weighed separately: it may not be this chart's).
  const detected = detectSymbol({ url: doc.location?.href ?? "", headings: [doc.title, ...headings], nearChart: around }, symbols);
  let range = selectedRange(top.el);
  if (range === null) {
    // No button says: the span of the time labels.
    const labels = readDomLabels(top.el, win).filter((l) => l.y > top.box.y + top.box.height / 2);
    const times = datedTimes(labels, Math.floor(Date.now() / 1000)).filter((t): t is number => t !== null);
    if (times.length >= 2) range = rangeFromSpan(Math.max(...times) - Math.min(...times));
  }
  // The question's company, unless the page clearly shows another stock's chart (then ask: never draw AMD on TSLA).
  const clash = named !== null && detected.confident && detected.symbol !== null && detected.symbol !== named;
  const symbol = named && !clash ? named : detected.symbol;
  let unsure: string | null = null;
  if (clash) unsure = `This chart looks like ${detected.symbol}. Which chart: ${detected.symbol} ${RANGE_WORDS[isGlanceRange(range) ? range : "1W"]}?`;
  else if (!symbol) unsure = "Which stock is this chart?";
  else if (range === "other") unsure = `Glance can show 1 day, 5 days or 1 month. Which chart: ${symbol} 1 month?`;
  else if ((!detected.confident && !named) || alike > 0 || range === null) unsure = `Which chart: ${symbol} ${RANGE_WORDS[range ?? "1W"]}?`;
  return { el: top.el, box: top.box, symbol, range, site: chartSite(doc.location?.hostname ?? ""), unsure, alternatives: alike };
}

export const isGlanceRange = (r: unknown): r is ChartRange => (CHART_RANGES as readonly unknown[]).includes(r);

// ---------------------------------------------------------------------------------------------------------------------
// Reading the page's line, to check a calibration
// ---------------------------------------------------------------------------------------------------------------------

/**
 * For an SVG chart: where its price line crosses x (viewport px). The line is the path with the most points (the
 * price series), sampled along its length. Null when the chart has no such path.
 */
export function svgLineReader(el: Element): ((x: number) => number[] | null) | null {
  const paths = [...el.querySelectorAll("path, polyline")] as SVGGeometryElement[];
  let best: SVGGeometryElement | null = null;
  let bestLen = 0;
  for (const p of paths) {
    const d = p.getAttribute("d") ?? p.getAttribute("points") ?? "";
    const n = (d.match(/[\d.]+[ ,][\d.]+/g) ?? []).length;
    if (n > bestLen) {
      best = p;
      bestLen = n;
    }
  }
  if (!best || bestLen < 8 || typeof best.getTotalLength !== "function") return null;
  const len = best.getTotalLength();
  const ctm = best.getScreenCTM?.();
  const samples: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= 600; i++) {
    const p = best.getPointAtLength((len * i) / 600);
    samples.push(ctm ? { x: ctm.a * p.x + ctm.c * p.y + ctm.e, y: ctm.b * p.x + ctm.d * p.y + ctm.f } : p);
  }
  return (x) => {
    const near = samples.filter((s) => Math.abs(s.x - x) <= 2);
    return near.length ? near.map((s) => s.y) : null;
  };
}

/**
 * For a canvas chart: where the line is in the screenshot's column at x, from the crop's pixels: runs of pixels that
 * stand out from the column's background (colored, or much darker or lighter), away from the text columns. Viewport
 * px in, viewport px out. Null outside the crop.
 */
export function pixelLineReader(img: { data: Uint8ClampedArray; width: number; height: number }, crop: Box, scale: number): (x: number) => number[] | null {
  const px = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!] as const;
  };
  return (x) => {
    const cx = Math.round((x - crop.x) * scale);
    if (cx < 0 || cx >= img.width) return null;
    // The column's most common color is its background.
    const counts = new Map<string, number>();
    for (let y = 0; y < img.height; y++) {
      const [r, g, b] = px(cx, y);
      const k = `${r >> 4},${g >> 4},${b >> 4}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0].split(",").map((v) => Number(v) * 16 + 8);
    const ys: number[] = [];
    let run: number[] = [];
    // A short run is the line itself (its middle); a long one is the line on top of an area fill (its top edge).
    const flush = () => {
      if (run.length > 0) ys.push(crop.y + (run.length <= 12 ? run.reduce((s, v) => s + v, 0) / run.length : run[0]! + 1) / scale);
      run = [];
    };
    for (let y = 0; y < img.height; y++) {
      const [r, g, b] = px(cx, y);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const dist = Math.abs(r - bg[0]!) + Math.abs(g - bg[1]!) + Math.abs(b - bg[2]!);
      if (sat > 60 || dist > 150) run.push(y);
      else flush();
    }
    flush();
    return ys;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The crop, for a vision calibration
// ---------------------------------------------------------------------------------------------------------------------

export const CROP_MAX_WIDTH = 1_000;

/**
 * Crops the chart out of a screenshot (a data URL of the visible tab, in device pixels) and re-encodes it: the JPEG to
 * send, the scale from viewport px to the crop's px, and the crop's pixels (for reading the page's line).
 */
export async function cropScreenshot(dataUrl: string, box: Box, viewport: { width: number; height: number; dpr: number }): Promise<{ base64: string; width: number; height: number; crop: Box; scale: number; pixels: ImageData }> {
  const crop = cropFor(box, viewport);
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(viewport.dpr, CROP_MAX_WIDTH / crop.width);
  const canvas = new OffscreenCanvas(Math.round(crop.width * scale), Math.round(crop.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, crop.x * viewport.dpr, crop.y * viewport.dpr, crop.width * viewport.dpr, crop.height * viewport.dpr, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), width: canvas.width, height: canvas.height, crop, scale, pixels };
}
