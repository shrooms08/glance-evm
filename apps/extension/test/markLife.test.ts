/**
 * Show me's marks stay for the whole answer and after it (lib/markLife.ts): no timer takes them. They go on Escape,
 * the x, the next question (a cancelled answer) and on navigation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chartAnnotations } from "../lib/chartAnnotations";
import { afterAnswer, watchNavigation } from "../lib/markLife";
import { ShowDrawings } from "../lib/showDraw";

const TARGET = { left: 110, top: 430, width: 140, height: 20, right: 250, bottom: 450, x: 110, y: 430, toJSON() {} } as DOMRect;

function drawn() {
  document.body.innerHTML = `<p>Tesla shares rose after <span id="t">Revenue grew 12%</span> this quarter.</p>`;
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("t")!);
  range.getClientRects = () => [TARGET] as unknown as DOMRectList;
  range.getBoundingClientRect = () => TARGET;
  const layer = document.createElement("div");
  document.body.append(layer);
  const d = new ShowDrawings(layer);
  d.draw("CIRCLE", range);
  d.draw("UNDERLINE", range);
  return { d, marks: () => layer.querySelectorAll("path[data-mark]").length };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("marks after an answer", () => {
  it("a finished answer keeps its marks: still there a minute later", () => {
    const { d, marks } = drawn();
    const before = marks();
    expect(before).toBeGreaterThan(0);
    const clearCharts = vi.fn();
    expect(afterAnswer(false, { clearPage: () => d.clear(), clearCharts })).toBe("kept");
    vi.advanceTimersByTime(60_000);
    expect(marks()).toBe(before);
    expect(clearCharts).not.toHaveBeenCalled();
  });

  it("a cancelled answer (Escape, the x, the next question) clears the page, the charts and the chart layer at once", () => {
    const { d, marks } = drawn();
    const clearCharts = vi.fn();
    const closeLayer = vi.fn();
    expect(afterAnswer(true, { clearPage: () => d.clear(), clearCharts, closeLayer })).toBe("cleared");
    expect(marks()).toBe(0);
    expect(clearCharts).toHaveBeenCalledOnce();
    expect(closeLayer).toHaveBeenCalledOnce();
  });

  it("navigating to another URL clears them (single-page sites too)", () => {
    const { d, marks } = drawn();
    const listener = vi.fn();
    const off = chartAnnotations.subscribe("TSLA", listener);
    const stop = watchNavigation(window, () => {
      d.clear();
      chartAnnotations.clear();
    });
    vi.advanceTimersByTime(5_000);
    expect(marks()).toBeGreaterThan(0); // same URL: kept
    history.pushState({}, "", "/another-story");
    vi.advanceTimersByTime(900);
    expect(marks()).toBe(0);
    expect(listener).toHaveBeenCalledWith({ clear: true });
    stop();
    off();
  });
});
