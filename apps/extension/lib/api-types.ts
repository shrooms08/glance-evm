/**
 * The parts of the Glance API's responses the extension reads (see apps/api/README.md). Amounts are
 * { raw, value, formatted }: raw in the token's smallest unit, value as a decimal string, formatted for display.
 */

export type MarketState = "OPEN" | "CLOSED" | "STALE";
export type Side = "buy" | "sell";

export interface Amount {
  raw: string;
  value: string;
  formatted: string;
}

export interface GuardDetail {
  requested?: string;
  limit?: string;
  over?: string;
  remaining?: string;
  retryAfterSeconds?: number;
  suggestedAmount?: string;
  suggestedAmountFormatted?: string;
  ageSeconds?: number;
  updatedAt?: number;
  expiry?: number;
  [key: string]: string | number | undefined;
}

export interface Guard {
  code: string;
  error: string;
  message: string;
  args: Record<string, string>;
  detail: GuardDetail;
}

export interface ApiErrorBody {
  error: { code: string; message: string; guard?: Guard };
}

export interface FeedStatus {
  symbol: string;
  price: { raw: string; decimals: number; value: string };
  updatedAt: number;
  ageSeconds: number;
  age: string;
  marketState: MarketState;
  source: "mainnet-mirror" | "public-quote" | "unknown";
  lastWrite: { at: number | null; agoSeconds: number | null; txHash: string } | null;
}

export interface Health {
  ok: boolean;
  chainId: number;
  expectedChainId: number;
  blockNumber: string;
  agent: { address: string; keyLoaded: boolean; matchesDemoVault: boolean; ethBalance: string };
  llmFallback: boolean;
  keeper?: { pausedLocally: boolean; lastWriteAt: number | null };
  feeds?: FeedStatus[];
  demoVaults: { testUSDG: string; paxosUSDG: string | null };
}

export interface CatalogStock {
  symbol: string;
  name: string;
  legalName: string;
  aliases: string[];
  token: string;
  tokenDecimals: number;
  tokenReal: boolean;
  feedReal: boolean;
  priceSourceKind: string;
}

export interface Catalog {
  chainId: number;
  stocks: CatalogStock[];
}

export interface ResolvedMatch {
  symbol: string;
  text: string;
  start: number;
  end: number;
  kind: "name" | "ticker" | "cashtag";
  source: "dictionary" | "llm";
}

export interface Resolve {
  source: "dictionary" | "llm" | "none";
  matches: ResolvedMatch[];
}

export interface Price {
  symbol: string;
  name: string;
  price: { raw: string; decimals: number; value: string };
  updatedAt: number;
  ageSeconds: number;
  age: string;
  marketState: MarketState;
  priceSourceKind: string;
}

export interface Window24h {
  used: Amount;
  limit: Amount;
  remaining: Amount;
  nextReleaseInSeconds: number | null;
  clearsInSeconds: number | null;
}

export interface Position {
  symbol: string;
  quantity: Amount;
  value: Amount;
  marketState: MarketState;
}

export interface Vault {
  address: string;
  agentActive: boolean;
  agentExpiresInSeconds: number;
  paused: boolean;
  limits: { perTrade: Amount; dailyBuy: Amount; dailySell: Amount; weekendCap: string; weekendCapBps: number };
  effectiveCaps: Record<"OPEN" | "CLOSED", { perTrade: Amount; dailyBuy: Amount; dailySell: Amount }>;
  buyWindow: Window24h;
  sellWindow: Window24h;
  balances: { usdg: Amount; invested: Amount; total: Amount };
  positions: Position[];
}

export interface Quote {
  vault: string;
  symbol: string;
  side: Side;
  amountIn: Amount;
  deskQuote: Amount | null;
  oracleImplied: Amount;
  spreadBps: number;
  spread: string;
  minOut: Amount;
  price: { raw: string; decimals: number; value: string };
  marketState: MarketState;
  priceAgeSeconds: number;
  preflight: { ok: true; simulatedAs: string } | { ok: false; guard: Guard; simulatedAs: string };
}

export interface Trade {
  txHash: string;
  explorerUrl: string;
  symbol: string;
  side: Side;
  filled: { usdgIn?: Amount; tokensOut?: Amount; tokensIn?: Amount; usdgOut?: Amount } | null;
  balancesAfter: Record<string, Amount>;
}
