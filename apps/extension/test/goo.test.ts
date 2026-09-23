/**
 * The gooey open and close: the filter must live in our shadow root, only the empty liquid shapes may be filtered
 * (never text, prices or buttons), the liquid only exists while moving, and reduced motion gets a plain scale-and-fade.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GooPanel, orbDisc, stretch, tooSlow } from "../components/GooPanel";
import { motion, orb } from "../lib/tokens";

const SHAPE = parseFloat(motion.panel);
const FADE = parseFloat(motion.quick);

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

  beforeEach(() => {
    reduced = false;
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
  });

  const render = (open: boolean) =>
    act(() =>
      root.render(
        createElement(
          GooPanel,
          { open, orb: orbDisc({ right: 24, bottom: 24 }, 1200, 800), placement: { right: 24, bottom: 96 } },
          createElement("div", { className: "g-card" }, createElement("span", { className: "g-figure" }, "$250.00"), createElement("button", null, "Buy")),
        ),
      ),
    );
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const panel = () => shadow.querySelector<HTMLElement>(".g-panel");
  const stage = () => shadow.querySelector<HTMLElement>(".g-goo-stage");

  it("renders nothing while closed", () => {
    render(false);
    expect(panel()).toBeNull();
    expect(stage()).toBeNull();
  });

  it("opens by melting out of the orb, with the filter inside our shadow root", () => {
    render(false);
    render(true);
    advance(16);
    expect(stage()).not.toBeNull();

    // The filter and its reference live in the same shadow tree, so url(#id) resolves.
    const filtered = stage()!.querySelector("g[filter]")!;
    const id = /url\(#(.+)\)/.exec(filtered.getAttribute("filter")!)![1]!;
    expect(shadow.getElementById(id)?.tagName.toLowerCase()).toBe("filter");
    expect(document.getElementById(id)).toBeNull();

    // Only the two empty liquid shapes are measured for the filtered layer; the panel's content is outside the stage.
    const blobs = stage()!.querySelectorAll(".g-goo-blob");
    expect(blobs).toHaveLength(2);
    blobs.forEach((b) => expect(b.childElementCount + (b.textContent ?? "").length).toBe(0));
    expect(stage()!.contains(shadow.querySelector(".g-figure"))).toBe(false);
    expect(stage()!.contains(shadow.querySelector("button"))).toBe(false);

    // Content waits for the liquid to take the panel's shape, then fades in.
    expect(panel()!.classList.contains("g-panel-goo")).toBe(true);
    expect(panel()!.classList.contains("is-shown")).toBe(false);
    advance(SHAPE);
    expect(panel()!.classList.contains("is-shown")).toBe(true);

    // At rest the liquid is gone: an ordinary card, no filter cost.
    advance(FADE + SHAPE + 16);
    expect(stage()).toBeNull();
    expect(panel()!.dataset.phase).toBe("open");
  });

  it("closes by fading the content first, then collapsing the liquid into the orb", () => {
    render(true);
    render(false);
    advance(1);
    expect(panel()!.classList.contains("is-shown")).toBe(false);
    expect(stage()).not.toBeNull();
    const morph = () => stage()!.querySelector<HTMLElement>(".g-goo-morph")!;
    expect(morph().style.borderRadius).toBe("var(--g-r-card)"); // still the panel's shape while the content fades
    advance(FADE * 2);
    expect(morph().style.width).toBe(`${orb.floating}px`); // then it reaches back and drains into the orb's disc
    expect(morph().style.borderRadius).toBe("50%");
    advance(SHAPE + SHAPE + 16);
    expect(panel()).toBeNull();
    expect(stage()).toBeNull();
  });

  it("with reduced motion, scales and fades with no liquid at all", () => {
    reduced = true;
    render(false);
    render(true);
    advance(16);
    expect(stage()).toBeNull();
    expect(panel()!.classList.contains("g-panel-reduced")).toBe(true);
    expect(panel()!.classList.contains("is-shown")).toBe(true);
    render(false);
    advance(FADE + 1);
    expect(panel()).toBeNull();
  });
});
