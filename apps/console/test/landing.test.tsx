/**
 * The landing page: the glyph bursts and the pixel cursor at their sizes, the particle pool never growing, the demo
 * video link, and the page's copy (every number from the repo, its links, no em or en dashes).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PATTERN_NAMES } from "@glance/core/candles";

import { DEMO_VIDEO_FALLBACK, demoEmbed, demoWatchUrl } from "../lib/demoVideo";
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

  it("the hero, the safety rules and the numbers, each from the repo", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Meet Glance, your stock buddy.");
    expect(screen.getByText("Free · Chrome, Brave, Edge and Arc · Robinhood Chain testnet")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "You set the rules. Your vault enforces them." })).toBeTruthy();
    expect(screen.queryByText(/servers were stolen/)).toBeNull();
    for (const rule of [
      "Only you can withdraw your money.",
      "Glance only trades stocks on your list.",
      "Every trade and every day has a cap you can see.",
      "Smaller limits when the market is closed.",
      "Pause Glance or let its access expire, anytime.",
    ])
      expect(screen.getByText(rule)).toBeTruthy();
    // The candle count is the detector's own list; 180 is forge test (docs/audit.md); 25/25 is the README benchmark.
    expect(screen.getByText(`Glance draws on the chart on the page and spots ${Object.keys(PATTERN_NAMES).length} candle patterns.`)).toBeTruthy();
    expect(screen.getByText("180")).toBeTruthy();
    expect(screen.getByText("25/25")).toBeTruthy();
    expect(document.querySelectorAll(".lp-faq details")).toHaveLength(4);
  });

  it("Get Glance goes to /install, Open console to /dashboard; the demo opens on YouTube in a new tab, never embedded", async () => {
    await renderPage();
    for (const a of screen.getAllByRole("link", { name: "Get Glance" })) expect(a.getAttribute("href")).toBe("/install");
    for (const a of screen.getAllByRole("link", { name: "Open console" })) expect(a.getAttribute("href")).toBe("/dashboard");
    const demo = screen.getByRole("link", { name: /Watch the demo/ });
    expect(demo.getAttribute("href")).toMatch(/^https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}$/);
    expect(demo.getAttribute("target")).toBe("_blank");
    expect(demo.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("link", { name: "security notes" }).getAttribute("href")).toBe("https://github.com/shrooms08/glance-evm/blob/main/SECURITY.md");
  });

  it("the demo link follows NEXT_PUBLIC_DEMO_VIDEO_URL, as a watch page", () => {
    expect(demoWatchUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(demoWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(demoWatchUrl("https://www.loom.com/share/GlanceDemoLoomVideo")).toBe("https://www.loom.com/share/GlanceDemoLoomVideo");
    expect(demoWatchUrl(undefined)).toBe(DEMO_VIDEO_FALLBACK);
    expect(DEMO_VIDEO_FALLBACK).toBe("https://youtu.be/5sbJWA8093w");
    expect(demoWatchUrl("javascript:alert(1)")).toBe(DEMO_VIDEO_FALLBACK);
  });

  it("no em or en dashes anywhere in the page's source", () => {
    for (const f of ["page.tsx", "HeroStory.tsx", "Reveal.tsx", "layout.tsx", "opengraph-image.alt.txt"]) {
      const src = readFileSync(resolve(import.meta.dirname, "../app/(landing)", f), "utf8");
      expect(src, f).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
