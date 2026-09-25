/**
 * The landing page: the glyph bursts and the pixel cursor at their sizes, the particle pool never growing, the demo
 * video embed, and the page's copy (the changes from the design, its links, no em or en dashes).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoEmbed } from "../lib/demoVideo";
import { BURST, cursorSvg, CURSOR_MAP, ParticlePool, particleAt, POOL_SIZE } from "../lib/glyphBurst";

// next/image and the client story need a browser build; the copy and links are what's under test here.
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => <span data-img={alt} /> }));
vi.mock("../app/(landing)/HeroStory", () => ({ HeroStory: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

/** A deterministic random source. */
function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

describe("glyph bursts", () => {
  it("18 to 24 glyphs, 11 to 13px, flung 30 to 80px", () => {
    const rand = seeded(7);
    for (let i = 0; i < 50; i++) {
      const pool = new ParticlePool(POOL_SIZE, rand);
      const n = pool.burst(100, 100, 0);
      expect(n).toBeGreaterThanOrEqual(18);
      expect(n).toBeLessThanOrEqual(24);
      expect(pool.count).toBe(n);
      for (const p of pool.slots.slice(0, n)) {
        expect(p.size).toBeGreaterThanOrEqual(BURST.minSize);
        expect(p.size).toBeLessThanOrEqual(BURST.maxSize);
        const spread = Math.hypot(p.dx, p.dy);
        expect(spread).toBeGreaterThanOrEqual(30 - 1e-9);
        expect(spread).toBeLessThanOrEqual(80 + 1e-9);
      }
    }
  });

  it("the pool is fixed: a flood of bursts reuses slots, and spent particles are pruned", () => {
    const pool = new ParticlePool(64, seeded(3));
    const slots = new Set(pool.slots);
    for (let i = 0; i < 20; i++) pool.burst(0, 0, i);
    expect(pool.count).toBe(64);
    expect(pool.slots).toHaveLength(64);
    expect(new Set(pool.slots)).toEqual(slots);
    pool.prune(10_000);
    expect(pool.count).toBe(0);
  });

  it("a particle eases out, fades, and is gone at the end of its life", () => {
    const pool = new ParticlePool(8, seeded(5));
    pool.burst(50, 50, 0);
    const p = pool.slots[0]!;
    expect(particleAt(p, 0)).toMatchObject({ x: 50, y: 50, alpha: 1 });
    expect(particleAt(p, p.life / 2)!.alpha).toBeCloseTo(0.75);
    expect(particleAt(p, p.life)).toBeNull();
  });

  it("the pixel cursor is about 24px, drawn from the design's 9 x 13 map", () => {
    const c = cursorSvg(24);
    expect(c.width).toBe(24);
    expect(c.height).toBe(35);
    expect(c.rects.length).toBe(CURSOR_MAP.join("").replaceAll(".", "").length);
  });
});

describe("the demo video", () => {
  it("embeds YouTube (privacy mode) and Loom links", () => {
    expect(demoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      provider: "youtube",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0",
    });
    expect(demoEmbed("https://youtu.be/dQw4w9WgXcQ")?.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0");
    expect(demoEmbed("https://www.loom.com/share/GlanceDemoLoomVideo")).toEqual({
      provider: "loom",
      src: "https://www.loom.com/embed/GlanceDemoLoomVideo",
    });
  });

  it("anything else (unset, another host, not https) shows the placeholder", () => {
    expect(demoEmbed(undefined)).toBeNull();
    expect(demoEmbed("")).toBeNull();
    expect(demoEmbed("https://example.com/video.mp4")).toBeNull();
    expect(demoEmbed("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(demoEmbed("javascript:alert(1)")).toBeNull();
  });
});

describe("the landing page", () => {
  async function renderPage() {
    const { default: LandingPage } = await import("../app/(landing)/page");
    return render(<LandingPage />);
  }

  it("carries the changes from the design", async () => {
    await renderPage();
    expect(screen.getByText("0.73s")).toBeTruthy();
    expect(screen.getByText("to the first spoken word in our benchmark")).toBeTruthy();
    expect(screen.queryByText(/Under 1s/)).toBeNull();
    expect(screen.getByText("On mainnet the vault reads Chainlink's feeds directly. On this testnet, Glance's keeper mirrors them.")).toBeTruthy();
    const sells = screen.getByText("Sells per 24h").closest("tr")!;
    expect(sells.textContent).toBe("Sells per 24h$500$125");
  });

  it("Get Glance goes to /install, Open console to /dashboard, Watch the demo to the video", async () => {
    await renderPage();
    for (const a of screen.getAllByRole("link", { name: "Get Glance" })) expect(a.getAttribute("href")).toBe("/install");
    for (const a of screen.getAllByRole("link", { name: "Open console" })) expect(a.getAttribute("href")).toBe("/dashboard");
    expect(screen.getByRole("link", { name: /Watch the demo/ }).getAttribute("href")).toBe("#demo");
    expect(document.getElementById("demo")).toBeTruthy();
    expect(screen.getByTestId("demo-placeholder")).toBeTruthy();
  });

  it("no em or en dashes anywhere in the page's source", () => {
    for (const f of ["page.tsx", "HeroStory.tsx", "layout.tsx", "opengraph-image.alt.txt"]) {
      const src = readFileSync(resolve(import.meta.dirname, "../app/(landing)", f), "utf8");
      expect(src, f).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
