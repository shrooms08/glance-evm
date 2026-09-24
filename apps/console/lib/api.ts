/**
 * The Glance API, read-only from the console: vault state, activity (with refusals), prices and health. The console
 * never calls /trade and never sees the agent key; every change goes through the owner's own wallet.
 *
 * Failures are told apart, never lumped into "something went wrong":
 *   unreachable  the API itself didn't answer (not started, wrong URL, CORS)
 *   rpc          the API answered RPC_UNAVAILABLE: the testnet isn't responding (reads retry and recover on their own)
 *   not-a-vault  the chain answered: that address holds no Glance vault
 *   other        any other error the API reported, in its own words
 */
import type { Address } from "viem";

import type { ChartData, ChartRange } from "@glance/core/chart";

import { env } from "./env";

export interface Money {
  raw: string;
  value: string;
  formatted: string;
}

export type MarketState = "OPEN" | "CLOSED" | "STALE";

export interface Caps {
  perTrade: Money;
  dailyBuy: Money;
  dailySell: Money;
}

export interface WindowView {
  used: Money;
  limit: Money;
  remaining: Money;
  nextReleaseAt: number | null;
  nextReleaseInSeconds: number | null;
  nextReleaseAmount: Money;
  clearsAt: number | null;
  clearsInSeconds: number | null;
  tradesInWindow: number;
  reconstructed: boolean;
}

export interface Position {
  symbol: string;
  name: string;
  token: Address;
  quantity: Money;
  value: Money;
  marketState: MarketState;
  effectiveCaps: Caps | null;
}

export interface VaultView {
  address: Address;
  owner: Address;
  agent: Address | null;
  agentExpiry: number;
  agentActive: boolean;
  agentExpiresInSeconds: number;
  paused: boolean;
  usdg: { address: Address; decimals: number; real: boolean | null };
  limits: {
    perTrade: Money;
    dailyBuy: Money;
    dailySell: Money;
    maxSlippageBps: number;
    maxSlippage: string;
    weekendCapBps: number;
    weekendCap: string;
  };
  effectiveCaps: Partial<Record<"OPEN" | "CLOSED", Caps>>;
  buyWindow: WindowView;
  sellWindow: WindowView;
  balances: { usdg: Money; invested: Money; total: Money };
  positions: Position[];
  asOf: number;
}

export interface Refusal {
  code: string;
  error: string;
  message: string;
  /** preflight: simulated as the agent against the chain and never sent. onchain: sent, and the vault reverted it. */
  source: "preflight" | "onchain";
  via?: "quote" | "trade";
  sent: boolean;
  from?: Address;
  byAgent?: boolean;
}

export interface ActivityItem {
  type: string;
  kind: "trade" | "owner" | "refusal";
  summary: string;
  symbol?: string;
  txHash: string | null;
  blockNumber?: string;
  logIndex: number | null;
  timestamp: number;
  explorerUrl: string | null;
  data: Record<string, unknown>;
  refusal?: Refusal;
}

export interface ActivityView {
  vault: Address;
  count: number;
  items: ActivityItem[];
  sources?: {
    events: "ok";
    preflightRefusals: { persisted: boolean };
    onChainRefusals: "ok" | "unavailable";
  };
}

export interface FeedStatus {
  symbol: string;
  price: { raw: string; decimals: number; value: string } | null;
  updatedAt: number | null;
  ageSeconds?: number | null;
  age?: string | null;
  marketState: MarketState | null;
  source: "mainnet-mirror" | "public-quote" | string;
  sourceDetail?: string;
  mainnetFeed?: string | null;
  lastWrite?: { at: number; agoSeconds: number; txHash: string } | null;
  error?: string;
}

export interface HealthView {
  ok: boolean;
  chainId: number;
  blockNumber: string;
  /** Development only (or with the admin token): a production API shows the public view without it. */
  agent?: { address: Address | null; keyLoaded: boolean };
  keeper: { pausedLocally?: boolean; lastWriteAt: number | null };
  feeds: FeedStatus[];
}

export interface CatalogStock {
  symbol: string;
  name: string;
  token: Address;
  tokenDecimals: number;
  tokenReal: boolean;
  feed: Address;
  feedReal: boolean;
  priceSourceKind: string;
  priceSource: string;
  mainnetFeed?: string | null;
}

export interface CatalogView {
  chainId: number;
  stocks: CatalogStock[];
}

export type ApiProblemKind = "unreachable" | "rpc" | "not-a-vault" | "other";

export class ApiProblem extends Error {
  constructor(
    readonly kind: ApiProblemKind,
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const unreachableMessage = (url = env.apiUrl) =>
  `The Glance API at ${url} isn't answering, so there's nothing to show yet. Nothing about your vault has changed.`;

export async function apiGet<T>(path: string, fetchFn: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${env.apiUrl}${path}`, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
  } catch {
    throw new ApiProblem("unreachable", unreachableMessage());
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiProblem("unreachable", unreachableMessage());
  }
  if (res.ok) return body as T;
  const err = (body as { error?: { code?: string; message?: string } }).error ?? {};
  const code = err.code ?? "UNKNOWN";
  const message = err.message ?? `The Glance API answered ${res.status}.`;
  if (code === "RPC_UNAVAILABLE") throw new ApiProblem("rpc", message, code, res.status);
  if (code === "NOT_A_VAULT") throw new ApiProblem("not-a-vault", message, code, res.status);
  throw new ApiProblem("other", message, code, res.status);
}

/** GET /portfolio/:vault: average cost from the vault's own trades, valued at its oracle prices. */
export interface PortfolioPosition {
  symbol: string;
  name: string;
  qty: Money;
  avgCost: Money;
  costBasis: Money;
  price: { raw: string; decimals: number; value: string; formatted: string };
  priceAge: { seconds: number; text: string };
  marketState: MarketState;
  value: Money;
  unrealizedPnl: Money;
  unrealizedPnlPct: string | null;
  realizedPnl: Money;
  transferredIn: Money | null;
}

export interface PortfolioView {
  usdg: Money;
  positions: PortfolioPosition[];
  totals: { value: Money; stocksValue: Money; costBasis: Money; unrealizedPnl: Money; unrealizedPnlPct: string | null; realizedPnl: Money };
  sentence: string;
}

export const api = {
  vault: (address: string) => apiGet<VaultView>(`/vault/${address}`),
  portfolio: (address: string) => apiGet<PortfolioView>(`/portfolio/${address}`),
  activity: (address: string, limit = 200) => apiGet<ActivityView>(`/vault/${address}/activity?limit=${limit}`),
  health: () => apiGet<HealthView>("/health"),
  catalog: () => apiGet<CatalogView>("/catalog"),
  /** Public: price history for the chart; with a vault, its trades as markers too. */
  chart: (symbol: string, range: ChartRange, vault?: string | null) =>
    apiGet<ChartData>(`/chart/${encodeURIComponent(symbol)}?range=${range}${vault ? `&vault=${vault}` : ""}`),
};

/** Backoff for reads while the testnet isn't responding: they recover on their own. Other problems don't retry. */
export const RPC_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return error instanceof ApiProblem && error.kind === "rpc" && failureCount < RPC_RETRY_DELAYS_MS.length;
}
export function retryDelay(attempt: number): number {
  return RPC_RETRY_DELAYS_MS[Math.min(attempt, RPC_RETRY_DELAYS_MS.length - 1)]!;
}
