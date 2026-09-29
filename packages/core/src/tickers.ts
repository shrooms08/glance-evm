/**
 * Robinhood Chain's Stock Tokens and the US listings they track, for looking up company news. Each Stock Token's symbol
 * happens to match its US ticker today; the map is explicit so a token that doesn't can't be looked up by mistake.
 */
export const US_TICKERS: Readonly<Record<string, string>> = {
  TSLA: "TSLA",
  AMZN: "AMZN",
  PLTR: "PLTR",
  NFLX: "NFLX",
  AMD: "AMD",
  SPY: "SPY",
  QQQ: "QQQ",
};

/** The US ticker for a Stock Token symbol, or null if it isn't one we know. */
export function usTicker(symbol: string): string | null {
  return US_TICKERS[symbol.toUpperCase()] ?? null;
}

/** "NVIDIA Corporation" -> "NVIDIA", "Tesla, Inc." -> "Tesla": the name as people say it. */
export function shortName(name: string): string {
  return name
    .replace(/\s*\((?:[A-Z.]{1,6})\)\s*$/, "")
    .replace(/,?\s+(?:Corporation|Corp\.?|Incorporated|Inc\.?|Holdings?|Company|Co\.|plc|PLC|Ltd\.?|Limited|Group|N\.V\.|S\.A\.|Class [A-C])\s*$/g, "")
    .replace(/,?\s+(?:Corporation|Corp\.?|Inc\.?)\s*$/, "")
    .trim();
}
