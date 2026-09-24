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

export const pendingChart = storage.defineItem<{ symbol: string; at: number } | null>("local:pendingChart", { fallback: null });

/** Leaves the request for the side panel and tries to open it. Resolves true if the panel opened. */
export async function requestChart(symbol: string, now = Date.now()): Promise<boolean> {
  // Ask first, before any await: the panel only opens inside the tap's user gesture. The panel watches the request,
  // so it doesn't matter that it's written a moment later.
  const opened = send<boolean>({ kind: "panel:open" }).then(Boolean, () => false);
  await pendingChart.setValue({ symbol, at: now }).catch(() => {});
  return opened;
}

/** The side panel's side: the waiting request, if it's fresh, cleared once taken. */
export async function takePendingChart(now = Date.now()): Promise<string | null> {
  const p = await pendingChart.getValue().catch(() => null);
  if (!p) return null;
  await pendingChart.setValue(null).catch(() => {});
  return now - p.at <= PENDING_CHART_MS ? p.symbol : null;
}
