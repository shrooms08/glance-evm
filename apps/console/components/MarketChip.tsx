/**
 * The market state the vault applies to a stock's price: open, closed, or too old to trade on. A token the vault never
 * added says so instead (its price isn't too old: the vault just doesn't trade it until it's added on the Limits page).
 */
export function MarketChip({ state, allowed }: { state: string | null; allowed?: boolean }) {
  if (allowed === false) return <span className="chip">Not in this vault</span>;
  if (state === "OPEN") return <span className="chip chip-accent">Open</span>;
  if (state === "CLOSED") return <span className="chip chip-guard">Closed</span>;
  if (state === "STALE") return <span className="chip chip-fail">Price too old</span>;
  return <span className="chip">Unknown</span>;
}
