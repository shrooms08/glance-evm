/**
 * Typed API client for every extension surface. Calls go through the background service worker.
 */
import { browser } from "wxt/browser";

import type { Catalog, Health, Price, Quote, Resolve, Side, Trade, Vault } from "./api-types";
import type { ApiRequest, ApiResponse } from "./messages";

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResponse<T>> {
  const request: ApiRequest = { kind: "api", method, path, body };
  try {
    const reply = (await browser.runtime.sendMessage(request)) as ApiResponse<T> | undefined;
    return reply ?? { ok: false, status: 0, offline: true, code: "NO_BACKGROUND", message: "Glance's background worker didn't answer." };
  } catch {
    // The extension was reloaded or updated under an open page: its old content script is orphaned.
    return { ok: false, status: 0, offline: true, code: "EXTENSION_RELOADED", message: "Glance was updated. Reload this page to reconnect." };
  }
}

const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = {
  health: () => call<Health>("GET", "/health"),
  catalog: () => call<Catalog>("GET", "/catalog"),
  resolve: (text: string) => call<Resolve>("POST", "/resolve", { text }),
  price: (symbol: string, vault?: string) => call<Price>("GET", `/price/${encodeURIComponent(symbol)}${vault ? `?${q({ vault })}` : ""}`),
  vault: (address: string) => call<Vault>("GET", `/vault/${address}`),
  quote: (p: { vault: string; symbol: string; side: Side; amount: string; slippageBps?: number }) =>
    call<Quote>("GET", `/quote?${q(p)}`),
  trade: (p: { vault: string; symbol: string; side: Side; amount: string; slippageBps?: number }) =>
    call<Trade>("POST", "/trade", p),
};
