/** Withdraw amounts: above zero, at most the vault's USDG, at most 6 decimals, exact bigints. */
import { describe, expect, it } from "vitest";

import { parseWithdraw } from "../lib/withdraw";

const BAL = 30_000_000n; // $30

describe("parseWithdraw", () => {
  it("accepts amounts up to the balance, exactly", () => {
    expect(parseWithdraw("10", BAL, 6)).toEqual({ ok: true, amount: 10_000_000n });
    expect(parseWithdraw("$12.345678", BAL, 6)).toEqual({ ok: true, amount: 12_345_678n });
    expect(parseWithdraw("30", BAL, 6)).toEqual({ ok: true, amount: BAL });
    expect(parseWithdraw(" 0.000001 ", BAL, 6)).toEqual({ ok: true, amount: 1n });
  });

  it("rejects zero, more than the vault holds, and more than 6 decimals", () => {
    expect(parseWithdraw("0", BAL, 6)).toEqual({ ok: false, error: "Enter an amount above zero." });
    expect(parseWithdraw("0.000000", BAL, 6)).toEqual({ ok: false, error: "Enter an amount above zero." });
    expect(parseWithdraw("30.000001", BAL, 6)).toEqual({ ok: false, error: "That's more than the vault holds." });
    expect(parseWithdraw("1.1234567", BAL, 6)).toEqual({ ok: false, error: "Enter an amount in USDG, up to 6 decimal places." });
    expect(parseWithdraw("-1", BAL, 6).ok).toBe(false);
    expect(parseWithdraw("abc", BAL, 6).ok).toBe(false);
  });

  it("says nothing until something is typed", () => {
    expect(parseWithdraw("", BAL, 6)).toEqual({ ok: false, error: null });
  });

  it("an empty vault allows nothing", () => {
    expect(parseWithdraw("1", 0n, 6)).toEqual({ ok: false, error: "That's more than the vault holds." });
  });
});
