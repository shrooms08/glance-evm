/** The market state the vault applies to a stock's price: open, closed, or too old to trade on. */
export function MarketChip({ state }: { state: string | null }) {
  if (state === "OPEN") return <span className="chip chip-accent">Open</span>;
  if (state === "CLOSED") return <span className="chip chip-guard">Closed</span>;
  if (state === "STALE") return <span className="chip chip-fail">Price too old</span>;
  return <span className="chip">Unknown</span>;
}
