import { describe, expect, it } from "vitest";

import {
  bpsToPercent,
  formatDuration,
  formatPercent,
  formatQuantity,
  formatUsd,
  parseDecimal,
  toDecimalString,
  tokenValueInUsdg,
  usdgToTokens,
} from "../../src/format.js";

describe("parseDecimal", () => {
  it("parses whole and fractional amounts exactly", () => {
    expect(parseDecimal("100", 6)).toBe(100_000_000n);
    expect(parseDecimal("12.5", 6)).toBe(12_500_000n);
    expect(parseDecimal("0.000001", 6)).toBe(1n);
    expect(parseDecimal("0.5", 18)).toBe(500_000_000_000_000_000n);
    expect(parseDecimal(" 7 ", 0)).toBe(7n);
  });

  it("rejects more decimals than the token has, and anything that is not a plain decimal", () => {
    expect(() => parseDecimal("0.0000001", 6)).toThrow(/more than 6 decimal places/);
    for (const bad of ["", "-1", "1e6", "1,000", "0x10", ".5", "5.", "abc"]) {
      expect(() => parseDecimal(bad, 6)).toThrow();
    }
  });

  it("round-trips through toDecimalString", () => {
    for (const v of ["0", "1", "12.5", "0.000001", "123456.789"]) {
      expect(toDecimalString(parseDecimal(v, 6), 6)).toBe(v);
    }
  });
});

describe("formatUsd", () => {
  it("drops cents on whole amounts and groups thousands", () => {
    expect(formatUsd(100_000_000n, 6)).toBe("$100");
    expect(formatUsd(1_250_000_000n, 6)).toBe("$1,250");
    expect(formatUsd(0n, 6)).toBe("$0");
  });

  it("shows cents otherwise, rounding half up", () => {
    expect(formatUsd(12_500_000n, 6)).toBe("$12.50");
    expect(formatUsd(24_925_000n, 6)).toBe("$24.93");
    expect(formatUsd(24_924_999n, 6)).toBe("$24.92");
    expect(formatUsd(1_000_004_990_000n, 6)).toBe("$1,000,004.99");
  });

  it("never shows a non-zero amount as $0", () => {
    expect(formatUsd(4_999n, 6)).toBe("<$0.01");
    expect(formatUsd(5_000n, 6)).toBe("$0.01");
  });

  it("works for 18-decimal dollars too", () => {
    expect(formatUsd(100n * 10n ** 18n, 18)).toBe("$100");
    expect(formatUsd(125n * 10n ** 17n, 18)).toBe("$12.50");
  });
});

describe("formatQuantity", () => {
  it("shows up to 4 decimals, rounding down", () => {
    expect(formatQuantity(65_542_000_000_000_000n, 18, "TSLA")).toBe("0.0655 TSLA");
    expect(formatQuantity(1_999_990_000_000_000_000n, 18, "TSLA")).toBe("1.9999 TSLA");
    expect(formatQuantity(5n * 10n ** 18n, 18, "AMD")).toBe("5 AMD");
    expect(formatQuantity(0n, 18, "AMD")).toBe("0 AMD");
  });

  it("adds places for tiny holdings rather than showing 0", () => {
    expect(formatQuantity(123_000_000_000n, 18, "TSLA")).toBe("0.0000001 TSLA");
    expect(formatQuantity(1n, 18, "TSLA")).toBe("<0.00000001 TSLA");
  });
});

describe("formatDuration", () => {
  it("uses plain words", () => {
    expect(formatDuration(30)).toBe("less than a minute");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(45 * 60)).toBe("45 minutes");
    expect(formatDuration(3600)).toBe("1 hour");
    expect(formatDuration(14 * 3600)).toBe("14 hours");
    expect(formatDuration(3 * 86_400)).toBe("3 days");
  });

  it("rounds up when promising availability", () => {
    expect(formatDuration(2 * 3600 + 1, "up")).toBe("3 hours");
    expect(formatDuration(2 * 3600 + 1, "nearest")).toBe("2 hours");
    expect(formatDuration(61, "up")).toBe("2 minutes");
  });
});

describe("percentages", () => {
  it("formats a part of a whole to one decimal", () => {
    expect(formatPercent(8n, 1000n)).toBe("0.8%");
    expect(formatPercent(1n, 4n)).toBe("25%");
    expect(formatPercent(0n, 0n)).toBe("0%");
  });

  it("formats basis points", () => {
    expect(bpsToPercent(2500)).toBe("25%");
    expect(bpsToPercent(30)).toBe("0.3%");
    expect(bpsToPercent(100)).toBe("1%");
  });
});

describe("oracle maths mirrors MarketStatusLib", () => {
  // Same examples as the Solidity NatSpec: 100 USDG (6dp) at $200.00000000 (8dp) is 0.5 of an 18dp token.
  it("converts USDG to tokens", () => {
    expect(usdgToTokens(100_000_000n, 6, 20_000_000_000n, 8, 18)).toBe(5n * 10n ** 17n);
  });

  it("converts tokens to USDG", () => {
    expect(tokenValueInUsdg(5n * 10n ** 17n, 18, 20_000_000_000n, 8, 6)).toBe(100_000_000n);
  });

  it("rounds down and never creates value on a round trip", () => {
    const price = 38_025_740_000n; // TSLA $380.2574
    for (const usdg of [1n, 999_999n, 10_000_000n, 123_456_789n]) {
      const tokens = usdgToTokens(usdg, 6, price, 8, 18);
      expect(tokenValueInUsdg(tokens, 18, price, 8, 6) <= usdg).toBe(true);
    }
  });
});
