/**
 * Typed API client for every extension surface. Calls go through the background service worker.
 */
import type { Catalog, Health, Price, Quote, Resolve, Side, Trade, Vault } from "./api-types";
import { send } from "./lifecycle";
import type { ApiRequest, ApiResponse } from "./messages";

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResponse<T>> {
  const request: ApiRequest = { kind: "api", method, path, body };
  try {
    // send() never settles once Glance has been reloaded under this page: the page UI shuts down instead.
    const reply = await send<ApiResponse<T> | undefined>(request);
    return reply ?? { ok: false, status: 0, offline: true, code: "NO_BACKGROUND", message: "Glance's background worker didn't answer." };
  } catch {
    return { ok: false, status: 0, offline: true, code: "NO_BACKGROUND", message: "Glance's background worker didn't answer." };
  }
}

const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = {
  health: () => call<Health>("GET", "/health"),
  voiceStatus: () =>
    call<{ transcription: string; speech: string; intent: string; available: { transcription: boolean; speech: boolean; stream: boolean }; warnings: string[] }>(
      "GET",
      "/voice/status",
    ),
  catalog: () => call<Catalog>("GET", "/catalog"),
  resolve: (text: string) => call<Resolve>("POST", "/resolve", { text }),
  price: (symbol: string, vault?: string) => call<Price>("GET", `/price/${encodeURIComponent(symbol)}${vault ? `?${q({ vault })}` : ""}`),
  vault: (address: string) => call<Vault>("GET", `/vault/${address}`),
  quote: (p: { vault: string; symbol: string; side: Side; amount: string; slippageBps?: number }) =>
    call<Quote>("GET", `/quote?${q(p)}`),
  trade: (p: { vault: string; symbol: string; side: Side; amount: string; slippageBps?: number }) =>
    call<Trade>("POST", "/trade", p),
};
