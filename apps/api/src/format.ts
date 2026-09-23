/**
 * Money, quantity and duration formatting, plus exact decimal parsing. Every amount on chain is a bigint in the token's
 * own decimals; nothing here goes through floating point except the final display of a percentage.
 */

/** Parses a non-negative decimal string into raw units. Rejects more fractional digits than the token supports. */
export function parseDecimal(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new RangeError(`"${value}" is not a plain decimal number`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new RangeError(`"${value}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Raw units to a plain decimal string with no trailing zeros, e.g. 12500000n (6 dp) -> "12.5". */
export function toDecimalString(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function groupThousands(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A USDG amount as dollars: whole amounts without cents ("$100", "$1,250"), others to the cent ("$12.50"), rounded
 * half up. Amounts that round to zero but are not zero show as "<$0.01".
 */
export function formatUsd(raw: bigint, decimals: number): string {
  if (raw < 0n) return `-${formatUsd(-raw, decimals)}`;
  const unit = 10n ** BigInt(decimals);
  if (raw % unit === 0n) return `$${groupThousands(raw / unit)}`;
  // Round half up to cents.
  const cents = decimals >= 2 ? (raw * 100n + unit / 2n) / unit : raw * 10n ** BigInt(2 - decimals);
  if (cents === 0n) return "<$0.01";
  return `$${groupThousands(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * A token quantity for display: up to 4 decimal places ("0.2629 TSLA"), more only when needed to show a non-zero
 * amount, and never more than 8. Rounds down so we never overstate a holding.
 */
export function formatQuantity(raw: bigint, decimals: number, symbol?: string): string {
  const suffix = symbol ? ` ${symbol}` : "";
  if (raw === 0n) return `0${suffix}`;
  const full = toDecimalString(raw, decimals);
  const [whole = "0", fraction = ""] = full.split(".");
  let places = Math.min(4, fraction.length);
  while (places < Math.min(8, fraction.length) && /^0*$/.test(fraction.slice(0, places))) places++;
  const shown = fraction.slice(0, places).replace(/0+$/, "");
  if (whole === "0" && shown === "") return `<0.00000001${suffix}`;
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${shown ? `.${shown}` : ""}${suffix}`;
}

export type DurationRounding = "up" | "nearest";

/**
 * A duration in plain words: "less than a minute", "45 minutes", "3 hours", "2 days". Round "up" when promising when
 * something becomes available (never under-promise), "nearest" when describing an age.
 */
export function formatDuration(seconds: number, rounding: DurationRounding = "nearest"): string {
  const s = Math.max(0, seconds);
  const round = rounding === "up" ? Math.ceil : Math.round;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (s < 60) return "less than a minute";
  if (s < 3600) {
    const minutes = Math.max(1, round(s / 60));
    return minutes >= 60 ? "1 hour" : plural(minutes, "minute");
  }
  if (s < 48 * 3600) return plural(Math.max(1, round(s / 3600)), "hour");
  return plural(round(s / 86_400), "day");
}

/** `part` as a percentage of `whole` with one decimal place, e.g. "0.8%". */
export function formatPercent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0%";
  const tenths = (part * 1000n + whole / 2n) / whole;
  const text = `${tenths / 10n}.${tenths % 10n}`.replace(/\.0$/, "");
  return `${text}%`;
}

/** Basis points as a percentage, e.g. 2500 -> "25%". */
export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toString()}%`;
}

/**
 * USDG value of a token amount at an oracle price, mirroring MarketStatusLib.tokenToUsdgAmount (rounds down).
 * value = tokens * price * 10^usdgDecimals / 10^(priceDecimals + tokenDecimals)
 */
export function tokenValueInUsdg(
  tokens: bigint,
  tokenDecimals: number,
  price: bigint,
  priceDecimals: number,
  usdgDecimals: number,
): bigint {
  return (tokens * price * 10n ** BigInt(usdgDecimals)) / 10n ** BigInt(priceDecimals + tokenDecimals);
}

/**
 * Tokens bought by a USDG amount at an oracle price, mirroring MarketStatusLib.usdgToTokenAmount (rounds down).
 * tokens = usdg * 10^(priceDecimals + tokenDecimals) / (price * 10^usdgDecimals)
 */
export function usdgToTokens(
  usdg: bigint,
  usdgDecimals: number,
  price: bigint,
  priceDecimals: number,
  tokenDecimals: number,
): bigint {
  return (usdg * 10n ** BigInt(priceDecimals + tokenDecimals)) / (price * 10n ** BigInt(usdgDecimals));
}
