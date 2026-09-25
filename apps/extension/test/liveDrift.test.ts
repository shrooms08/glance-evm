/** The extension's card for the drift guard: the sentence, both prices, how far apart, and no retry (nothing to fix by hand). */
import { describe, expect, it } from "vitest";

import type { Guard } from "../lib/api-types";
import { viewForGuard } from "../lib/guard";

describe("PRICE_DRIFT card", () => {
  it("says the on-chain price is behind the market, with the market price, the vault's price and the gap", () => {
    const guard: Guard = {
      code: "PRICE_DRIFT",
      error: "PriceDrift",
      message: "The on-chain price is behind the market right now, so I won't trade Tesla yet.",
      args: {},
      detail: { livePrice: "$380.00", oraclePrice: "$370.00", gapBps: 270, gap: "2.7%", maxGapBps: 200, liveSource: "finnhub" },
    };
    const v = viewForGuard(guard);
    expect(v.title).toBe("The on-chain price is behind the market");
    expect(v.message).toBe("The on-chain price is behind the market right now, so I won't trade Tesla yet.");
    expect(v.facts).toEqual([
      { label: "Market price", value: "$380.00" },
      { label: "Vault price", value: "$370.00" },
      { label: "Apart", value: "2.7% (limit 2%)" },
    ]);
    expect(v.primary).toBeUndefined();
  });
});
