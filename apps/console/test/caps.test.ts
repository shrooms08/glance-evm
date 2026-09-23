/** The caps exactly as the vault computes them: closed caps round down, used-vs-remaining never goes negative. */
import { describe, expect, it } from "vitest";

import type { Money, VaultView, WindowView } from "../lib/api";
import { capRows, capUse, effectiveCap, freesUp, marketNow } from "../lib/caps";

const m = (raw: bigint): Money => ({ raw: raw.toString(), value: "", formatted: "" });
const win = (used: bigint, over: Partial<WindowView> = {}): WindowView => ({
  used: m(used),
  limit: m(0n),
  remaining: m(0n),
  nextReleaseAt: null,
  nextReleaseInSeconds: null,
  nextReleaseAmount: m(0n),
  clearsAt: null,
  clearsInSeconds: null,
  tradesInWindow: 0,
  reconstructed: true,
  ...over,
});

const vault = (buyUsed: bigint, sellUsed = 0n, weekendCapBps = 2_500) =>
  ({
    limits: { perTrade: m(100_000_000n), dailyBuy: m(500_000_000n), dailySell: m(500_000_000n), maxSlippageBps: 100, maxSlippage: "1%", weekendCapBps, weekendCap: "25%" },
    buyWindow: win(buyUsed),
    sellWindow: win(sellUsed),
  }) as Pick<VaultView, "limits" | "buyWindow" | "sellWindow">;

describe("effective caps", () => {
  it("are the caps as set while open, and weekendCapBps of them while closed, rounded down like Math.mulDiv", () => {
    expect(effectiveCap(100_000_000n, "OPEN", 2_500)).toBe(100_000_000n);
    expect(effectiveCap(100_000_000n, "CLOSED", 2_500)).toBe(25_000_000n);
    expect(effectiveCap(333n, "CLOSED", 3_333)).toBe(110n); // 110.9889 -> 110
    expect(effectiveCap(100_000_000n, "CLOSED", 0)).toBe(0n);
  });
});

describe("used versus remaining", () => {
  it("counts the same 24h total against both caps", () => {
    const [perTrade, buy, sell] = capRows(vault(10_000_000n));
    expect(perTrade!.rolling).toBe(false);
    expect(buy!.open).toMatchObject({ cap: 500_000_000n, used: 10_000_000n, remaining: 490_000_000n, usedBps: 200 });
    expect(buy!.closed).toMatchObject({ cap: 125_000_000n, used: 10_000_000n, remaining: 115_000_000n, usedBps: 800 });
    expect(sell!.open.remaining).toBe(500_000_000n);
  });

  it("shows nothing left, never a negative, when the market closed after trading at the open caps", () => {
    const u = capUse(125_000_000n, 200_000_000n);
    expect(u.remaining).toBe(0n);
    expect(u.over).toBe(75_000_000n);
    expect(u.usedBps).toBe(10_000);
  });

  it("handles a zero cap", () => {
    expect(capUse(0n, 0n).usedBps).toBe(0);
    expect(capUse(0n, 1n).usedBps).toBe(10_000);
  });
});

describe("when the window frees up", () => {
  it("says so in words, rounding up", () => {
    expect(freesUp(win(0n), 6)).toBe("Nothing used in the last 24 hours.");
    expect(
      freesUp(win(35_000_000n, { tradesInWindow: 2, nextReleaseAt: 100, nextReleaseInSeconds: 3_000, nextReleaseAmount: m(25_000_000n), clearsAt: 200, clearsInSeconds: 80_000 }), 6),
    ).toBe("$25 frees up in 50 minutes. Fully clear in 23 hours.");
    expect(freesUp(win(10_000_000n, { tradesInWindow: 1, nextReleaseAt: 100, nextReleaseInSeconds: 86_000, nextReleaseAmount: m(10_000_000n), clearsAt: 100, clearsInSeconds: 86_000 }), 6)).toBe(
      "$10 frees up in 24 hours.",
    );
  });
});

describe("which caps are in force", () => {
  it("follows the state the vault applies to each stock", () => {
    expect(marketNow([{ symbol: "TSLA", marketState: "OPEN" }, { symbol: "AMD", marketState: "OPEN" }]).state).toBe("OPEN");
    expect(marketNow([{ symbol: "TSLA", marketState: "CLOSED" }]).state).toBe("CLOSED");
    const mixed = marketNow([{ symbol: "TSLA", marketState: "OPEN" }, { symbol: "NFLX", marketState: "CLOSED" }]);
    expect(mixed).toEqual({ state: "MIXED", open: ["TSLA"], closed: ["NFLX"], stale: [] });
    expect(marketNow([{ symbol: "TSLA", marketState: "STALE" }]).state).toBe("STALE");
  });
});
