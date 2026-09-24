/**
 * "Show me Tesla's chart" from the page: the chart opens in the side panel. The page leaves the request in
 * chrome.storage.local and asks the background to open the panel; the panel picks the request up when it opens (or at
 * once, if it's already open). Opening the panel needs a user gesture, so from voice it may not open by itself: the
 * page then shows a one-tap "Open the chart" card, and the request is still waiting for the panel.
 */
import { storage } from "wxt/utils/storage";

import { send } from "./lifecycle";

/** A request older than this is stale: the panel opening later shouldn't jump to an old chart. */
export const PENDING_CHART_MS = 60_000;

/** A card waiting for the side panel: a stock's chart, or the portfolio (from Show me's [PORTFOLIO]). */
export type PendingCard = { kind: "chart"; symbol: string } | { kind: "portfolio" };

export const pendingChart = storage.defineItem<{ symbol: string; at: number; kind?: "chart" | "portfolio" } | null>("local:pendingChart", { fallback: null });

/** Leaves the request for the side panel and tries to open it. Resolves true if the panel opened. */
/** Leaves a card for the side panel (a chart or the portfolio) and tries to open it. */
export async function requestCard(card: PendingCard, now = Date.now()): Promise<boolean> {
  // Ask first, before any await: the panel only opens inside the tap's user gesture. The panel watches the request,
  // so it doesn't matter that it's written a moment later.
  const opened = send<boolean>({ kind: "panel:open" }).then(Boolean, () => false);
  await pendingChart.setValue({ symbol: card.kind === "chart" ? card.symbol : "", kind: card.kind, at: now }).catch(() => {});
  return opened;
}

/** The side panel's side: the waiting card, if it's fresh, cleared once taken. */
export async function takePendingCard(now = Date.now()): Promise<PendingCard | null> {
  const p = await pendingChart.getValue().catch(() => null);
  if (!p) return null;
  await pendingChart.setValue(null).catch(() => {});
  if (now - p.at > PENDING_CHART_MS) return null;
  return p.kind === "portfolio" ? { kind: "portfolio" } : { kind: "chart", symbol: p.symbol };
}
