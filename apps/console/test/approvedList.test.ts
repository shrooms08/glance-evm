/** "What the agent can and can't do" names the vault's own approved stocks and ETFs, never a hard-coded "five". */
import { describe, expect, it } from "vitest";

import { approvedLine, approvedSymbols, symbolList } from "../lib/symbolList";

describe("the approved list", () => {
  it("reads the vault's own positions: only what it allows", () => {
    const positions = [
      { symbol: "TSLA", allowed: true },
      { symbol: "AMZN", allowed: true },
      { symbol: "SPY", allowed: false },
      { symbol: "QQQ" }, // older API: no flag means allowed
    ];
    expect(approvedSymbols(positions)).toEqual(["TSLA", "AMZN", "QQQ"]);
    expect(approvedLine({ positions })).toBe("Buy and sell the approved stocks and ETFs (TSLA, AMZN and QQQ), only through the approved desk.");
  });

  it("lists read naturally; none says so", () => {
    expect(symbolList([])).toBe("");
    expect(symbolList(["TSLA"])).toBe("TSLA");
    expect(symbolList(["TSLA", "SPY"])).toBe("TSLA and SPY");
    expect(approvedLine({ positions: [{ symbol: "TSLA", allowed: false }] })).toMatch(/None is approved yet/);
  });
});
