/**
 * Typed API client for every extension surface. Calls go through the background service worker.
 */
import type { BasketJob, BasketLegResult, BasketPreflight, Catalog, ChartFactsView, Health, Portfolio, Price, Quote, Resolve, ResolveNames, Side, Trade, Vault, WhyMoved } from "./api-types";
import type { ChartData, ChartRange } from "@glance/core/chart";
import type { ShowAction } from "@glance/core/showme";

import type { PageFigure } from "./pageRead";

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

export interface ShowMeRequest {
  question: string;
  surface: "page" | "console";
  page?: { title: string; host: string; selection?: string; text: string; companies: string[]; figures?: PageFigure[] };
  /** A Glance chart open in the panel right now (Show me can draw on it). */
  openChart?: { symbol: string; range: ChartRange } | null;
  screenshot?: string;
  lastGuard?: { code: string; message: string } | null;
  vault?: string;
  noScreenshot?: { glanceKey: string };
  pageChart?: { symbol: string; range: ChartRange; site: string; drawOn: "page" | "lens"; method?: "canvas" | "dom" | "vision" | null; reason?: string; forced?: boolean; candles?: { fine?: boolean; prepost?: boolean } };
}

export interface ShowMeReply {
  reply: string;
  spoken: string;
  actions: ShowAction[];
  source: "claude" | "budget" | "guarded" | "unavailable";
  /** The chart to open, on the range that fits the question, when the reply draws on it. */
  chart?: { symbol: string; range: ChartRange };
}

const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = {
  health: () => call<Health>("GET", "/health"),
  voiceStatus: () =>
    call<{
      transcription: string;
      speech: string;
      intent: string;
      /** Which provider listens (and its fallback): "assemblyai", "universal-3-5-pro". */
      stt?: { provider: string; model: string; fallback: string | null } | null;
      available: { transcription: boolean; speech: boolean; stream: boolean };
      warnings: string[];
    }>(
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
  /** Show me, teach and guide: only when the user asks. The page text is sent once and never kept. */
  showme: (body: ShowMeRequest) => call<ShowMeReply>("POST", "/showme", body),
  chart: (symbol: string, range: ChartRange, vault?: string) => call<ChartData>("GET", `/chart/${encodeURIComponent(symbol)}?${q({ range, vault })}`),
  /** The market's own candles for a symbol and range (Yahoo Finance), even for a catalog stock: to fit a page's chart. */
  marketCandles: (symbol: string, range: ChartRange, opts: { fine?: boolean; prepost?: boolean } = {}) =>
    call<ChartData>("GET", `/chart/${encodeURIComponent(symbol)}?${q({ range, market: "1", fine: opts.fine ? "1" : undefined, prepost: opts.prepost ? "1" : undefined })}`),
  /** The chart lens: a page chart's axis labels, read from a crop of a screenshot (only the labels, never a price). */
  calibrateChart: (img: { base64: string; width: number; height: number }) =>
    call<{ labels: unknown; model: string }>("POST", "/chart/calibrate", { image: img.base64, width: img.width, height: img.height }),
  /** The chart's computed breakdown, or a comparison ("TSLA,AMD"): numbers from code, never from a model. */
  /** `market`: from the market's own candles (a page's chart), at a `fine` step or with the `prepost` market. */
  chartFacts: (symbols: readonly string[], range: ChartRange, vault?: string, candles?: { market?: boolean; fine?: boolean; prepost?: boolean }) =>
    call<ChartFactsView>(
      "GET",
      `/chart/${symbols.map(encodeURIComponent).join(",")}/facts?${q({ range, vault, market: candles?.market ? "1" : undefined, fine: candles?.fine ? "1" : undefined, prepost: candles?.prepost ? "1" : undefined })}`,
    ),
  /** A buy names USDG; a sell names shares, or `usd` (dollars worth) or `fraction` ("1" all, "0.5" half). */
  quote: (p: { vault: string; symbol: string; side: Side; amount?: string; usd?: string; fraction?: "1" | "0.5"; slippageBps?: number }) =>
    call<Quote>("GET", `/quote?${q(p)}`),
  trade: (p: { vault: string; symbol: string; side: Side; amount: string; slippageBps?: number }) =>
    call<Trade>("POST", "/trade", p),
  /** Every leg of a basket, preflighted together (nothing is sent). */
  quoteBasket: (p: { vault: string; legs: Array<{ symbol: string; amount: string }> }) => call<BasketPreflight>("POST", "/quote/basket", p),
  /** A basket buy: signed in the background (one GlanceBasketRequest for every leg); the legs are then sent one by one. */
  tradeBasket: (p: { vault: string; legs: Array<{ symbol: string; amount: string }> }) => call<{ jobId: string; legs: BasketLegResult[] }>("POST", "/trade/basket", p),
  basketJob: (jobId: string) => call<BasketJob>("GET", `/trade/basket/${encodeURIComponent(jobId)}`),
  /** Whether the vault's owner has linked this browser (polled while they sign in the console). */
  sessionStatus: (vault: string, session: string) =>
    call<{ linked: true; expiresAt: number; linkedAt: number } | { linked: false; reason: "unknown" | "revoked" | "expired"; expiresAt?: number }>(
      "GET",
      `/session/status?${q({ vault, session })}`,
    ),
};
