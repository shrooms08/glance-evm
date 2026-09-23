/**
 * Short names for the guards, for the activity page's "guards that fired" summary. The full sentence for each refusal
 * is always the API's own (packages/core/src/errors.ts); these only label the counts.
 */
export const GUARD_LABELS: Record<string, string> = {
  PER_TRADE_CAP: "Per-trade cap",
  DAILY_BUY_CAP: "24h buy cap",
  DAILY_SELL_CAP: "24h sell cap",
  ORACLE_STALE: "Price too old",
  ORACLE_BAD_PRICE: "Bad price",
  AGENT_EXPIRED: "Agent expired",
  NOT_AGENT: "Not the agent",
  PAUSED: "Paused",
  TOKEN_NOT_APPROVED: "Stock not approved",
  NO_PRICE_FEED: "No price feed",
  ROUTER_NOT_APPROVED: "Venue not approved",
  SLIPPAGE: "Slippage limit",
  SHORT_FILL: "Short fill",
  INSUFFICIENT_BALANCE: "Not enough funds",
  BUFFER_FULL: "32 trades a day",
  NOT_OWNER: "Owner only",
  ZERO_AMOUNT: "Amount too small",
  SEQUENCER_DOWN: "Sequencer down",
  SEQUENCER_GRACE: "Sequencer grace",
  DESK_INVENTORY: "Desk inventory",
  DESK_PRICE_STALE: "Desk price old",
  DESK_PRICE_MOVED: "Desk price moved",
  DESK_NOT_LISTED: "Not listed",
  TRANSFER_FAILED: "Transfer failed",
  REENTRANCY: "Re-entrancy",
  INVALID_SETTING: "Invalid setting",
  FAUCET_LIMIT: "Faucet limit",
  UNKNOWN: "Other",
};

export const guardLabel = (code: string) => GUARD_LABELS[code] ?? GUARD_LABELS.UNKNOWN!;

/** Guards fired, most frequent first. */
export function guardCounts(codes: string[]): Array<{ code: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => ({ code, label: guardLabel(code), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
