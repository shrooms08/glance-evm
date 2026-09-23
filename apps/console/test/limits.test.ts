/** The limits form turns what the owner types into setLimits arguments exactly, and catches what the vault would refuse. */
import { describe, expect, it } from "vitest";

import { formFromVault, parseLimits, percentToBps, sameLimits } from "../lib/limits";

const form = { perTrade: "100", dailyBuy: "500", dailySell: "500", slippage: "1", weekend: "25" };

describe("limits form", () => {
  it("parses dollars into raw USDG and percentages into whole basis points", () => {
    expect(parseLimits(form, 6)).toEqual({ ok: true, args: [100_000_000n, 500_000_000n, 500_000_000n, 100, 2_500] });
    expect(parseLimits({ ...form, perTrade: "$1,250.50", dailyBuy: "2000", dailySell: "2000", slippage: "0.5%" }, 6)).toEqual({
      ok: true,
      args: [1_250_500_000n, 2_000_000_000n, 2_000_000_000n, 50, 2_500],
    });
    expect(percentToBps("0.01")).toBe(1);
  });

  it("applies the vault's own rules before the wallet opens", () => {
    const bad = (over: Partial<typeof form>) => {
      const r = parseLimits({ ...form, ...over }, 6);
      return r.ok ? {} : r.errors;
    };
    expect(bad({ perTrade: "0" }).perTrade).toBe("The per-trade limit has to be above zero.");
    expect(bad({ perTrade: "600" }).dailyBuy).toBe("The daily buy limit can't be smaller than the per-trade limit.");
    expect(bad({ dailySell: "50" }).dailySell).toBe("The daily sell limit can't be smaller than the per-trade limit.");
    expect(bad({ slippage: "10.01" }).slippage).toBe("Slippage can be at most 10%.");
    expect(bad({ weekend: "101" }).weekend).toBe("The market-closed share can be at most 100%.");
    expect(bad({ slippage: "0.001" }).slippage).toBe("Enter a percentage, up to two decimal places.");
    expect(bad({ perTrade: "1.0000001" }).perTrade).toBe("Enter an amount in dollars, up to 6 decimal places.");
    expect(bad({ perTrade: "abc" }).perTrade).toBeDefined();
  });

  it("round-trips the vault's current limits", () => {
    const v = {
      usdg: { address: "0x0000000000000000000000000000000000000001" as const, decimals: 6, real: true },
      limits: { perTrade: { raw: "100000000", value: "", formatted: "" }, dailyBuy: { raw: "500000000", value: "", formatted: "" }, dailySell: { raw: "450000000", value: "", formatted: "" }, maxSlippageBps: 75, maxSlippage: "", weekendCapBps: 2_500, weekendCap: "" },
    };
    const f = formFromVault(v);
    expect(f).toEqual({ perTrade: "100", dailyBuy: "500", dailySell: "450", slippage: "0.75", weekend: "25" });
    const r = parseLimits(f, 6);
    expect(r.ok && sameLimits(r.args, v)).toBe(true);
  });
});
