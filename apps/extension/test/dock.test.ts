/** Beat 2 of float <-> dock: the orb pours off to the edge (or flows back) as one staggered, library-driven mass. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DockTransition, dockPieces, panelCueMs } from "../components/DockTransition";
import { orbDisc } from "../components/GooPanel";
import { readPose } from "../components/liquid";
import { liquid } from "../lib/tokens";

const VW = 1200;
const ORB = orbDisc({ right: 24, bottom: 24 }, VW, 800);
const LAST = liquid.dockTrail.length * liquid.stagger;

describe("dock pieces", () => {
  it("dock: the orb leads off toward the edge and the trailing droplets follow a stagger apart, all off-screen", () => {
    const pieces = dockPieces("dock", ORB, VW);
    expect(pieces).toHaveLength(1 + liquid.dockTrail.length);
    expect(pieces.map((p) => p.delay)).toEqual(pieces.map((_, i) => i * liquid.stagger));
    expect(pieces[0]!.size).toBe(ORB.width);
    for (const p of pieces) {
      expect(p.from).toEqual({ x: 0, y: 0, scale: 1 });
      // Its left edge at the end is past the viewport's right edge.
      expect(ORB.left + ORB.width / 2 + p.to.x - (p.size * p.to.scale) / 2).toBeGreaterThan(VW);
    }
  });

  it("undock: the droplets come in first and the orb-sized lead arrives last, exactly at the saved position", () => {
    const pieces = dockPieces("undock", ORB, VW);
    expect(pieces[0]!.delay).toBe(LAST); // the orb arrives last
    expect(pieces.at(-1)!.delay).toBe(0);
    for (const p of pieces) expect(p.to).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("asks for the side panel just before the last liquid leaves the screen", () => {
    expect(panelCueMs()).toBe(LAST + liquid.duration - liquid.panelLeadMs);
  });
});

describe("DockTransition", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let reduced = false;
  let host: HTMLElement;

  beforeEach(() => {
    reduced = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("innerWidth", VW);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function play(kind: "dock" | "undock") {
    const events: Array<[string, number]> = [];
    const lead: number[] = [];
    let t = 0;
    act(() =>
      root.render(
        createElement(DockTransition, { kind, orb: ORB, onPanelCue: () => events.push(["cue", t]), onDone: () => events.push(["done", t]) }),
      ),
    );
    while (!events.some(([e]) => e === "done") && t < 3_000) {
      act(() => vi.advanceTimersByTime(16));
      t += 16;
      const w = host.querySelector<HTMLElement>(".g-dock-drop")?.parentElement;
      if (w) lead.push(readPose(w.style.transform)?.x ?? 0);
    }
    return { events, lead };
  }

  it("dock: one Liquid mass pours off; the side panel is cued as the last liquid leaves; done in about one beat", () => {
    act(() => root.render(createElement(DockTransition, { kind: "dock", orb: ORB, onDone() {} })));
    expect(host.querySelectorAll("[data-gooey-svg]")).toHaveLength(1);
    expect(host.querySelectorAll(".g-goo-blob")).toHaveLength(1 + liquid.dockTrail.length);
    act(() => root.unmount());
    root = createRoot(host);

    const { events, lead } = play("dock");
    const cue = events.find(([e]) => e === "cue")![1];
    const done = events.find(([e]) => e === "done")![1];
    expect(cue).toBeGreaterThanOrEqual(panelCueMs());
    expect(done).toBeGreaterThan(cue);
    expect(done).toBeGreaterThanOrEqual(LAST + liquid.duration);
    expect(done).toBeLessThanOrEqual(LAST + liquid.duration + 250);
    // The overshoot curve carries it past its end point before it settles: liquid, not a linear slide.
    const end = dockPieces("dock", ORB, VW)[0]!.to.x;
    expect(Math.max(...lead)).toBeGreaterThan(end + 1);
  });

  it("undock: flows back in and settles at the orb's position; no side panel cue", () => {
    const { events, lead } = play("undock");
    expect(events.map(([e]) => e)).toEqual(["done"]);
    expect(lead[0]!).toBeGreaterThan(0);
    expect(Math.min(...lead)).toBeLessThan(-0.5); // overshoots past the orb's spot, then settles
    expect(lead.at(-1)!).toBeCloseTo(0, 1);
  });

  it("with reduced motion: no liquid, the panel is requested at once, and it's over after a short fade", () => {
    reduced = true;
    const cue = vi.fn();
    const done = vi.fn();
    act(() => root.render(createElement(DockTransition, { kind: "dock", orb: ORB, onPanelCue: cue, onDone: done })));
    expect(host.querySelector(".g-goo-stage")).toBeNull();
    expect(cue).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(130));
    expect(done).toHaveBeenCalledTimes(1);
  });
});
