/** Springs: subtle, one overshoot at most, reactive to speed, capped, and never where they'd get in the way. */
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrbState } from "../components/Orb";
import { useOrbMotion, type OrbMotion } from "../components/useOrbMotion";
import { idlePulseAllowed, gooQuality, reportFrames, reportIdleFrames, resetMotionBudgetForTests } from "../lib/motionBudget";
import { overshootFor, runSpring, stepSpring, type SpringConfig } from "../lib/spring";
import { spring } from "../lib/tokens";

/** Simulates a spring from 0 to 1 and returns its samples. */
function simulate(cfg: SpringConfig, opts: { fps?: number; seconds?: number; velocity?: number } = {}) {
  const fps = opts.fps ?? 60;
  const s = { value: 0, velocity: opts.velocity ?? 0 };
  const out: number[] = [];
  for (let i = 0; i < (opts.seconds ?? 1.5) * fps; i++) {
    stepSpring(s, 1, cfg, 1 / fps);
    out.push(s.value);
  }
  return out;
}
/** Peaks visibly past the target (over 1.5%): a damping of 0.6 leaves a second, sub-1% ripple no one can see. */
const peaks = (xs: number[]) => xs.filter((x, i) => i > 0 && i < xs.length - 1 && x > 1.015 && x >= xs[i - 1]! && x > xs[i + 1]!).length;

describe("spring tokens (the orb's own small motions)", () => {
  it("drag-follow never overshoots the cursor", () => {
    expect(spring.dragFollow.damping).toBe(1);
    expect(Math.max(...simulate(spring.dragFollow))).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("nothing is springier than serious: the jiggle is small and the shake short", () => {
    expect(spring.dragRelease.damping).toBeGreaterThanOrEqual(0.5);
    expect(spring.dragRelease.maxKick).toBeLessThanOrEqual(0.05);
    expect(spring.blockedShake.kick).toBeLessThanOrEqual(6); // px
  });

  it("reacts to speed: arriving fast overshoots further than starting from rest", () => {
    const cfg = { response: 0.3, damping: 0.6 };
    expect(Math.max(...simulate(cfg, { velocity: 6 }))).toBeGreaterThan(Math.max(...simulate(cfg)));
  });

  it("moves the same at 30, 60 and 120fps", () => {
    const cfg = { response: 0.3, damping: 0.6 };
    const at = (fps: number) => simulate(cfg, { fps, seconds: 0.2 }).at(-1)!;
    expect(at(30)).toBeCloseTo(at(120), 2);
    expect(at(60)).toBeCloseTo(at(120), 2);
  });

  it("overshootFor matches the familiar values, and a visible overshoot peaks once", () => {
    expect(overshootFor(1)).toBe(0);
    expect(overshootFor(0.72)).toBeCloseTo(0.043, 2);
    expect(overshootFor(0.5)).toBeCloseTo(0.163, 2);
    expect(peaks(simulate({ response: 0.3, damping: 0.6 }))).toBe(1);
  });
});

describe("runSpring", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("never outlasts its cap: a slow spring snaps to its target (the shape wins)", () => {
    const frames: number[] = [];
    const done = vi.fn();
    runSpring(0, 1, { response: 5, damping: 1 }, (v) => frames.push(v), done);
    vi.advanceTimersByTime(spring.maxMs + 50);
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)).toBe(1);
  });

  it("settles on its own well before the cap when tuned normally", () => {
    const done = vi.fn();
    runSpring(0, 1, spring.dragFollow, () => {}, done);
    vi.advanceTimersByTime(spring.maxMs - 50);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("motion budget", () => {
  beforeEach(() => resetMotionBudgetForTests());
  const slow = Array(30).fill(40);
  const smooth = Array(30).fill(16.7);

  it("a page that stutters on its own loses the idle pulse first, and keeps full goo", () => {
    reportIdleFrames(slow);
    expect(idlePulseAllowed()).toBe(false);
    expect(gooQuality()).toBe("full");
  });

  it("one slow motion drops the idle pulse; two in a row also lower the goo", () => {
    reportFrames(slow);
    expect(idlePulseAllowed()).toBe(false);
    expect(gooQuality()).toBe("full");
    reportFrames(slow);
    expect(gooQuality()).toBe("lite");
  });

  it("a single hiccup between smooth runs doesn't lower the goo", () => {
    reportFrames(slow);
    reportFrames(smooth);
    reportFrames(slow);
    expect(gooQuality()).toBe("full");
  });
});

describe("useOrbMotion", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let reduced = false;
  let motion: OrbMotion;
  let el: HTMLElement;

  beforeEach(() => {
    reduced = false;
    resetMotionBudgetForTests();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    const div = document.createElement("div");
    document.body.append(div);
    root = createRoot(div);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function Probe({ state, still }: { state: OrbState; still?: boolean }) {
    const ref = useRef<HTMLSpanElement>(null);
    motion = useOrbMotion(ref, state, { still });
    return createElement("span", { ref, id: "orb" });
  }
  const render = (state: OrbState, still = false) => {
    act(() => root.render(createElement(Probe, { state, still })));
    el = document.getElementById("orb")!;
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const film = (ms: number) => {
    const xs: string[] = [];
    for (let t = 0; t < ms; t += 16) {
      advance(16);
      xs.push(el.style.transform);
    }
    return xs;
  };

  it("breathes only when idle, and never while a confirm card holds it still", () => {
    render("idle");
    expect(motion.breathe).toBe(true);
    render("idle", true);
    expect(motion.breathe).toBe(false);
    render("thinking");
    expect(motion.breathe).toBe(false);
  });

  it("stops breathing when the page can't afford it", () => {
    render("idle");
    act(() => reportIdleFrames(Array(30).fill(40)));
    render("idle");
    expect(motion.breathe).toBe(false);
  });

  it("shakes sideways once when a trade is refused, then settles", () => {
    render("thinking");
    render("blocked");
    const xs = film(spring.maxMs + 100);
    const offsets = xs.map((t) => Number(/translate\((-?[\d.]+)px/.exec(t)?.[1] ?? 0));
    expect(Math.min(...offsets)).toBeLessThan(-1);
    expect(Math.max(...offsets)).toBeGreaterThan(0); // it swings back past centre: a shake, not a nudge
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(spring.blockedShake.kick);
    expect(xs.at(-1)).toBe("");
    // Staying blocked doesn't shake again.
    render("blocked");
    expect(film(100).every((t) => t === "")).toBe(true);
  });

  it("jiggles on release in proportion to speed", () => {
    render("idle");
    act(() => motion.release(50));
    expect(film(100).every((t) => t === "")).toBe(true); // a slow drop doesn't jiggle
    act(() => motion.release(5000));
    const jiggle = film(spring.maxMs + 100).map((t) => Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 1));
    expect(Math.min(...jiggle)).toBeLessThan(1);
    expect(Math.min(...jiggle)).toBeGreaterThanOrEqual(1 - spring.dragRelease.maxKick - 1e-6);
  });

  it("trails the cursor while dragging and catches up without passing it", () => {
    render("idle");
    act(() => motion.follow(40, 0)); // the anchor jumped 40px right
    const offsets = film(spring.maxMs + 100).map((t) => Number(/translate\((-?[\d.]+)px/.exec(t)?.[1] ?? 0));
    expect(offsets[0]).toBeLessThan(0); // still behind
    expect(Math.max(...offsets)).toBeLessThanOrEqual(0.05); // never overshoots the cursor
    expect(offsets.at(-1)).toBe(0);
  });

  it("with reduced motion: no springs, no breathing", () => {
    reduced = true;
    render("idle");
    expect(motion.breathe).toBe(false);
    act(() => {
      motion.follow(40, 0);
      motion.release(5000);
    });
    render("blocked");
    expect(film(200).every((t) => t === "")).toBe(true);
  });
});
