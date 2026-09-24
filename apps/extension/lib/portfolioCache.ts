/**
 * The last portfolio seen for each vault, kept in this browser (chrome.storage.local): the panel shows it the moment it
 * opens, with its age, and refreshes it in the background.
 */
import { storage } from "wxt/utils/storage";

import type { Portfolio } from "./api-types";
import { safely } from "./lifecycle";

type Cache = Record<string, { at: number; data: Portfolio }>;
const cache = storage.defineItem<Cache>("local:portfolioCache", { fallback: {} });

export async function cachedPortfolio(vault: string): Promise<{ at: number; data: Portfolio } | null> {
  return safely(async () => (await cache.getValue())[vault.toLowerCase()] ?? null, Promise.resolve(null));
}

export async function savePortfolio(vault: string, data: Portfolio, at = Date.now()): Promise<void> {
  await safely(async () => cache.setValue({ ...(await cache.getValue()), [vault.toLowerCase()]: { at, data } }), Promise.resolve());
}

/** "Last known 5 minutes ago": how old the shown value is. */
export function cacheAge(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "Last known a moment ago";
  const m = Math.round(s / 60);
  if (m < 60) return `Last known ${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `Last known ${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `Last known ${d} days ago`;
}
