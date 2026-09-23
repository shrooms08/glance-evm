/** Float <-> dock as one movement: the orb drains off the edge before the side panel appears, and flows back after. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DockTransition, dockLegs, dockStart } from "../components/DockTransition";
import { orbDisc } from "../components/GooPanel";
import { goo, spring } from "../lib/tokens";

const VW = 1200;
const ORB = orbDisc({ right: 24, bottom: 24 }, VW, 800);

describe("dock geometry", () => {
  it("docking starts on the orb and ends fully past the right edge, thinned to the neck", () => {
    const start = dockStart("dock", ORB, VW);
    expect(start.cx).toBe(ORB.left + ORB.width / 2);
    const [stretch, drain] = dockLegs("dock", ORB, VW);
    expect(stretch!.to.strandTo).toBeGreaterThan(VW); // the strand reaches the edge first
    expect(drain!.cue).toBe(true); // the side panel is requested as the drain begins
    expect(drain!.to.cx - drain!.to.size / 2).toBeGreaterThan(VW);
    expect(drain!.to.size).toBe(goo.dockNeck);
  });

  it("undocking starts past the edge and reforms exactly into the orb at its saved position", () => {
    const start = dockStart("undock", ORB, VW);
    expect(start.cx - start.size / 2).toBeGreaterThan(VW);
    const [travel, reform] = dockLegs("undock", ORB, VW);
    expect(travel!.to.strandTo).toBeGreaterThan(VW); // it trails a strand back to the edge
    expect(reform!.to).toEqual({ cx: ORB.left + ORB.width / 2, size: ORB.width, strandFrom: ORB.left + ORB.width / 2, strandTo: ORB.left + ORB.width / 2 });
    expect(travel!.cfg).toBe(spring.undockTravel);
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
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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
    let t = 0;
    const drops: number[] = [];
    act(() =>
      root.render(
        createElement(DockTransition, {
          kind,
          orb: ORB,
          onPanelCue: () => events.push(["cue", t]),
          onDone: () => events.push(["done", t]),
        }),
      ),
    );
    while (!events.some(([e]) => e === "done") && t < 3_000) {
      act(() => vi.advanceTimersByTime(16));
      t += 16;
      const d = host.querySelector<HTMLElement>(".g-dock-drop");
      // Stage-relative -> viewport (the stage starts 40px left of the orb).
      if (d) drops.push(parseFloat(d.style.left) + ORB.left - 40);
    }
    return { events, drops };
  }

  it("dock: stretches, then drains; the side panel is cued as the liquid starts leaving, and it ends within ~0.6s", () => {
    const { events, drops } = play("dock");
    const cue = events.find(([e]) => e === "cue")![1];
    const done = events.find(([e]) => e === "done")![1];
    expect(cue).toBeGreaterThan(100); // not before the strand has reached the edge
    expect(done - cue).toBeGreaterThan(150); // the panel has time to appear as the liquid goes
    expect(done).toBeLessThan(800);
    expect(drops.at(-1)!).toBeGreaterThan(VW); // off-screen at the end
  });

  it("undock: a droplet travels in from the edge and reforms into the orb", () => {
    const { events, drops } = play("undock");
    expect(events.map(([e]) => e)).toEqual(["done"]); // no side panel cue when undocking
    expect(drops[0]!).toBeGreaterThan(VW - 100);
    expect(drops.at(-1)!).toBeCloseTo(ORB.left, 0); // exactly on the orb's saved position
    expect(events[0]![1]).toBeLessThan(1_000);
  });

  it("filters only the droplet and the strand, never text", () => {
    act(() => root.render(createElement(DockTransition, { kind: "dock", orb: ORB, onDone() {} })));
    const blobs = host.querySelectorAll(".g-goo-blob");
    expect(blobs).toHaveLength(2);
    blobs.forEach((b) => expect(b.textContent).toBe(""));
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
