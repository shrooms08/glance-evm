/**
 * Typed API client for every extension surface. Calls go through the background service worker.
 */
import type { Catalog, Health, Portfolio, Price, Quote, Resolve, ResolveNames, Side, Trade, Vault, WhyMoved } from "./api-types";
import type { ChartData, ChartRange } from "@glance/core/chart";

import { send } from "./lifecycle";
import { setChainStatus } from "./chainStatus";
import type { ApiRequest, ApiResponse } from "./messages";

/** Backoff between retries of a read when the testnet RPC isn't responding (then the caller gets the message). */
export const RPC_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** For tests only. */
export function setSleepForTests(fn: (ms: number) => Promise<void>) {
  sleep = fn;
}

/** Reads are safe to repeat. A trade is never retried on our own: it might already have gone through. */
const retryable = (method: "GET" | "POST", path: string) => method === "GET" || path === "/resolve";

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResponse<T>> {
  let res = await once<T>(method, path, body);
  if (retryable(method, path)) {
    for (const delay of RPC_RETRY_DELAYS_MS) {
      if (res.ok || res.code !== "RPC_UNAVAILABLE") break;
      await sleep(delay);
      res = await once<T>(method, path, body);
    }
  }
  // Any answer that reached the chain means it's answering again; RPC_UNAVAILABLE means it isn't.
  if (res.ok || (!res.offline && res.code !== "RPC_UNAVAILABLE")) setChainStatus("ok");
  else if (res.code === "RPC_UNAVAILABLE") setChainStatus("trouble");
  return res;
}

async function once<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResponse<T>> {
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
  /** The dictionary only: safe on every page load. */
  resolve: (text: string) => call<Resolve>("POST", "/resolve", { text }),
  /** Claude, once per glance: the page's unresolved candidate names. */
  resolveNames: (names: string[]) => call<ResolveNames>("POST", "/resolve/names", { names }),
  price: (symbol: string, vault?: string) => call<Price>("GET", `/price/${encodeURIComponent(symbol)}${vault ? `?${q({ vault })}` : ""}`),
  vault: (address: string) => call<Vault>("GET", `/vault/${address}`),
  portfolio: (address: string) => call<Portfolio>("GET", `/portfolio/${address}`),
  why: (symbol: string) => call<WhyMoved>("GET", `/why/${encodeURIComponent(symbol)}`),
  chart: (symbol: string, range: ChartRange, vault?: string) => call<ChartData>("GET", `/chart/${encodeURIComponent(symbol)}?${q({ range, vault })}`),
  quote: (p: { vault: string; symbol: string; side: Side; amount: string; slippageBps?: number }) =>
    call<Quote>("GET", `/quote?${q(p)}`),
  trade: (p: { vault: string; symbol: string; side: Side; amount: string; slippageBps?: number }) =>
    call<Trade>("POST", "/trade", p),
};
