/**
 * Show me's marks are visible on every page: a rendered circle exists in the overlay with a non-zero size at the
 * target's box (on a scrolled page too: viewport coordinates, like the fixed overlay), in the dark-lime token on a light
 * page and lime on a dark one, with its stroke always finishing. And "glance test drawing" parses.
 */
import { color } from "@glance/design";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCommand } from "../lib/commands";
import { backgroundUnder, ShowDrawings, STROKE_MS } from "../lib/showDraw";

const TARGET = { left: 110, top: 430, width: 140, height: 20, right: 250, bottom: 450, x: 110, y: 430, toJSON() {} } as DOMRect;

function page(bg: string) {
  document.body.innerHTML = `<article><p>Tesla shares rose 4% after <span id="t">Revenue grew 12%</span> to $25.2 billion.</p></article>`;
  document.body.style.backgroundColor = bg;
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("t")!);
  range.getClientRects = () => [TARGET] as unknown as DOMRectList;
  range.getBoundingClientRect = () => TARGET;
  // The shadow host, as the content script mounts it.
  const host = document.createElement("div");
  document.documentElement.append(host);
  const layer = document.createElement("div");
  host.attachShadow({ mode: "open" }).append(layer);
  return { range, layer };
}

/** The bounding box of every coordinate in a path's d attribute. */
function bbox(d: string) {
  const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "scrollY", { value: 900, configurable: true }); // a scrolled page
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});

describe("Show me marks are visible", () => {
  it("a circle is rendered at the target's box, non-zero size, in viewport coordinates (scrolled page)", () => {
    const { range, layer } = page("#ffffff");
    const d = new ShowDrawings(layer);
    expect(d.draw("CIRCLE", range)).toBe(true);
    const svg = layer.querySelector("svg")!;
    expect(svg.style.position).toBe("fixed");
    expect(svg.style.pointerEvents).toBe("none");
    expect(Number(svg.style.zIndex)).toBeGreaterThanOrEqual(2147483646);
    const pen = layer.querySelector('path[data-mark="circle"]')!;
    const b = bbox(pen.getAttribute("d")!);
    expect(b.x1 - b.x0).toBeGreaterThan(TARGET.width);
    expect(b.y1 - b.y0).toBeGreaterThan(TARGET.height);
    // Around the target, not shifted by the page's scroll.
    expect(b.x0).toBeLessThan(TARGET.left);
    expect(b.x1).toBeGreaterThan(TARGET.right);
    expect(b.y0).toBeLessThan(TARGET.top);
    expect(b.y1).toBeGreaterThan(TARGET.bottom);
    expect(b.y1).toBeLessThan(TARGET.bottom + 40);
  });

  it("uses the dark-lime token on a light page, with a halo under it; lime on a dark page", () => {
    const light = page("#ffffff");
    new ShowDrawings(light.layer).draw("CIRCLE", light.range);
    expect(light.layer.querySelector('path[data-mark="circle"]')!.getAttribute("stroke")).toBe(color.limeMark);
    expect(light.layer.querySelectorAll("path")[0]!.getAttribute("stroke")).toBe(color.markHaloOnLight);
    document.documentElement.querySelectorAll("div").forEach((d) => d.remove());
    const dark = page("#101114");
    new ShowDrawings(dark.layer).draw("UNDERLINE", dark.range);
    expect(dark.layer.querySelector('path[data-mark="underline"]')!.getAttribute("stroke")).toBe(color.lime);
    expect(color.limeMark).not.toBe(color.lime);
  });

  it("the background under the words wins over the page's", () => {
    document.body.innerHTML = `<div style="background-color: rgb(12, 12, 14)"><p id="p">dark card</p></div>`;
    document.body.style.backgroundColor = "#ffffff";
    expect(backgroundUnder(document.getElementById("p")!.firstChild!)).toBe("rgb(12, 12, 14)");
  });

  it("the stroke always finishes drawing in", () => {
    const { range, layer } = page("#ffffff");
    new ShowDrawings(layer).draw("CIRCLE", range);
    const pen = layer.querySelector('path[data-mark="circle"]') as SVGPathElement;
    vi.advanceTimersByTime(STROKE_MS + 150);
    expect(pen.style.strokeDashoffset).toBe("0");
  });

  it("'glance test drawing' is a command", () => {
    expect(parseCommand("glance test drawing", []).kind).toBe("testDrawing");
    expect(parseCommand("test drawing", []).kind).toBe("testDrawing");
  });
});
