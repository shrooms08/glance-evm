/**
 * Off-chain mirror of the vault's rolling 24h windows (RollingSpendLib). The vault does not expose its ring buffer, so
 * the API rebuilds it from Bought (usdgIn) and Sold (notional) events, which record exactly what each window counted.
 * An entry counts while `timestamp + WINDOW_SECONDS > now`, the same rule as the contract.
 */

export const WINDOW_SECONDS = 86_400;

export interface WindowEntry {
  timestamp: number;
  amount: bigint;
}

export function liveEntries(entries: readonly WindowEntry[], now: number): WindowEntry[] {
  return entries.filter((e) => e.timestamp + WINDOW_SECONDS > now).sort((a, b) => a.timestamp - b.timestamp);
}

export function usedInWindow(entries: readonly WindowEntry[], now: number): bigint {
  return liveEntries(entries, now).reduce((sum, e) => sum + e.amount, 0n);
}

/**
 * Seconds until `request` more fits under `cap`: 0 if it fits now, null if it can never fit (request > cap).
 * Walks the live entries oldest first, releasing each at its expiry, until enough has freed up.
 */
export function secondsUntilFits(
  entries: readonly WindowEntry[],
  now: number,
  cap: bigint,
  request: bigint,
): number | null {
  if (request > cap) return null;
  const live = liveEntries(entries, now);
  let used = live.reduce((sum, e) => sum + e.amount, 0n);
  if (used + request <= cap) return 0;
  for (const entry of live) {
    used -= entry.amount;
    if (used + request <= cap) return entry.timestamp + WINDOW_SECONDS - now;
  }
  return null; // unreachable: once every entry expires, used is 0 and request <= cap fits
}

export interface WindowSummary {
  used: bigint;
  /** Unix time the oldest live entry expires, or null if the window is empty. */
  nextReleaseAt: number | null;
  nextReleaseAmount: bigint;
  /** Unix time the whole window is empty again, or null if it already is. */
  clearsAt: number | null;
  entries: number;
}

export function summarizeWindow(entries: readonly WindowEntry[], now: number): WindowSummary {
  const live = liveEntries(entries, now);
  const first = live[0];
  const last = live[live.length - 1];
  return {
    used: live.reduce((sum, e) => sum + e.amount, 0n),
    nextReleaseAt: first ? first.timestamp + WINDOW_SECONDS : null,
    nextReleaseAmount: first ? live.filter((e) => e.timestamp === first.timestamp).reduce((s, e) => s + e.amount, 0n) : 0n,
    clearsAt: last ? last.timestamp + WINDOW_SECONDS : null,
    entries: new Set(live.map((e) => e.timestamp)).size,
  };
}
