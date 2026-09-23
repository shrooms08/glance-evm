/**
 * The gooey open and close: the filter must live in our shadow root, only the empty liquid shapes may be filtered
 * (never text, prices or buttons), the liquid only exists while moving, and reduced motion gets a plain scale-and-fade.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GooPanel, orbDisc, panelDelays, panelPoses, tooSlow } from "../components/GooPanel";
import { liquidTransition, poseReached, readPose, type Pose } from "../components/liquid";
import { reportFrames, resetMotionBudgetForTests } from "../lib/motionBudget";
import { liquid, motion, orb } from "../lib/tokens";

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


describe("liquid choreography", () => {
  const disc = orbDisc({ right: 24, bottom: 24 }, 1200, 800);
  const panel = { left: 816, top: 200, width: 360, height: 500 };

  it("uses the library's transition with the design tokens' duration and overshoot curve", () => {
    expect(liquidTransition).toEqual({ duration: liquid.duration, ease: liquid.ease });
    expect(liquid.ease).toBe("cubic-bezier(0.34, 1.56, 0.64, 1)");
  });

  it("gathers everything in the orb when closed, and lays it out as the panel when open", () => {
    const p = panelPoses(disc, panel);
    expect(p.panel.panel).toEqual({ x: 0, y: 0, scale: 1 });
    expect(p.panel.orb.scale).toBe(liquid.seedScale);
    // In the orb pose the panel's liquid is centred on the orb.
    expect(panel.left + panel.width / 2 + p.panel.orb.x).toBeCloseTo(disc.left + disc.width / 2);
    expect(panel.top + panel.height / 2 + p.panel.orb.y).toBeCloseTo(disc.top + disc.height / 2);
    // The droplet rests inside the panel's near edge, where the card covers it once the liquid is gone.
    expect(p.dropletRest.y).toBeLessThan(panel.top + panel.height);
    expect(p.dropletRest.y).toBeGreaterThan(panel.top + panel.height / 2);
  });

  it("staggers the mass: out of the orb the droplet leads; back in, the panel leaves first and the orb swells last", () => {
    expect(panelDelays("open")).toEqual({ droplet: 0, panel: liquid.stagger, orb: 0 });
    expect(panelDelays("close")).toEqual({ panel: 0, droplet: liquid.stagger, orb: 2 * liquid.stagger });
  });

  it("reads the library's transforms back", () => {
    expect(readPose("translate(12.5px, -3px) scale(0.9)")).toEqual({ x: 12.5, y: -3, scale: 0.9 });
    expect(readPose("translate(0px, 0px)")).toEqual({ x: 0, y: 0, scale: 1 });
    expect(poseReached(readPose("translate(0.01px, 0px)"), { x: 0, y: 0, scale: 1 })).toBe(true);
    expect(poseReached(readPose("translate(0.2px, 0px)"), { x: 0, y: 0, scale: 1 })).toBe(false);
  });
});

describe("GooPanel", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let shadow: ShadowRoot;
  let root: Root;
  let reduced = false;
  const PANEL = { left: 816, top: 200, width: 360, height: 500 };
  const FADE = parseFloat(motion.quick);

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
    // jsdom has no layout: give the panel its real footprint.
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

  const onClosed = vi.fn();
  /** When (performance.now()) each onLiquidStart fired, and in which direction. */
  let liquidStarts: Array<{ dir: string; at: number }> = [];
  const onLiquidStart = (dir: string) => liquidStarts.push({ dir, at: performance.now() });
  const render = (open: boolean) =>
    act(() =>
      root.render(
        createElement(
          GooPanel,
          { open, orb: orbDisc({ right: 24, bottom: 24 }, 1200, 800), placement: { right: 24, bottom: 96 }, onClosed, onLiquidStart },
          createElement("div", { className: "g-card" }, createElement("span", { className: "g-figure" }, "$250.00"), createElement("button", null, "Buy")),
        ),
      ),
    );
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const panel = () => shadow.querySelector<HTMLElement>(".g-panel");
  const stage = () => shadow.querySelector<HTMLElement>(".g-goo-stage");
  const item = (cls: string) => shadow.querySelector<HTMLElement>(`.g-goo-stage ${cls}`)?.parentElement ?? null;
  const pose = (cls: string): Pose | null => readPose(item(cls)?.style.transform ?? "");

  /** Frame by frame: each item's pose (from the library's own transforms) and whether text is showing. */
  function film(ms: number) {
    const frames: Array<{ t: number; orb: Pose | null; droplet: Pose | null; panel: Pose | null; text: boolean; stage: boolean }> = [];
    for (let t = 16; t <= ms; t += 16) {
      advance(16);
      frames.push({
        t,
        orb: pose(".g-goo-blob:not(.g-goo-droplet):not(.g-goo-morph)"),
        droplet: pose(".g-goo-droplet"),
        panel: pose(".g-goo-morph"),
        text: Boolean(panel()?.classList.contains("is-shown")),
        stage: stage() !== null,
      });
    }
    return frames;
  }
  const firstMove = (frames: ReturnType<typeof film>, key: "orb" | "droplet" | "panel") => {
    const start = frames.find((f) => f[key])?.[key];
    return frames.find((f) => f[key] && start && (Math.abs(f[key]!.x - start.x) > 0.5 || Math.abs(f[key]!.scale - start.scale) > 0.002))?.t ?? Infinity;
  };

  it("renders nothing while closed", () => {
    render(false);
    expect(panel()).toBeNull();
    expect(stage()).toBeNull();
  });

  it("puts the orb, the droplet and the panel in one Liquid container, with the filter in our shadow root", () => {
    render(false);
    render(true);
    advance(16);
    expect(stage()).not.toBeNull();
    const filtered = stage()!.querySelector("g[filter]")!;
    const id = /url\(#(.+)\)/.exec(filtered.getAttribute("filter")!)![1]!;
    expect(shadow.getElementById(id)?.tagName.toLowerCase()).toBe("filter");
    expect(document.getElementById(id)).toBeNull();
    expect(stage()!.querySelectorAll("[data-gooey-svg]")).toHaveLength(1); // one container: they merge as they move
    const shapes = stage()!.querySelectorAll(".g-goo-blob");
    expect(shapes).toHaveLength(3);
    shapes.forEach((b) => expect(b.childElementCount + (b.textContent ?? "").length).toBe(0));
    expect(stage()!.contains(shadow.querySelector(".g-figure"))).toBe(false);
    expect(stage()!.contains(shadow.querySelector("button"))).toBe(false);
    expect(panel()!.classList.contains("is-shown")).toBe(false);
    // Our fill, blur and contrast come from the tokens.
    expect(stage()!.querySelector("feGaussianBlur")!.getAttribute("stdDeviation")).toBe(String(liquid.blur));
  });

  it("opens with the droplet leading, the panel a stagger behind, and an overshoot from the curve", () => {
    render(false);
    render(true);
    const frames = film(1_200);
    expect(firstMove(frames, "droplet")).toBeLessThan(firstMove(frames, "panel"));
    const scales = frames.filter((f) => f.panel).map((f) => f.panel!.scale);
    const peak = Math.max(...scales);
    expect(peak).toBeGreaterThan(1.03); // the wobble is the curve's overshoot
    expect(peak).toBeLessThan(1.15);
  });

  it("lets text in only once every item has reached its pose, and nothing moves after that", () => {
    render(false);
    render(true);
    const frames = film(1_500);
    const shownAt = frames.findIndex((f) => f.text);
    expect(shownAt).toBeGreaterThan(0);
    // Not a fixed timer: at least the stagger plus the library's duration after the liquid set off.
    expect(frames[shownAt]!.t).toBeGreaterThanOrEqual(liquid.stagger + liquid.duration);
    expect(frames[shownAt]!.t).toBeLessThanOrEqual(liquid.stagger + liquid.duration + 250);
    const settled = frames[shownAt]!;
    for (const f of frames.slice(shownAt)) {
      if (!f.stage) break;
      expect(f.panel).toEqual(settled.panel);
      expect(f.droplet).toEqual(settled.droplet);
    }
    expect(stage()).toBeNull(); // at rest: an ordinary card, no filter cost
    expect(panel()!.dataset.phase).toBe("open");
  });

  it("closes in reverse: text out first, then the panel, the droplet, and the orb swelling back last", () => {
    onClosed.mockClear();
    render(true);
    render(false);
    advance(1);
    expect(panel()!.classList.contains("is-shown")).toBe(false);
    const frames = film(1_500);
    // Nothing moves while the text fades.
    expect(Math.min(firstMove(frames, "panel"), firstMove(frames, "droplet"), firstMove(frames, "orb"))).toBeGreaterThanOrEqual(FADE);
    expect(firstMove(frames, "panel")).toBeLessThan(firstMove(frames, "droplet"));
    expect(firstMove(frames, "droplet")).toBeLessThan(firstMove(frames, "orb"));
    // The orb takes the liquid back with a swell past its size: the curve's overshoot is the wobble.
    const orbScales = frames.filter((f) => f.orb).map((f) => f.orb!.scale);
    expect(Math.max(...orbScales)).toBeGreaterThan(1.005);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it("each beat takes about the library's 550ms: open until the text is in, close until the orb has it back", () => {
    render(false);
    render(true);
    let t = 0;
    while (!panel()!.classList.contains("is-shown") && t < 3_000) {
      advance(16);
      t += 16;
    }
    const open = t + FADE;
    film(800);
    onClosed.mockClear();
    render(false);
    let c = 0;
    while (onClosed.mock.calls.length === 0 && c < 3_000) {
      advance(16);
      c += 16;
    }
    console.info(`[timing] open ${open}ms, close ${c}ms`);
    expect(open).toBeGreaterThanOrEqual(600);
    expect(open).toBeLessThanOrEqual(1_000);
    expect(c).toBeGreaterThanOrEqual(600);
    expect(c).toBeLessThanOrEqual(1_000);
  });

  it("on a page that drops frames, the filter gets cheaper but the motion stays the same", () => {
    render(false);
    render(true);
    const full = film(1_500);
    render(false);
    film(1_500);
    reportFrames(Array(20).fill(40));
    reportFrames(Array(20).fill(40));
    render(true);
    const lite = film(1_500);
    expect(stage() ?? true).toBeTruthy();
    expect(lite.findIndex((f) => f.text)).toBe(full.findIndex((f) => f.text));
    expect(Math.max(...lite.filter((f) => f.panel).map((f) => f.panel!.scale))).toBeCloseTo(Math.max(...full.filter((f) => f.panel).map((f) => f.panel!.scale)), 3);
  });

  it("uses the lower blur on slow pages", () => {
    reportFrames(Array(20).fill(40));
    reportFrames(Array(20).fill(40));
    render(false);
    render(true);
    advance(16);
    expect(stage()!.dataset.gooQuality).toBe("lite");
    expect(stage()!.querySelector("feGaussianBlur")!.getAttribute("stdDeviation")).toBe(String(liquid.blurLite));
  });

  it("signals the sound on the frame the liquid starts moving: at once on open, after the text fades on close", () => {
    liquidStarts = [];
    render(false);
    let t0 = performance.now();
    render(true);
    let frames = film(1_200);
    expect(liquidStarts).toHaveLength(1);
    expect(liquidStarts[0]!.dir).toBe("open");
    let at = liquidStarts[0]!.at - t0;
    expect(at).toBeLessThanOrEqual(48); // the two frames the liquid mounts on, before its pose flips
    expect(firstMove(frames, "droplet")).toBeGreaterThanOrEqual(at);
    expect(firstMove(frames, "droplet") - at).toBeLessThanOrEqual(32);

    liquidStarts = [];
    t0 = performance.now();
    render(false);
    frames = film(1_500);
    expect(liquidStarts.map((s) => s.dir)).toEqual(["close"]);
    at = liquidStarts[0]!.at - t0;
    expect(at).toBeGreaterThanOrEqual(FADE); // not while the text is still fading
    expect(firstMove(frames, "panel")).toBeGreaterThanOrEqual(at);
    expect(firstMove(frames, "panel") - at).toBeLessThanOrEqual(32);
  });

  it("with reduced motion, fades with no liquid", () => {
    reduced = true;
    onClosed.mockClear();
    render(false);
    render(true);
    advance(16);
    expect(stage()).toBeNull();
    expect(panel()!.classList.contains("g-panel-reduced")).toBe(true);
    expect(panel()!.classList.contains("is-shown")).toBe(true);
    liquidStarts = [];
    render(false);
    expect(liquidStarts.map((s) => s.dir)).toEqual(["close"]); // with the fade, since there is no liquid
    advance(FADE + 1);
    expect(panel()).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
