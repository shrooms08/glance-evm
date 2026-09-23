import { describe, expect, it } from "vitest";

import { secondsUntilFits, summarizeWindow, usedInWindow, WINDOW_SECONDS } from "../../src/window.js";

const NOW = 1_790_000_000;
const H = 3600;
const usdg = (n: number) => BigInt(n) * 1_000_000n;

describe("rolling window mirror", () => {
  const entries = [
    { timestamp: NOW - 23 * H, amount: usdg(100) },
    { timestamp: NOW - 20 * H, amount: usdg(100) },
    { timestamp: NOW - 2 * H, amount: usdg(300) },
    { timestamp: NOW - 25 * H, amount: usdg(999) }, // already expired
  ];

  it("counts only the last 24 hours, like the contract", () => {
    expect(usedInWindow(entries, NOW)).toBe(usdg(500));
    // Exactly 24h old has expired (timestamp + WINDOW > now is false).
    expect(usedInWindow([{ timestamp: NOW - WINDOW_SECONDS, amount: 1n }], NOW)).toBe(0n);
    expect(usedInWindow([{ timestamp: NOW - WINDOW_SECONDS + 1, amount: 1n }], NOW)).toBe(1n);
  });

  it("says a request fits now when there is room", () => {
    expect(secondsUntilFits(entries, NOW, usdg(600), usdg(100))).toBe(0);
  });

  it("finds when enough frees up, oldest first", () => {
    // Cap 500, full. $50 fits once the oldest $100 expires: in 1 hour.
    expect(secondsUntilFits(entries, NOW, usdg(500), usdg(50))).toBe(1 * H);
    // $150 needs both $100 entries to expire: in 4 hours.
    expect(secondsUntilFits(entries, NOW, usdg(500), usdg(150))).toBe(4 * H);
    // $500 needs everything gone: in 22 hours.
    expect(secondsUntilFits(entries, NOW, usdg(500), usdg(500))).toBe(22 * H);
  });

  it("returns null when the request is bigger than the cap itself", () => {
    expect(secondsUntilFits(entries, NOW, usdg(500), usdg(501))).toBeNull();
  });

  it("summarises the next release and when the window clears", () => {
    const s = summarizeWindow(entries, NOW);
    expect(s.used).toBe(usdg(500));
    expect(s.nextReleaseAt).toBe(NOW + 1 * H);
    expect(s.nextReleaseAmount).toBe(usdg(100));
    expect(s.clearsAt).toBe(NOW + 22 * H);
    expect(s.entries).toBe(3);
    expect(summarizeWindow([], NOW)).toMatchObject({ used: 0n, nextReleaseAt: null, clearsAt: null });
  });
});
