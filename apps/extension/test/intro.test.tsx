/**
 * The Welcome page's spoken intro (lib/intro.ts, entrypoints/welcome/Intro.tsx), with a fake player: the lines play
 * in order from the manifest, skip and Escape go to the end, replay starts again at line 1, the end buttons route,
 * a blocked autoplay shows "Tap to meet Glance", and no caption has a dash.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captionFor, INTRO_LINES, introDurationMs, introFile, introStart, introStep, LINE_GAP_MS, type IntroManifest } from "../lib/intro";
import { Intro, type IntroPlayer } from "../entrypoints/welcome/Intro";

const MANIFEST = JSON.parse(readFileSync(resolve(import.meta.dirname, "../public/intro/manifest.json"), "utf8")) as IntroManifest;

/** A player that "plays" by remembering the line; the test ends it. */
function fakePlayer(blocked = false) {
  const played: number[] = [];
  let ended: (() => void) | null = null;
  const player: IntroPlayer = {
    play: vi.fn(async (i: number, onEnded: () => void) => {
      if (blocked) return "blocked" as const;
      played.push(i);
      ended = onEnded;
      return "playing" as const;
    }),
    stop: vi.fn(() => void (ended = null)),
    level: () => 0.4,
  };
  return { player, played, end: () => ended?.() };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // jsdom has no canvas: the orb draws nothing, which is fine here.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const caption = () => host.querySelector("[data-testid=intro-caption]")?.textContent ?? null;
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name);
async function render(props: { autoplay: boolean; player: IntroPlayer; onSetUp?: () => void }) {
  await act(async () => root.render(createElement(Intro, { onSetUp: () => {}, ...props })));
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
}
/** The current line ends, and the pause after it passes. */
async function next(end: () => void) {
  await act(async () => {
    end();
    await vi.advanceTimersByTimeAsync(LINE_GAP_MS + 1);
  });
}

describe("the intro's script and audio", () => {
  it("has the nine lines, with their audio, under 600 KB in all", () => {
    expect(INTRO_LINES.map((l) => l.caption)).toEqual([
      "Hey. I'm Glance.",
      "I live in your browser, on every page you read.",
      "See a company in the news? Hold ⌥V and ask me about it.",
      "Looking at a chart? I'll explain it, and draw right on it.",
      "Want in? Say “buy ten dollars of Tesla”, and I'll buy it on Robinhood Chain.",
      "I trade from a vault you own, inside limits you set. I can never withdraw a cent.",
      "When the market's closed, I slow down on my own.",
      "Pause me any time. Revoke me any time.",
      "Ready when you are.",
    ]);
    expect(INTRO_LINES[2]!.spoken).toBe("See a company in the news? Hold Option V and ask me about it.");
    expect(MANIFEST.lines.map((l) => l.caption)).toEqual(INTRO_LINES.map((l) => l.caption));
    expect(MANIFEST.lines.map((l) => l.file)).toEqual(INTRO_LINES.map((_, i) => introFile(i)));
    const bytes = MANIFEST.lines.reduce((s, l) => s + statSync(resolve(import.meta.dirname, `../public${l.file}`)).size, 0);
    expect(bytes).toBeLessThan(600 * 1024);
    expect(introDurationMs(MANIFEST)).toBeGreaterThan(20_000);
  });

  it("no caption has an em or en dash", () => {
    for (const l of INTRO_LINES) expect(l.caption + l.spoken).not.toMatch(/[‒-―]/);
  });
});

describe("sequencing", () => {
  it("steps through every line in order, then the end", () => {
    let s = introStep({ phase: "ready" }, { type: "start" });
    const seen: string[] = [];
    while (s.phase === "playing") {
      seen.push(captionFor(s)!);
      s = introStep(s, { type: "lineEnded" });
    }
    expect(seen).toEqual(INTRO_LINES.map((l) => l.caption));
    expect(s).toEqual({ phase: "end" });
  });

  it("starts by playing on install, from Settings and before setup; after setup, at the end", () => {
    expect(introStart({ installed: true, askedForIntro: false, setupComplete: true })).toBe("play");
    expect(introStart({ installed: false, askedForIntro: true, setupComplete: true })).toBe("play");
    expect(introStart({ installed: false, askedForIntro: false, setupComplete: false })).toBe("play");
    expect(introStart({ installed: false, askedForIntro: false, setupComplete: true })).toBe("end");
  });
});

describe("the intro on the page", () => {
  it("plays each line from its own file, the caption in step, and ends with Set me up and Replay intro", async () => {
    const f = fakePlayer();
    await render({ autoplay: true, player: f.player });
    expect(caption()).toBe(INTRO_LINES[0]!.caption);
    for (let i = 1; i < INTRO_LINES.length; i++) {
      await next(f.end);
      expect(caption()).toBe(INTRO_LINES[i]!.caption);
    }
    expect(button("Set me up")).toBeUndefined();
    await next(f.end);
    expect(f.played).toEqual(INTRO_LINES.map((_, i) => i));
    expect(button("Set me up")).toBeDefined();
    expect(button("Replay intro")).toBeDefined();
    expect(button("Skip intro")).toBeUndefined();
  });

  it("Skip intro goes straight to the end state, with both buttons", async () => {
    const f = fakePlayer();
    await render({ autoplay: true, player: f.player });
    await act(async () => button("Skip intro")!.click());
    expect(f.player.stop).toHaveBeenCalled();
    expect(button("Set me up")).toBeDefined();
    expect(button("Replay intro")).toBeDefined();
  });

  it("Escape skips too", async () => {
    const f = fakePlayer();
    await render({ autoplay: true, player: f.player });
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(button("Set me up")).toBeDefined();
  });

  it("Replay intro starts again at line 1", async () => {
    const f = fakePlayer();
    await render({ autoplay: false, player: f.player });
    expect(f.played).toEqual([]); // set up already: the end state, nothing plays
    await act(async () => button("Replay intro")!.click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(f.played).toEqual([0]);
    expect(caption()).toBe(INTRO_LINES[0]!.caption);
  });

  it("Set me up goes to the setup steps", async () => {
    const onSetUp = vi.fn();
    await render({ autoplay: false, player: fakePlayer().player, onSetUp });
    await act(async () => button("Set me up")!.click());
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("when the browser blocks the sound: the orb and Tap to meet Glance, and no caption runs; a tap starts at line 1", async () => {
    const f = fakePlayer(true);
    await render({ autoplay: true, player: f.player });
    expect(button("Tap to meet Glance")).toBeDefined();
    expect(caption()).toBeNull();
    // The tap: the sound is allowed now.
    const ok = fakePlayer();
    f.player.play = ok.player.play;
    await act(async () => button("Tap to meet Glance")!.click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(ok.played).toEqual([0]);
    expect(caption()).toBe(INTRO_LINES[0]!.caption);
  });
});
