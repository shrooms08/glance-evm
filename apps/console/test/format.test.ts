/** Money and quantities in each token's real decimals, never floating point; ages and times in plain words. */
import { describe, expect, it } from "vitest";

import { formatAgeHours, formatIn, formatQuantity, formatUsd, parseDecimal, shortAddress, toDecimalString } from "../lib/format";

describe("money and quantities", () => {
  it("formats USDG in its own 6 decimals, rounding half up to the cent", () => {
    expect(formatUsd(100_000_000n, 6)).toBe("$100");
    expect(formatUsd(59_970_000n, 6)).toBe("$59.97");
    expect(formatUsd(1_234_567_890n, 6)).toBe("$1,234.57");
    expect(formatUsd(4_999n, 6)).toBe("<$0.01");
    expect(formatUsd(5_000n, 6)).toBe("$0.01");
  });

  it("is exact where floating point isn't", () => {
    // 0.1 + 0.2 in raw units is exactly 0.3.
    expect(formatUsd(parseDecimal("0.1", 6) + parseDecimal("0.2", 6), 6)).toBe("$0.30");
    // A huge 18-decimal amount keeps every digit.
    expect(toDecimalString(123_456_789_012_345_678_901_234_567n, 18)).toBe("123456789.012345678901234567");
  });

  it("shows stock quantities in 18 decimals, rounding down so a holding is never overstated", () => {
    expect(formatQuantity(26_231_999_999_999_999n, 18, "TSLA")).toBe("0.0262 TSLA");
    expect(formatQuantity(12_345n, 18, "AMD")).toBe("<0.00000001 AMD");
    expect(formatQuantity(10_000_000_000n, 18, "AMD")).toBe("0.00000001 AMD");
  });

  it("refuses more decimal places than the token has", () => {
    expect(() => parseDecimal("1.1234567", 6)).toThrow();
    expect(parseDecimal("1.123456", 6)).toBe(1_123_456n);
  });
});

describe("times", () => {
  it("states a price's age in hours", () => {
    expect(formatAgeHours(0)).toBe("0.0 h");
    expect(formatAgeHours(16_560)).toBe("4.6 h");
    expect(formatAgeHours(35_999)).toBe("10 h");
    expect(formatAgeHours(52 * 3600 + 100)).toBe("52 h");
  });

  it("never promises earlier than true", () => {
    expect(formatIn(3_601)).toBe("in 2 hours");
    expect(formatIn(0)).toBe("now");
  });

  it("shortens addresses", () => {
    expect(shortAddress("0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113")).toBe("0xCafa…0113");
  });
});
