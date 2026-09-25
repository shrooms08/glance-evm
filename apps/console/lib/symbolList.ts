/** "TSLA, AMZN and SPY": a list of tickers for a sentence (one: itself; none: ""). */
export function symbolList(symbols: readonly string[]): string {
  if (symbols.length <= 1) return symbols[0] ?? "";
  return `${symbols.slice(0, -1).join(", ")} and ${symbols[symbols.length - 1]}`;
}

/** The stocks and ETFs a vault allows, from its own positions (the vault's tokenConfig, read by the API). */
export function approvedSymbols(positions: ReadonlyArray<{ symbol: string; allowed?: boolean }>): string[] {
  return positions.filter((p) => p.allowed !== false).map((p) => p.symbol);
}

/** The agent card's line: what the agent may trade, from the vault's own approved list (never a hard-coded count). */
export function approvedLine(v: { positions: ReadonlyArray<{ symbol: string; allowed?: boolean }> }): string {
  const approved = approvedSymbols(v.positions);
  return approved.length
    ? `Buy and sell the approved stocks and ETFs (${symbolList(approved)}), only through the approved desk.`
    : "Buy and sell the approved stocks and ETFs, only through the approved desk. None is approved yet.";
}
