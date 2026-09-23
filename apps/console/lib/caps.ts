/**
 * The caps as the vault enforces them (GlanceVault.effectiveCaps and _checkCaps), in bigint maths:
 *   market open    the caps as set
 *   market closed  each cap x weekendCapBps / 10,000, rounded down (Math.mulDiv)
 * The rolling 24h buy and sell totals are the same in both states; only the cap they're held against changes.
 */
import { formatDuration, formatUsd } from "@glance/core/format";

import type { MarketState, VaultView, WindowView } from "./api";

export const BPS = 10_000n;

export type CapState = "OPEN" | "CLOSED";

export function effectiveCap(cap: bigint, state: CapState, weekendCapBps: number): bigint {
  return state === "OPEN" ? cap : (cap * BigInt(weekendCapBps)) / BPS;
}

export interface CapUse {
  cap: bigint;
  used: bigint;
  remaining: bigint;
  /** used / cap in basis points, clamped to 0..10,000 (for the meter only). */
  usedBps: number;
  /** Used beyond this cap: possible when the market closes after trading at the open caps. */
  over: bigint;
}

export function capUse(cap: bigint, used: bigint): CapUse {
  const remaining = cap > used ? cap - used : 0n;
  const usedBps = cap === 0n ? (used > 0n ? 10_000 : 0) : Number(((used > cap ? cap : used) * BPS) / cap);
  return { cap, used, remaining, usedBps, over: used > cap ? used - cap : 0n };
}

export interface CapRow {
  kind: "perTrade" | "dailyBuy" | "dailySell";
  label: string;
  /** For the per-trade cap there's no running total: each trade is checked on its own. */
  rolling: boolean;
  open: CapUse;
  closed: CapUse;
  window: WindowView | null;
}

export function capRows(v: Pick<VaultView, "limits" | "buyWindow" | "sellWindow">): CapRow[] {
  const bps = v.limits.weekendCapBps;
  const row = (kind: CapRow["kind"], label: string, cap: bigint, used: bigint, window: WindowView | null): CapRow => ({
    kind,
    label,
    rolling: window !== null,
    open: capUse(effectiveCap(cap, "OPEN", bps), used),
    closed: capUse(effectiveCap(cap, "CLOSED", bps), used),
    window,
  });
  return [
    row("perTrade", "Per trade", BigInt(v.limits.perTrade.raw), 0n, null),
    row("dailyBuy", "Buys, rolling 24h", BigInt(v.limits.dailyBuy.raw), BigInt(v.buyWindow.used.raw), v.buyWindow),
    row("dailySell", "Sells, rolling 24h", BigInt(v.limits.dailySell.raw), BigInt(v.sellWindow.used.raw), v.sellWindow),
  ];
}

/** When the rolling window gives room back, in words: "$25 frees up in 23 hours. Fully clear in 23 hours." */
export function freesUp(w: WindowView | null, usdgDecimals: number): string {
  if (!w || w.tradesInWindow === 0 || w.nextReleaseInSeconds === null) return "Nothing used in the last 24 hours.";
  const amount = formatUsd(BigInt(w.nextReleaseAmount.raw), usdgDecimals);
  const next = `${amount} frees up in ${formatDuration(w.nextReleaseInSeconds, "up")}.`;
  if (w.clearsInSeconds === null || w.clearsAt === w.nextReleaseAt) return next;
  return `${next} Fully clear in ${formatDuration(w.clearsInSeconds, "up")}.`;
}

export interface MarketNow {
  /** The caps in force for every stock, or "MIXED" when stocks differ (each trade uses its own stock's state). */
  state: CapState | "MIXED" | "STALE";
  open: string[];
  closed: string[];
  stale: string[];
}

/**
 * Which caps are in force right now. The vault decides per stock from that stock's price age (open, closed or stale),
 * so this reads the state the vault applies to each position.
 */
export function marketNow(states: Array<{ symbol: string; marketState: MarketState }>): MarketNow {
  const by = (s: MarketState) => states.filter((p) => p.marketState === s).map((p) => p.symbol);
  const open = by("OPEN");
  const closed = by("CLOSED");
  const stale = by("STALE");
  const state = open.length && !closed.length ? "OPEN" : closed.length && !open.length ? "CLOSED" : open.length ? "MIXED" : "STALE";
  return { state, open, closed, stale };
}
