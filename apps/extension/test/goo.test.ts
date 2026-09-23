/**
 * The gooey open and close: the filter must live in our shadow root, only the empty liquid shapes may be filtered
 * (never text, prices or buttons), the liquid only exists while moving, and reduced motion gets a plain scale-and-fade.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GooPanel, orbDisc, stretch, tooSlow } from "../components/GooPanel";
import { reportFrames, resetMotionBudgetForTests } from "../lib/motionBudget";
import { motion, orb } from "../lib/tokens";

describe("frame budget", () => {
  it("keeps full quality at 60fps and drops it when frames are long", () => {
    expect(tooSlow(Array(20).fill(16.7))).toBe(false);
    expect(tooSlow(Array(20).fill(28))).toBe(true);
    expect(tooSlow([...Array(12).fill(16), ...Array(8).fill(50)])).toBe(true);
    expect(tooSlow([40, 40])).toBe(false); // too few frames to judge
  });
});

describe("orbDisc", () => {
  it("is the 56px disc centred in the 64px orb button", () => {
    expect(orbDisc({ right: 24, bottom: 24 }, 1000, 800)).toEqual({ left: 1000 - 24 - 64 + 4, top: 800 - 24 - 64 + 4, width: orb.floating, height: orb.floating });
  });
});

describe("stretch", () => {
  it("is one piece covering the panel and reaching down over the orb", () => {
    const disc = { left: 1112, top: 716, width: 56, height: 56 };
    const panel = { left: 816, top: 200, width: 360, height: 500 };
    expect(stretch(disc, panel)).toEqual({ left: 816, top: 200, width: 360, height: 572 });
  });
});

describe("GooPanel", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let shadow: ShadowRoot;
  let root: Root;
  let reduced = false;
  const PANEL = { left: 816, top: 200, width: 360, height: 500 };
  const STRETCH_H = 572; // panel top (200) down to the orb disc's bottom (772)

  beforeEach(() => {
    reduced = false;
    resetMotionBudgetForTests();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // jsdom has no layout: give the panel its real footprint so the liquid's geometry can be checked.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const r = this.classList.contains("g-panel") ? PANEL : { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {} } as DOMRect;
    });
    const host = document.createElement("div");
    document.body.append(host);
    shadow = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    shadow.append(mount);
    root = createRoot(mount);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const onAbsorbed = vi.fn();
  const render = (open: boolean) =>
    act(() =>
      root.render(
        createElement(
          GooPanel,
          { open, orb: orbDisc({ right: 24, bottom: 24 }, 1200, 800), placement: { right: 24, bottom: 96 }, onAbsorbed },
          createElement("div", { className: "g-card" }, createElement("span", { className: "g-figure" }, "$250.00"), createElement("button", null, "Buy")),
        ),
      ),
    );
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const panel = () => shadow.querySelector<HTMLElement>(".g-panel");
  const stage = () => shadow.querySelector<HTMLElement>(".g-goo-stage");
  const morph = () => stage()?.querySelector<HTMLElement>(".g-goo-morph") ?? null;

  /** Steps frame by frame, recording the liquid box and whether text is showing. */
  function film(ms: number) {
    const frames: Array<{ w: number; h: number; text: boolean }> = [];
    for (let t = 0; t < ms; t += 16) {
      advance(16);
      const m = morph();
      if (m) frames.push({ w: parseFloat(m.style.width), h: parseFloat(m.style.height), text: Boolean(panel()?.classList.contains("is-shown")) });
    }
    return frames;
  }

  it("renders nothing while closed", () => {
    render(false);
    expect(panel()).toBeNull();
    expect(stage()).toBeNull();
  });

  it("opens by melting out of the orb, with the filter inside our shadow root", () => {
    render(false);
    render(true);
    advance(32);
    expect(stage()).not.toBeNull();

    // The filter and its reference live in the same shadow tree, so url(#id) resolves.
    const filtered = stage()!.querySelector("g[filter]")!;
    const id = /url\(#(.+)\)/.exec(filtered.getAttribute("filter")!)![1]!;
    expect(shadow.getElementById(id)?.tagName.toLowerCase()).toBe("filter");
    expect(document.getElementById(id)).toBeNull();

    // Only the two empty liquid shapes are filtered; the panel's content is outside the stage.
    const blobs = stage()!.querySelectorAll(".g-goo-blob");
    expect(blobs).toHaveLength(2);
    blobs.forEach((b) => expect(b.childElementCount + (b.textContent ?? "").length).toBe(0));
    expect(stage()!.contains(shadow.querySelector(".g-figure"))).toBe(false);
    expect(stage()!.contains(shadow.querySelector("button"))).toBe(false);
    expect(panel()!.classList.contains("is-shown")).toBe(false);
  });

  it("the open overshoots once, before any text shows, and nothing moves past the panel once it does", () => {
    render(false);
    render(true);
    const frames = film(1_500);
    const hidden = frames.filter((f) => !f.text);
    const shown = frames.filter((f) => f.text);
    expect(shown.length).toBeGreaterThan(0);

    // A visible but small overshoot of the stretched height, while the text is hidden.
    const peak = Math.max(...hidden.map((f) => f.h));
    const travel = STRETCH_H - orb.floating;
    expect(peak).toBeGreaterThan(STRETCH_H + 1);
    expect(peak - STRETCH_H).toBeLessThan(travel * 0.08);

    // One bounce at most: the height crosses its target at most twice (out past it, and back).
    const growth = hidden.filter((f) => f.h > orb.floating + 1).map((f) => Math.sign(f.h - STRETCH_H));
    const crossings = growth.slice(1).filter((sgn, i) => sgn !== 0 && growth[i] !== 0 && sgn !== growth[i]).length;
    expect(crossings).toBeLessThanOrEqual(2);

    // Once text is visible, the liquid never grows beyond the stretch or the panel's width: text sits on still liquid.
    shown.forEach((f) => {
      expect(f.w).toBeLessThanOrEqual(PANEL.width + 0.5);
      expect(f.h).toBeLessThanOrEqual(STRETCH_H + 0.5);
    });

    // At rest the liquid is gone: an ordinary card, no filter cost.
    expect(stage()).toBeNull();
    expect(panel()!.dataset.phase).toBe("open");
  });

  it("closes without a bounce: text fades first, the liquid drains into the orb, then the orb is told to wobble", () => {
    onAbsorbed.mockClear();
    render(true);
    render(false);
    advance(1);
    expect(panel()!.classList.contains("is-shown")).toBe(false);
    const frames = film(1_500);
    expect(frames.length).toBeGreaterThan(3);
    frames.forEach((f) => {
      expect(f.text).toBe(false);
      expect(f.w).toBeGreaterThanOrEqual(orb.floating - 0.5); // never shrinks past the orb
      expect(f.h).toBeLessThanOrEqual(STRETCH_H + 0.5); // never bulges past the stretch
    });
    expect(panel()).toBeNull();
    expect(stage()).toBeNull();
    expect(onAbsorbed).toHaveBeenCalledTimes(1);
  });

  it("on a page that drops frames, the open loses its overshoot, not its shape", () => {
    reportFrames(Array(20).fill(40));
    reportFrames(Array(20).fill(40));
    render(false);
    render(true);
    const frames = film(1_500);
    expect(Math.max(...frames.map((f) => f.h))).toBeLessThanOrEqual(STRETCH_H + 0.5);
    expect(stage()).toBeNull();
    expect(panel()!.dataset.phase).toBe("open");
  });

  it("with reduced motion, fades with no liquid and no spring", () => {
    reduced = true;
    render(false);
    render(true);
    advance(16);
    expect(stage()).toBeNull();
    expect(panel()!.classList.contains("g-panel-reduced")).toBe(true);
    expect(panel()!.classList.contains("is-shown")).toBe(true);
    render(false);
    advance(parseFloat(motion.quick) + 1);
    expect(panel()).toBeNull();
    expect(onAbsorbed).not.toHaveBeenCalled();
  });
});
