import { describe, expect, it } from "vitest";

import type { Guard } from "../lib/api-types";
import { viewForGuard } from "../lib/guard";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const g = (code: string, detail: Guard["detail"] = {}, message = "msg"): Guard => ({ code, error: code, message, args: {}, detail });

describe("blocked card decisions", () => {
  it("per-trade cap: offers the cap as a one-tap retry", () => {
    const v = viewForGuard(g("PER_TRADE_CAP", { requested: "150000000", limit: "100000000", suggestedAmount: "100000000" }, "That's over your $100 per trade limit. Want me to buy $100 instead?"), 6, NOW);
    expect(v.title).toBe("Held to your per-trade limit");
    expect(v.message).toBe("That's over your $100 per trade limit. Want me to buy $100 instead?");
    expect(v.meta).toBe("Guard · per-trade cap $100");
    expect(v.primary).toEqual({ kind: "retry", amount: "100", label: "Buy $100 instead" });
    expect(v.facts).toEqual([
      { label: "You asked for", value: "$150" },
      { label: "Limit per trade", value: "$100" },
    ]);
  });

  it("per-trade cap of zero (closed market, no trading): no retry", () => {
    expect(viewForGuard(g("PER_TRADE_CAP", { requested: "1000000", limit: "0" }), 6, NOW).primary).toBeUndefined();
  });

  it("daily cap: says when it frees up, and offers what is left", () => {
    const v = viewForGuard(g("DAILY_BUY_CAP", { used: "480000000", remaining: "20000000", limit: "500000000", retryAfterSeconds: 3 * 3600, suggestedAmount: "20000000" }), 6, NOW);
    expect(v.title).toBe("Your daily limit is used");
    expect(v.primary).toEqual({ kind: "retry", amount: "20", label: "Buy $20 instead" });
    expect(v.secondary).toEqual({ kind: "wait", seconds: 10_800, label: "Frees up in 3 hours" });
    expect(v.facts.find((f) => f.label === "Frees up")?.value).toMatch(/^in 3 hours · /);
  });

  it("daily cap fully used: only the wait", () => {
    const v = viewForGuard(g("DAILY_BUY_CAP", { used: "500000000", remaining: "0", limit: "500000000", retryAfterSeconds: 600 }), 6, NOW);
    expect(v.primary).toBeUndefined();
    expect(v.secondary?.label).toBe("Frees up in 10 minutes");
  });

  it("closed market / stale price: explains the age and offers no trade", () => {
    const v = viewForGuard(g("ORACLE_STALE", { ageSeconds: 14 * 3600 }), 6, NOW);
    expect(v.title).toBe("The price is too old to trade on");
    expect(v.facts).toEqual([{ label: "Price age", value: "14h" }]);
    expect(v.primary).toBeUndefined();
  });

  it("expired agent: sends the owner to the console", () => {
    expect(viewForGuard(g("AGENT_EXPIRED"), 6, NOW).primary).toEqual({ kind: "console", label: "Renew in the console" });
    expect(viewForGuard(g("NOT_AGENT"), 6, NOW).primary?.kind).toBe("console");
  });

  it("price moved: a fresh quote", () => {
    expect(viewForGuard(g("SLIPPAGE"), 6, NOW).primary).toEqual({ kind: "requote", label: "Get a fresh quote" });
  });

  it("unknown codes still read as protection, not error", () => {
    const v = viewForGuard(g("SOMETHING_NEW"), 6, NOW);
    expect(v.title).toBe("Your vault held this back");
    expect(JSON.stringify(v).toLowerCase()).not.toMatch(/error|fail/);
  });
});
