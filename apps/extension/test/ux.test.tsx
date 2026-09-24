/**
 * Returning users and shortcuts: the portfolio shows its last copy at once (with its age) and refreshes behind it; the
 * talk command's press / press-again / hold; every trade error with exactly one action.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Positions } from "../components/Portfolio";
import type { Portfolio } from "../lib/api-types";
import { createCommandTalk, REPEAT_GAP_MS } from "../lib/commandTalk";
import { tradeErrorAction } from "../lib/errorAction";
import { cacheAge, cachedPortfolio, savePortfolio } from "../lib/portfolioCache";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => fakeBrowser.reset());
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const money = (formatted: string) => ({ raw: "0", value: "0", formatted });
const portfolio = { usdg: money("$5.00"), positions: [], totals: { value: money("$42.00"), stocksValue: money("$0"), costBasis: money("$0"), unrealizedPnl: money("$0"), unrealizedPnlPct: null, realizedPnl: money("$0") }, sentence: "" } as unknown as Portfolio;

describe("the portfolio, instantly", () => {
  it("keeps the last copy per vault, and says how old it is", async () => {
    await savePortfolio("0xAAAA000000000000000000000000000000000001", portfolio, 1_000_000);
    expect(await cachedPortfolio("0xaaaa000000000000000000000000000000000001")).toEqual({ at: 1_000_000, data: portfolio });
    expect(await cachedPortfolio("0xbbbb000000000000000000000000000000000002")).toBeNull();
    expect(cacheAge(1_000_000, 1_000_000 + 30_000)).toBe("Last known a moment ago");
    expect(cacheAge(1_000_000, 1_000_000 + 5 * 60_000)).toBe("Last known 5 minutes ago");
    expect(cacheAge(1_000_000, 1_000_000 + 3 * 3_600_000)).toBe("Last known 3 hours ago");
  });

  it("the last copy is shown at once, marked as refreshing; if the refresh fails, it stays, with Try again", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onRetry = vi.fn();
    act(() => root.render(createElement(Positions, { data: portfolio, error: null, journal: [], hasVault: true, staleAt: 1_000_000, now: 1_000_000 + 120_000, onRetry })));
    expect(host.textContent).toContain("$42.00");
    expect(host.textContent).toContain("Last known 2 minutes ago · refreshing…");
    act(() => root.render(createElement(Positions, { data: portfolio, error: "Glance can't reach its API.", journal: [], hasVault: true, staleAt: 1_000_000, now: 1_000_000 + 120_000, onRetry })));
    expect(host.textContent).toContain("couldn't refresh");
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});

describe("the talk command", () => {
  function setup() {
    vi.useFakeTimers();
    const calls: string[] = [];
    const talk = createCommandTalk({ start: () => calls.push("start"), stop: () => calls.push("stop"), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });
    return { talk, calls };
  }

  it("a tap starts listening; the next tap sends it", () => {
    const { talk, calls } = setup();
    talk.press();
    vi.advanceTimersByTime(REPEAT_GAP_MS + 10);
    expect(calls).toEqual(["start"]);
    expect(talk.state).toBe("listening");
    talk.press();
    expect(calls).toEqual(["start", "stop"]);
    expect(talk.state).toBe("idle");
  });

  it("held down (the command repeating): listening ends when the repeats stop", () => {
    const { talk, calls } = setup();
    talk.press();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(40);
      talk.press();
    }
    expect(calls).toEqual(["start"]);
    vi.advanceTimersByTime(REPEAT_GAP_MS + 10);
    expect(calls).toEqual(["start", "stop"]);
  });

  it("listening that ended some other way: the next press starts again", () => {
    const { talk, calls } = setup();
    talk.press();
    vi.advanceTimersByTime(REPEAT_GAP_MS + 10);
    talk.reset();
    talk.press();
    expect(calls).toEqual(["start", "start"]);
  });
});

describe("one action per trade error", () => {
  it("Set up my vault, Link Glance, or Try again", () => {
    expect(tradeErrorAction("NO_VAULT").label).toBe("Set up my vault");
    expect(tradeErrorAction("DEMO_LIMIT").label).toBe("Set up my vault");
    expect(tradeErrorAction("SESSION_EXPIRED").label).toBe("Link Glance");
    for (const code of ["API_OFFLINE", "TIMEOUT", "RPC_UNAVAILABLE", "REPLAYED", "INTERNAL"]) expect(tradeErrorAction(code).label).toBe("Try again");
  });
});
