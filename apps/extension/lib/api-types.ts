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
  /** Development only (or with the admin token): a production API shows the public view without these. */
  agent?: { address: string; keyLoaded: boolean; matchesDemoVault: boolean; ethBalance: string };
  llmFallback?: boolean;
  versions?: { api: string; commit: string | null };
  keeper?: { pausedLocally?: boolean; lastWriteAt: number | null };
  feeds?: FeedStatus[];
  demoVaults?: {
    testUSDG: string;
    paxosUSDG: string | null;
    /** Present on APIs from after the move to real Paxos USDG. */
    primary?: string;
    defaultVault?: string;
    faucets?: { paxosUSDG: string | null; testUSDG: string | null };
  };
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
  source: "dictionary" | "none";
  matches: ResolvedMatch[];
}

/** POST /resolve/names: the candidate names that are listed companies (from Claude or its 7-day cache). */
export interface ResolveNames {
  asked: number;
  count: number;
  names: Array<{ name: string; symbol: string; source: "cache" | "llm" }>;
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
  /** The vault allows buying it (absent from older APIs: treat as allowed). */
  allowed?: boolean;
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

/** GET /portfolio/:vault. Money is { raw, value, formatted }; signed amounts are formatted "+$1.40" / "-$0.20". */
export interface PortfolioPosition {
  symbol: string;
  name: string;
  token: string;
  qty: Amount;
  avgCost: Amount;
  costBasis: Amount;
  price: { raw: string; decimals: number; value: string; formatted: string };
  priceAge: { seconds: number; text: string };
  marketState: MarketState;
  value: Amount;
  unrealizedPnl: Amount;
  unrealizedPnlPct: string | null;
  unrealizedPnlBps: number;
  realizedPnl: Amount;
  /** Shares that arrived outside a trade, counted at zero cost. */
  transferredIn: Amount | null;
  lastBuy: { txHash: string; timestamp: number } | null;
}

export interface Portfolio {
  vault: string;
  usdg: Amount & { address: string };
  positions: PortfolioPosition[];
  totals: { value: Amount; stocksValue: Amount; costBasis: Amount; unrealizedPnl: Amount; unrealizedPnlPct: string | null; realizedPnl: Amount };
  /** One plain sentence, e.g. "You hold $62 across 2 stocks, up $1.40 overall." */
  sentence: string;
  asOf: number;
}

/** GET /why/:symbol. The summary cites sources as [1], [2]; null when only the headlines are shown. */
export interface WhyMoved {
  symbol: string;
  move: { pct: string | null; from: string; to: string; window: string; source: "glance-feed" | "finnhub-quote"; label: string; note?: string } | null;
  summary: string | null;
  summaryNote?: "llm-unavailable" | "guarded" | "no-news" | "news-unavailable";
  sources: Array<{ title: string; url: string; site: string; publishedAt: string }>;
  generatedAt: string;
  cached: boolean;
}

/** GET /chart/:symbols/facts: the computed breakdown of a chart, or a comparison of up to three. */
export interface ChartFactsView {
  range: import("@glance/core/chart").ChartRange;
  facts: import("@glance/core/chart-facts").ChartFacts[];
  comparison: {
    label: "rebased to 100";
    lines: Array<{ symbol: string; name: string; points: Array<{ t: number; value: number }> }>;
    rows: import("@glance/core/chart-facts").CompareRow[];
    sentence: string;
  } | null;
}

/** POST /quote/basket: every leg preflighted, then the legs together against the cap left and the vault's USDG. */
export interface BasketLegCheck {
  symbol: string;
  amount: string;
  price: string | null;
  ok: boolean;
  code?: string;
  reason?: string;
}

export interface BasketPreflight {
  legs: BasketLegCheck[];
  total: string;
  passing: number;
  capLeft: string;
  capLeftAfter: string;
}

export type BasketLegStatus = "waiting" | "sending" | "done" | "reverted" | "not-sent";

export interface BasketLegResult {
  symbol: string;
  amount: string;
  status: BasketLegStatus;
  txHash?: string;
  explorerUrl?: string;
  /** What the leg bought ("0.0263 TSLA"). */
  got?: string;
  reason?: string;
}

/** GET /trade/basket/:jobId. */
export interface BasketJob {
  state: "running" | "done" | "stopped" | "failed";
  legs: BasketLegResult[];
  message: string | null;
}
