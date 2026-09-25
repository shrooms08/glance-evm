/**
 * Chain reads and writes behind the HTTP routes: prices, vault state, activity, quotes with an on-chain preflight, and
 * agent trades. Every amount stays a bigint in its token's decimals until it is formatted for display.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  decodeEventLog,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";

import { erc20Abi, glanceVaultAbi, glanceVaultFactoryAbi, stockDeskAbi, testPriceFeedAbi } from "./abi.generated.js";
import type { CatalogEntry } from "./catalog.js";
import type { AppContext } from "./context.js";
import { primaryVault } from "./deployment.js";
import { buildPortfolio, findDeployBlock, PortfolioStore, toTradeEvents, VaultEventCache } from "./portfolio.js";
import {
  buildChart,
  cachedQuoteHistory,
  chainlinkReader,
  mainnetClient,
  quoteCacheFile,
  RoundStore,
  roundStoreFile,
  type ChartDeps,
  type FeedReader,
  type QuoteHistory,
} from "./chart.js";
import type { ChartRange } from "@glance/core/chart";
import { usTicker } from "@glance/core/tickers";
import { TtlCache } from "./ttlCache.js";
import { explainMove, type FeedMove, type WhyAnswer } from "./why.js";
import { onChainRefusals } from "./refusals.js";
import { glanceFactories } from "@glance/core/factories";
import { isRpcTrouble, RPC_TROUBLE_MESSAGE } from "./rpc.js";
import {
  decodeRevert,
  explainRevert,
  revertDataFromError,
  type ExplainContext,
  type GuardError,
  type MarketState,
  type Side,
} from "./errors.js";
import {
  bpsToPercent,
  formatDuration,
  formatQuantity,
  formatUsd,
  parseDecimal,
  tokenValueInUsdg,
  toDecimalString,
  usdgToTokens,
} from "./format.js";
import { summarizeWindow, WINDOW_SECONDS, type WindowEntry } from "./window.js";

const BPS = 10_000n;
/** Blocks scanned to rebuild the 24h windows. ~0.17s blocks: 1.2M is about 57 hours, comfortably over 24. */
const WINDOW_LOOKBACK_BLOCKS = 1_200_000n;
const LOG_CHUNK_BLOCKS = 2_000_000n;

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    readonly guard?: GuardError,
    /** For a trade a guard refused before sending: what was attempted (the refusal log records it). */
    readonly refused?: RefusedAttempt,
  ) {
    super(message);
  }
}

export interface RefusedAttempt {
  vault: Address;
  symbol: string;
  side: Side;
  amountIn: { formatted: string };
  preflight?: { simulatedAt?: number };
}

const marketStates: MarketState[] = ["OPEN", "CLOSED", "STALE"];

function money(raw: bigint, decimals: number) {
  return { raw: raw.toString(), value: toDecimalString(raw, decimals), formatted: formatUsd(raw, decimals) };
}

function quantity(raw: bigint, decimals: number, symbol: string) {
  return { raw: raw.toString(), value: toDecimalString(raw, decimals), formatted: formatQuantity(raw, decimals, symbol) };
}

export function stockBySymbol(ctx: AppContext, symbol: string): CatalogEntry {
  const entry = ctx.catalog.bySymbol.get(symbol.toUpperCase());
  if (!entry) throw new ApiError(404, "UNKNOWN_SYMBOL", `${symbol.toUpperCase()} isn't in the catalog.`);
  return entry;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export interface PriceReading {
  symbol: string;
  price: bigint;
  decimals: number;
  updatedAt: number;
  ageSeconds: number;
  state: MarketState;
  openMaxAge: number;
  closedMaxAge: number;
  /** The vault allows this token (tokenConfig.approved). */
  approved?: boolean;
}

function classify(age: number, openMaxAge: number, closedMaxAge: number): MarketState {
  if (age <= openMaxAge) return "OPEN";
  if (age <= closedMaxAge) return "CLOSED";
  return "STALE";
}

/** The chain's latest block number and time, read once and shared by every read in a request (cached 1.5s). */
let chainNowCache: { at: number; value: Promise<{ number: bigint; timestamp: number }> } | null = null;
function chainNow(ctx: AppContext): Promise<{ number: bigint; timestamp: number }> {
  if (chainNowCache && Date.now() - chainNowCache.at < 1_500) return chainNowCache.value;
  const value = ctx.client
    .getBlock({ blockTag: "latest" })
    .then((b) => ({ number: b.number, timestamp: Number(b.timestamp) }));
  value.catch(() => (chainNowCache = null));
  chainNowCache = { at: Date.now(), value };
  return value;
}

async function latestTimestamp(ctx: AppContext): Promise<number> {
  return (await chainNow(ctx)).timestamp;
}

/** Oracle price for a stock, classified with the freshness thresholds `vault` holds for that token. */
export async function readPrice(ctx: AppContext, stock: CatalogEntry, vault: Address): Promise<PriceReading> {
  const [round, decimals, config, now] = await Promise.all([
    ctx.client.readContract({ address: stock.feed, abi: testPriceFeedAbi, functionName: "latestRoundData" }),
    ctx.client.readContract({ address: stock.feed, abi: testPriceFeedAbi, functionName: "decimals" }),
    ctx.client.readContract({ address: vault, abi: glanceVaultAbi, functionName: "tokenConfig", args: [stock.token] }),
    latestTimestamp(ctx),
  ]);
  const [, answer, , updatedAtRaw] = round;
  const [approved, , openMaxAge, closedMaxAge] = config;
  const updatedAt = Number(updatedAtRaw);
  const age = Math.max(0, now - updatedAt);
  return {
    symbol: stock.symbol,
    price: answer,
    decimals,
    updatedAt,
    ageSeconds: age,
    // A feed the vault has never configured has zero thresholds: report it as the vault would treat it.
    state: answer <= 0n ? "STALE" : classify(age, openMaxAge, closedMaxAge),
    openMaxAge,
    closedMaxAge,
    approved,
  };
}

export async function priceView(ctx: AppContext, symbol: string, vaultParam?: string) {
  const stock = stockBySymbol(ctx, symbol);
  const vault = vaultParam ? getAddress(vaultParam) : ctx.defaultVault;
  const p = await readPrice(ctx, stock, vault);
  return {
    symbol: stock.symbol,
    name: stock.name,
    price: { raw: p.price.toString(), decimals: p.decimals, value: toDecimalString(p.price, p.decimals) },
    updatedAt: p.updatedAt,
    ageSeconds: p.ageSeconds,
    age: formatDuration(p.ageSeconds),
    marketState: p.state,
    freshness: { vault, openMaxAge: p.openMaxAge, closedMaxAge: p.closedMaxAge },
    feed: stock.feed,
    feedReal: stock.feedReal,
    priceSourceKind: stock.priceSourceKind,
    priceSource: stock.priceSource,
    mainnetFeed: stock.mainnetFeed,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type DecodedLog = { eventName: string; args: Record<string, unknown>; log: Log; timestamp: number };

async function getVaultLogs(ctx: AppContext, vault: Address, fromBlock: bigint, toBlock: bigint): Promise<DecodedLog[]> {
  const logs: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n < toBlock ? start + LOG_CHUNK_BLOCKS - 1n : toBlock;
    logs.push(...(await ctx.client.getLogs({ address: vault, fromBlock: start, toBlock: end })));
  }
  return decodeVaultLogs(ctx, logs);
}

/** Decodes a vault's raw logs (skipping any that aren't GlanceVault events), with their block times. */
async function decodeVaultLogs(ctx: AppContext, logs: Log[]): Promise<DecodedLog[]> {
  // Robinhood Chain's RPC sends a blockTimestamp field on logs, but as 0x0, so the times come from the blocks.
  await blockTimes(ctx, logs.map((l) => l.blockNumber).filter((n): n is bigint => n !== null));
  const out: DecodedLog[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: glanceVaultAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const given = Number((log as Log & { blockTimestamp?: bigint | Hex }).blockTimestamp ?? 0);
    const timestamp = given || (log.blockNumber !== null ? blockTimeCache.get(log.blockNumber) ?? 0 : 0);
    out.push({ eventName: decoded.eventName, args: (decoded.args ?? {}) as Record<string, unknown>, log, timestamp });
  }
  return out;
}

/** Block timestamps never change: cache them for the life of the process (bounded). */
const blockTimeCache = new Map<bigint, number>();
const BLOCK_TIME_CACHE_MAX = 20_000;

/** Fills blockTimeCache for `blocks`, fetching every missing one concurrently so they share one RPC batch. */
async function blockTimes(ctx: AppContext, blocks: bigint[]): Promise<void> {
  const missing = [...new Set(blocks)].filter((b) => !blockTimeCache.has(b));
  if (missing.length === 0) return;
  const got = await Promise.all(missing.map((blockNumber) => ctx.client.getBlock({ blockNumber })));
  if (blockTimeCache.size + got.length > BLOCK_TIME_CACHE_MAX) blockTimeCache.clear();
  for (const b of got) blockTimeCache.set(b.number, Number(b.timestamp));
}

function startBlock(ctx: AppContext, latest: bigint, lookback: bigint): bigint {
  const floor = BigInt(ctx.deployment.blockNumber);
  const byLookback = latest > lookback ? latest - lookback : 0n;
  return byLookback > floor ? byLookback : floor;
}

export interface Windows {
  buy: WindowEntry[];
  sell: WindowEntry[];
}

/** Rebuilds the vault's rolling 24h buy and sell windows from Bought and Sold events. */
export async function readWindows(ctx: AppContext, vault: Address, now: number): Promise<Windows> {
  // chainNow is at most 1.5s old; a trade just mined by /trade is read from its own receipt, not from here.
  const latest = (await chainNow(ctx)).number;
  const logs = await getVaultLogs(ctx, vault, startBlock(ctx, latest, WINDOW_LOOKBACK_BLOCKS), latest);
  const recent = logs.filter((l) => l.timestamp + WINDOW_SECONDS > now);
  return {
    buy: recent.filter((l) => l.eventName === "Bought").map((l) => ({ timestamp: l.timestamp, amount: l.args.usdgIn as bigint })),
    sell: recent.filter((l) => l.eventName === "Sold").map((l) => ({ timestamp: l.timestamp, amount: l.args.notional as bigint })),
  };
}

// ---------------------------------------------------------------------------
// Vault state
// ---------------------------------------------------------------------------

async function readVaultCore(ctx: AppContext, vault: Address) {
  const read = <F extends string>(functionName: F) =>
    ctx.client.readContract({ address: vault, abi: glanceVaultAbi, functionName: functionName as never });
  // One batch: the code check and every field together.
  const codePromise = ctx.client.getCode({ address: vault });
  codePromise.catch(() => {});
  try {
    const [owner, agent, agentExpiry, paused, perBuyCap, dailyCap, dailySellCap, maxSlippageBps, weekendCapBps, usdg, usdgDecimals, spent, sold] =
      await Promise.all([
        read("owner"),
        read("agent"),
        read("agentExpiry"),
        read("paused"),
        read("perBuyCap"),
        read("dailyCap"),
        read("dailySellCap"),
        read("maxSlippageBps"),
        read("weekendCapBps"),
        read("usdg"),
        read("usdgDecimals"),
        read("spentInWindow"),
        read("soldInWindow"),
        codePromise.then((code) => {
          if (!code || code === "0x") throw new ApiError(404, "NOT_A_VAULT", `There's no contract at ${vault}.`);
        }),
      ]);
    return {
      owner: owner as Address,
      agent: agent as Address,
      agentExpiry: Number(agentExpiry as bigint),
      paused: paused as boolean,
      perBuyCap: perBuyCap as bigint,
      dailyCap: dailyCap as bigint,
      dailySellCap: dailySellCap as bigint,
      maxSlippageBps: Number(maxSlippageBps),
      weekendCapBps: Number(weekendCapBps),
      usdg: usdg as Address,
      usdgDecimals: Number(usdgDecimals),
      spent: spent as bigint,
      sold: sold as bigint,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Only an answer from the chain can say this isn't a vault: a timeout or an unreachable RPC says nothing about it.
    if (isRpcTrouble(err)) throw rpcUnavailable();
    throw new ApiError(404, "NOT_A_VAULT", `${vault} isn't a Glance vault.`);
  }
}

/** The testnet RPC (every configured endpoint) failed or timed out: nothing is known about the vault or the trade. */
export function rpcUnavailable(message = RPC_TROUBLE_MESSAGE): ApiError {
  return new ApiError(503, "RPC_UNAVAILABLE", message);
}

type VaultCore = Awaited<ReturnType<typeof readVaultCore>>;

function effectiveCaps(v: VaultCore, state: MarketState) {
  const scale = (x: bigint) => (state === "OPEN" ? x : (x * BigInt(v.weekendCapBps)) / BPS);
  return {
    perTrade: money(scale(v.perBuyCap), v.usdgDecimals),
    dailyBuy: money(scale(v.dailyCap), v.usdgDecimals),
    dailySell: money(scale(v.dailySellCap), v.usdgDecimals),
  };
}

/** true for Paxos USDG, false for our TestUSDG stand-in, null for a USDG this deployment doesn't know. */
function usdgIsReal(ctx: AppContext, usdg: Address): boolean | null {
  if (isAddressEqual(usdg, ctx.deployment.usdg.address)) return ctx.deployment.usdg.real;
  const paxos = ctx.deployment.demoVaultPaxosUSDG;
  if (paxos && isAddressEqual(usdg, paxos.usdg)) return true;
  return null;
}

export async function vaultView(ctx: AppContext, vaultParam: string) {
  const vault = getAddress(vaultParam);
  const v = await readVaultCore(ctx, vault);
  const now = await latestTimestamp(ctx);
  const [windows, usdgBalance, positions] = await Promise.all([
    readWindows(ctx, vault, now),
    ctx.client.readContract({ address: v.usdg, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    Promise.all(
      ctx.catalog.entries.map(async (stock) => {
        const [balance, price] = await Promise.all([
          ctx.client.readContract({ address: stock.token, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
          readPrice(ctx, stock, vault),
        ]);
        const value = tokenValueInUsdg(balance, stock.tokenDecimals, price.price, price.decimals, v.usdgDecimals);
        return {
          symbol: stock.symbol,
          name: stock.name,
          token: stock.token,
          quantity: quantity(balance, stock.tokenDecimals, stock.symbol),
          value: money(value, v.usdgDecimals),
          marketState: price.state,
          /** The vault allows buying it (baskets use only these). */
          allowed: price.approved !== false,
          effectiveCaps: price.state === "STALE" ? null : effectiveCaps(v, price.state),
        };
      }),
    ),
  ]);

  const window = (entries: WindowEntry[], onChain: bigint, cap: bigint) => {
    const s = summarizeWindow(entries, now);
    return {
      used: money(onChain, v.usdgDecimals),
      limit: money(cap, v.usdgDecimals),
      remaining: money(cap > onChain ? cap - onChain : 0n, v.usdgDecimals),
      nextReleaseAt: s.nextReleaseAt,
      nextReleaseInSeconds: s.nextReleaseAt === null ? null : Math.max(0, s.nextReleaseAt - now),
      nextReleaseAmount: money(s.nextReleaseAmount, v.usdgDecimals),
      clearsAt: s.clearsAt,
      clearsInSeconds: s.clearsAt === null ? null : Math.max(0, s.clearsAt - now),
      tradesInWindow: s.entries,
      // The event-rebuilt window should match the contract exactly; false means history was out of range.
      reconstructed: s.used === onChain,
    };
  };

  const invested = positions.reduce((sum, p) => sum + BigInt(p.value.raw), 0n);
  return {
    address: vault,
    owner: v.owner,
    agent: isAddressEqual(v.agent, zeroAddress) ? null : v.agent,
    agentExpiry: v.agentExpiry,
    agentActive: !isAddressEqual(v.agent, zeroAddress) && now < v.agentExpiry,
    agentExpiresInSeconds: Math.max(0, v.agentExpiry - now),
    paused: v.paused,
    usdg: { address: v.usdg, decimals: v.usdgDecimals, real: usdgIsReal(ctx, v.usdg) },
    limits: {
      perTrade: money(v.perBuyCap, v.usdgDecimals),
      dailyBuy: money(v.dailyCap, v.usdgDecimals),
      dailySell: money(v.dailySellCap, v.usdgDecimals),
      maxSlippageBps: v.maxSlippageBps,
      maxSlippage: bpsToPercent(v.maxSlippageBps),
      weekendCapBps: v.weekendCapBps,
      weekendCap: bpsToPercent(v.weekendCapBps),
    },
    effectiveCaps: Object.fromEntries(
      marketStates.filter((s) => s !== "STALE").map((s) => [s, effectiveCaps(v, s)]),
    ),
    buyWindow: window(windows.buy, v.spent, v.dailyCap),
    sellWindow: window(windows.sell, v.sold, v.dailySellCap),
    balances: {
      usdg: money(usdgBalance, v.usdgDecimals),
      invested: money(invested, v.usdgDecimals),
      total: money(usdgBalance + invested, v.usdgDecimals),
    },
    positions,
    asOf: now,
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export async function activityView(ctx: AppContext, vaultParam: string, limit: number) {
  const vault = getAddress(vaultParam);
  const v = await readVaultCore(ctx, vault);
  const latest = await ctx.client.getBlockNumber({ cacheTime: 0 }); // never a cached height: a just-mined trade must be included
  const logs = await getVaultLogs(ctx, vault, startBlock(ctx, latest, ctx.config.ACTIVITY_LOOKBACK_BLOCKS), latest);
  const d = v.usdgDecimals;
  const stockOf = (token: unknown) => ctx.catalog.byToken.get(String(token).toLowerCase());
  const symbolOf = (token: unknown) => stockOf(token)?.symbol ?? String(token);
  const qty = (token: unknown, raw: unknown) => {
    const s = stockOf(token);
    return formatQuantity(raw as bigint, s?.tokenDecimals ?? 18, s?.symbol ?? "tokens");
  };

  const items: ActivityItem[] = logs.map(({ eventName, args, log, timestamp }) => {
    let kind: "trade" | "owner";
    let summary: string;
    switch (eventName) {
      case "Bought":
        kind = "trade";
        summary = `Bought ${qty(args.token, args.tokensOut)} for ${formatUsd(args.usdgIn as bigint, d)}`;
        break;
      case "Sold":
        kind = "trade";
        summary = `Sold ${qty(args.token, args.tokensIn)} for ${formatUsd(args.usdgOut as bigint, d)}`;
        break;
      case "Deposited":
        kind = "owner";
        summary = `Deposited ${formatUsd(args.amount as bigint, d)}`;
        break;
      case "Withdrawn": {
        kind = "owner";
        const isUsdg = isAddressEqual(args.token as Address, v.usdg);
        summary = `Withdrew ${isUsdg ? formatUsd(args.amount as bigint, d) : qty(args.token, args.amount)}`;
        break;
      }
      case "AgentSet":
        kind = "owner";
        summary = isAddressEqual(args.agent as Address, zeroAddress)
          ? "Revoked the agent"
          : `Authorised agent ${args.agent as string} until ${new Date(Number(args.expiry) * 1000).toISOString()}`;
        break;
      case "LimitsSet":
        kind = "owner";
        summary = `Set limits: ${formatUsd(args.perBuyCap as bigint, d)} per trade, ${formatUsd(args.dailyCap as bigint, d)} a day buying, ${formatUsd(args.dailySellCap as bigint, d)} a day selling, ${bpsToPercent(Number(args.maxSlippageBps))} slippage, ${bpsToPercent(Number(args.weekendCapBps))} when closed`;
        break;
      case "PausedSet":
        kind = "owner";
        summary = args.paused ? "Paused trading" : "Resumed trading";
        break;
      case "TokenApprovalSet":
        kind = "owner";
        summary = `${args.approved ? "Approved" : "Removed"} ${symbolOf(args.token)}`;
        break;
      case "TokenFreshnessSet":
        kind = "owner";
        summary = `Set ${symbolOf(args.token)} price freshness: open up to ${formatDuration(Number(args.openMaxAge))}, closed up to ${formatDuration(Number(args.closedMaxAge))}`;
        break;
      case "RouterApprovalSet":
        kind = "owner";
        summary = `${args.approved ? "Approved" : "Removed"} trading venue ${args.router as string}`;
        break;
      case "SequencerUptimeFeedSet":
        kind = "owner";
        summary = isAddressEqual(args.feed as Address, zeroAddress)
          ? "Turned off the sequencer uptime check"
          : `Set the sequencer uptime feed to ${args.feed as string}`;
        break;
      default:
        kind = "owner";
        summary = eventName;
    }
    const data = Object.fromEntries(
      Object.entries(args).map(([k, val]) => [k, typeof val === "bigint" ? val.toString() : val]),
    );
    if ((eventName === "Bought" || eventName === "Sold") && typeof data.marketState === "number") {
      data.marketState = marketStates[data.marketState] ?? data.marketState;
    }
    return {
      type: eventName,
      kind,
      summary,
      symbol: "token" in args ? symbolOf(args.token) : undefined,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber?.toString(),
      logIndex: log.logIndex,
      timestamp,
      explorerUrl: `${ctx.config.EXPLORER_URL}/tx/${log.transactionHash}`,
      data,
    };
  });

  // Refusals, next to the trades that went through: what the guards stopped before sending, and what the chain reverted.
  const refusalItems: ActivityItem[] = ctx.refusals.forVault(vault).map((r) => ({
    type: "Refused",
    kind: "refusal",
    summary: r.attempt,
    symbol: r.symbol,
    txHash: null,
    blockNumber: r.blockNumber,
    logIndex: null,
    timestamp: r.at,
    explorerUrl: null,
    data: { side: r.side, amount: r.amount },
    refusal: { code: r.code, error: r.error, message: r.message, source: "preflight", via: r.via, sent: false },
  }));
  let onChain: "ok" | "unavailable" = "ok";
  try {
    const tokens = Object.fromEntries(ctx.catalog.entries.map((e) => [e.token.toLowerCase(), { symbol: e.symbol, decimals: e.tokenDecimals }]));
    const reverted = await onChainRefusals(ctx.config.EXPLORER_URL, vault, { usdgDecimals: d, now: Math.floor(Date.now() / 1000), tokens, usdgAddress: v.usdg });
    for (const r of reverted) {
      const stock = r.params.token ? stockOf(r.params.token) : undefined;
      const byAgent = !isAddressEqual(v.agent, zeroAddress) && isAddressEqual(r.from, v.agent);
      let attempt = `Called ${r.method}`;
      if (r.method === "buy" && r.params.usdgIn) attempt = `Buy ${formatUsd(BigInt(r.params.usdgIn), d)} of ${stock?.symbol ?? "a token"}`;
      if (r.method === "sell" && r.params.tokensIn) attempt = `Sell ${qty(r.params.token, BigInt(r.params.tokensIn))}`;
      refusalItems.push({
        type: "Reverted",
        kind: "refusal",
        summary: attempt,
        symbol: stock?.symbol,
        txHash: r.txHash,
        blockNumber: r.blockNumber,
        logIndex: null,
        timestamp: r.timestamp,
        explorerUrl: `${ctx.config.EXPLORER_URL}/tx/${r.txHash}`,
        data: { method: r.method, ...r.params },
        refusal: { code: r.guard.code, error: r.guard.error, message: r.guard.message, source: "onchain", sent: true, from: r.from, byAgent },
      });
    }
  } catch {
    onChain = "unavailable";
  }

  const all: ActivityItem[] = [...items, ...refusalItems];
  all.sort((a, b) => b.timestamp - a.timestamp || Number(b.blockNumber ?? 0) - Number(a.blockNumber ?? 0) || (b.logIndex ?? 0) - (a.logIndex ?? 0));
  return {
    vault,
    count: Math.min(limit, all.length),
    items: all.slice(0, limit),
    sources: {
      events: "ok" as const,
      preflightRefusals: { persisted: ctx.refusals.persisted },
      onChainRefusals: onChain,
    },
  };
}

export interface ActivityItem {
  type: string;
  kind: "trade" | "owner" | "refusal";
  summary: string;
  symbol?: string;
  txHash: Hex | null;
  blockNumber?: string;
  logIndex: number | null;
  timestamp: number;
  explorerUrl: string | null;
  data: Record<string, unknown>;
  refusal?: {
    code: string;
    error: string;
    message: string;
    /** preflight: simulated as the agent and never sent. onchain: sent, and the vault reverted it. */
    source: "preflight" | "onchain";
    via?: "quote" | "trade";
    sent: boolean;
    from?: Address;
    byAgent?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Quote and preflight
// ---------------------------------------------------------------------------

export interface TradeRequest {
  vault: string;
  symbol: string;
  side: Side;
  /** Decimal string: USDG for a buy, shares for a sell. */
  amount: string;
  /** Extra tolerance below the desk quote for minOut, in basis points. Default 0: the desk is deterministic. */
  slippageBps?: number;
}

async function prepare(ctx: AppContext, req: TradeRequest) {
  const vault = getAddress(req.vault);
  const stock = stockBySymbol(ctx, req.symbol);
  const v = await readVaultCore(ctx, vault);
  const desk = await deskFor(ctx, vault, v.usdg);
  const decimals = req.side === "buy" ? v.usdgDecimals : stock.tokenDecimals;
  let amount: bigint;
  try {
    amount = parseDecimal(req.amount, decimals);
  } catch (err) {
    throw new ApiError(400, "BAD_AMOUNT", (err as Error).message);
  }
  if (amount === 0n) throw new ApiError(400, "BAD_AMOUNT", "The amount has to be more than zero.");
  return { vault, stock, v, desk, amount };
}

/** Which desk serves which vault changes only when the owner reconfigures it; remember it for a minute. */
const deskCache = new Map<string, { at: number; desk: Address }>();

/** The desk in the deployment that quotes this vault's USDG and that the vault has approved. */
async function deskFor(ctx: AppContext, vault: Address, usdg: Address): Promise<Address> {
  const key = `${vault}:${usdg}`.toLowerCase();
  const hit = deskCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.desk;
  const desk = await findDesk(ctx, vault, usdg);
  deskCache.set(key, { at: Date.now(), desk });
  return desk;
}

async function findDesk(ctx: AppContext, vault: Address, usdg: Address): Promise<Address> {
  for (const desk of ctx.desks) {
    const [deskUsdg, approved] = await Promise.all([
      ctx.client.readContract({ address: desk, abi: stockDeskAbi, functionName: "usdg" }),
      ctx.client.readContract({ address: vault, abi: glanceVaultAbi, functionName: "approvedRouters", args: [desk] }),
    ]);
    if (isAddressEqual(deskUsdg, usdg) && approved) return desk;
  }
  // Fall back to a desk quoting the right USDG even if unapproved, so the preflight reports RouterNotApproved.
  for (const desk of ctx.desks) {
    const deskUsdg = await ctx.client.readContract({ address: desk, abi: stockDeskAbi, functionName: "usdg" });
    if (isAddressEqual(deskUsdg, usdg)) return desk;
  }
  throw new ApiError(422, "NO_VENUE", "No trading desk in this deployment quotes this vault's USDG.");
}

function explainContext(ctx: AppContext, p: Awaited<ReturnType<typeof prepare>>, side: Side, state: MarketState | undefined, windows: Windows, now: number): ExplainContext {
  return {
    usdgDecimals: p.v.usdgDecimals,
    now,
    side,
    marketState: state,
    symbol: p.stock.symbol,
    tokenDecimals: p.stock.tokenDecimals,
    tokens: Object.fromEntries(
      ctx.catalog.entries.map((e) => [e.token.toLowerCase(), { symbol: e.symbol, decimals: e.tokenDecimals }]),
    ),
    usdgAddress: p.v.usdg,
    buyWindow: windows.buy,
    sellWindow: windows.sell,
  };
}

export async function quoteView(ctx: AppContext, req: TradeRequest, simulateAs?: Address) {
  // Round trip 1: vault state, price, the 24h windows and the chain clock, all independent, go out as one batch.
  const vaultAddr = getAddress(req.vault);
  const stockEarly = stockBySymbol(ctx, req.symbol);
  const pricePromise = readPrice(ctx, stockEarly, vaultAddr);
  const windowsPromise = chainNow(ctx).then((n) => readWindows(ctx, vaultAddr, n.timestamp));
  pricePromise.catch(() => {});
  windowsPromise.catch(() => {});
  const p = await prepare(ctx, req);
  const now = await latestTimestamp(ctx);
  // Everything that doesn't depend on another read goes out together, as one batch.
  const deskQuote = ctx.client
    .readContract({
      address: p.desk,
      abi: stockDeskAbi,
      functionName: req.side === "buy" ? "quoteBuy" : "quoteSell",
      args: [p.stock.token, p.amount],
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
  // Round trip 2: the desk's quote and spread (the desk depends on the vault's USDG). Round trip 3 is the simulation.
  const [price, windows, spreadRaw] = await Promise.all([
    pricePromise,
    windowsPromise,
    ctx.client.readContract({ address: p.desk, abi: stockDeskAbi, functionName: "spreadBps" }),
  ]);
  const exCtx = explainContext(ctx, p, req.side, price.state, windows, now);
  const d = p.v.usdgDecimals;

  // Oracle-implied amount, before the desk's spread.
  const oracleOut =
    req.side === "buy"
      ? usdgToTokens(p.amount, d, price.price, price.decimals, p.stock.tokenDecimals)
      : tokenValueInUsdg(p.amount, p.stock.tokenDecimals, price.price, price.decimals, d);

  const dq = await deskQuote;
  // A desk quote that failed because the RPC did is not a refusal: never show it as a guard.
  if (!dq.ok && isRpcTrouble(dq.err)) throw rpcUnavailable();
  const deskOut: bigint | null = dq.ok ? dq.value : null;
  const deskError: GuardError | null = dq.ok ? null : explainRevert(decodeRevert(revertDataFromError(dq.err)), exCtx);
  const spreadBps = Number(spreadRaw);

  const extra = BigInt(req.slippageBps ?? 0);
  const minOut = deskOut === null ? 0n : (deskOut * (BPS - extra)) / BPS;
  const agent = simulateAs ?? ctx.signer?.account.address ?? p.v.agent;
  const args = [p.stock.token, p.desk, p.amount, minOut] as const;

  let preflight: { ok: true } | { ok: false; guard: GuardError };
  if (deskError) {
    preflight = { ok: false, guard: deskError };
  } else {
    try {
      await ctx.client.simulateContract({
        address: p.vault,
        abi: glanceVaultAbi,
        functionName: req.side,
        args,
        account: agent,
      });
      preflight = { ok: true };
    } catch (err) {
      // The preflight couldn't run (RPC trouble): that's not the vault saying no.
      if (isRpcTrouble(err)) throw rpcUnavailable();
      preflight = { ok: false, guard: explainRevert(decodeRevert(revertDataFromError(err)), exCtx) };
    }
  }

  const outIsUsdg = req.side === "sell";
  const fmtOut = (raw: bigint) =>
    outIsUsdg ? money(raw, d) : quantity(raw, p.stock.tokenDecimals, p.stock.symbol);
  return {
    vault: p.vault,
    symbol: p.stock.symbol,
    side: req.side,
    amountIn: req.side === "buy" ? money(p.amount, d) : quantity(p.amount, p.stock.tokenDecimals, p.stock.symbol),
    desk: p.desk,
    deskQuote: deskOut === null ? null : fmtOut(deskOut),
    oracleImplied: fmtOut(oracleOut),
    spreadBps,
    spread: bpsToPercent(spreadBps),
    minOut: fmtOut(minOut),
    price: { raw: price.price.toString(), decimals: price.decimals, value: toDecimalString(price.price, price.decimals) },
    marketState: price.state,
    priceAgeSeconds: price.ageSeconds,
    preflight: {
      ...preflight,
      simulatedAs: agent,
      simulatedAt: now,
    },
    // Internal use by /trade; stripped from the HTTP response.
    _call: { args, minOut, exCtx },
  };
}

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

export async function tradeView(ctx: AppContext, req: TradeRequest) {
  const signer = ctx.signer;
  if (!signer) throw new ApiError(503, "AGENT_KEY_MISSING", "The agent key isn't loaded on this server, so I can't trade.");

  return signer.exclusive(async () => {
    const quote = await quoteView(ctx, req, signer.account.address);
    if (!quote.preflight.ok) {
      throw new ApiError(422, quote.preflight.guard.code, quote.preflight.guard.message, quote.preflight.guard, quote);
    }
    const { args, exCtx } = quote._call;
    const { request } = await ctx.client.simulateContract({
      address: quote.vault,
      abi: glanceVaultAbi,
      functionName: req.side,
      args,
      account: signer.account,
    });

    let hash: Hex;
    try {
      hash = await signer.wallet.writeContract(request);
    } catch (err) {
      // The send itself may or may not have reached the chain: say exactly that, never retry on our own.
      if (isRpcTrouble(err)) {
        throw rpcUnavailable("The Robinhood Chain testnet stopped responding while sending, so I can't tell whether the trade went through. Check your activity before trying again.");
      }
      // The send's own simulation refused it: nothing reached the chain.
      const guard = explainRevert(decodeRevert(revertDataFromError(err)), exCtx);
      throw new ApiError(422, guard.code, guard.message, guard, quote);
    }
    let receipt: Awaited<ReturnType<typeof ctx.client.waitForTransactionReceipt>>;
    try {
      receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
    } catch (err) {
      if (isRpcTrouble(err) || (err as Error).name === "WaitForTransactionReceiptTimeoutError") {
        throw rpcUnavailable(`The trade was sent (transaction ${hash}), but the testnet isn't responding to confirm it. Check the explorer before trying again.`);
      }
      throw err;
    }

    if (receipt.status !== "success") {
      // Replay against the state just before the failing block to recover the reason.
      let guard: GuardError = explainRevert(null, exCtx);
      try {
        await ctx.client.simulateContract({
          address: quote.vault,
          abi: glanceVaultAbi,
          functionName: req.side,
          args,
          account: signer.account.address,
          blockNumber: receipt.blockNumber - 1n,
        });
      } catch (err) {
        guard = explainRevert(decodeRevert(revertDataFromError(err)), exCtx);
      }
      throw new ApiError(422, guard.code, `${guard.message} (transaction ${hash} reverted)`, guard);
    }

    const stock = stockBySymbol(ctx, req.symbol);
    const d = exCtx.usdgDecimals;
    let filled: Record<string, unknown> | null = null;
    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, quote.vault)) continue;
      try {
        const ev = decodeEventLog({ abi: glanceVaultAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Bought") {
          filled = { usdgIn: money(ev.args.usdgIn, d), tokensOut: quantity(ev.args.tokensOut, stock.tokenDecimals, stock.symbol) };
        } else if (ev.eventName === "Sold") {
          filled = { tokensIn: quantity(ev.args.tokensIn, stock.tokenDecimals, stock.symbol), usdgOut: money(ev.args.usdgOut, d) };
        }
      } catch {
        // not a vault event
      }
    }

    const [usdgAfter, tokenAfter] = await Promise.all([
      ctx.client.readContract({ address: exCtx.usdgAddress!, abi: erc20Abi, functionName: "balanceOf", args: [quote.vault] }),
      ctx.client.readContract({ address: stock.token, abi: erc20Abi, functionName: "balanceOf", args: [quote.vault] }),
    ]);
    return {
      txHash: hash,
      explorerUrl: `${ctx.config.EXPLORER_URL}/tx/${hash}`,
      blockNumber: receipt.blockNumber.toString(),
      vault: quote.vault,
      symbol: stock.symbol,
      side: req.side,
      filled,
      balancesAfter: {
        usdg: money(usdgAfter, d),
        [stock.symbol]: quantity(tokenAfter, stock.tokenDecimals, stock.symbol),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** Blocks scanned for the keeper's last write to each feed. ~0.17s blocks: 1.2M is about 57 hours. */
const FEED_WRITE_LOOKBACK_BLOCKS = 1_200_000n;

/**
 * Freshness of every stand-in feed: price, age, the market state the demo vault would apply, where the price comes
 * from, and when it was last written on chain (the keeper, or the deploy script), read from PriceSet events.
 */
async function feedStatus(ctx: AppContext, latest: bigint, now: number) {
  const vault = ctx.defaultVault;
  const fromBlock = startBlock(ctx, latest, FEED_WRITE_LOOKBACK_BLOCKS);
  return Promise.all(
    ctx.catalog.entries.map(async (stock) => {
      const [price, logs] = await Promise.all([
        readPrice(ctx, stock, vault),
        ctx.client.getLogs({
          address: stock.feed,
          event: testPriceFeedAbi.find((i) => i.type === "event" && i.name === "PriceSet") as Extract<
            (typeof testPriceFeedAbi)[number],
            { type: "event"; name: "PriceSet" }
          >,
          fromBlock,
          toBlock: latest,
        }),
      ]);
      const last = logs.at(-1) as (Log & { blockTimestamp?: bigint | Hex }) | undefined;
      // Decoded logs may drop the RPC's blockTimestamp field; read the block when it is missing.
      let lastWriteAt = last?.blockTimestamp ? Number(last.blockTimestamp) : null;
      if (last && lastWriteAt === null && last.blockNumber !== null) {
        lastWriteAt = Number((await ctx.client.getBlock({ blockNumber: last.blockNumber })).timestamp);
      }
      return {
        symbol: stock.symbol,
        price: { raw: price.price.toString(), decimals: price.decimals, value: toDecimalString(price.price, price.decimals) },
        updatedAt: price.updatedAt,
        ageSeconds: price.ageSeconds,
        age: formatDuration(price.ageSeconds),
        marketState: price.state,
        source: stock.priceSourceKind,
        sourceDetail: stock.priceSource,
        mainnetFeed: stock.mainnetFeed,
        lastWrite: last
          ? {
              at: lastWriteAt,
              agoSeconds: lastWriteAt === null ? null : Math.max(0, now - lastWriteAt),
              txHash: last.transactionHash,
            }
          : null,
      };
    }),
  );
}

/**
 * Claude's budget for /health: the models in use (null where Claude is off), the total limit and calls used, the same
 * per purpose, and whether Claude is paused.
 */
export function llmHealth(ctx: Pick<AppContext, "llm" | "intentModel" | "llmModels" | "llmBudget"> & { why?: AppContext["why"]; showMe?: AppContext["showMe"] }) {
  const { dailyLimit, usedToday, byPurpose, paused } = ctx.llmBudget.status();
  return {
    models: {
      resolver: ctx.llm ? ctx.llmModels.resolver : null,
      intent: ctx.intentModel ? ctx.llmModels.intent : null,
      why: ctx.why?.summarizer ? ctx.llmModels.why : null,
      showme: ctx.showMe ? ctx.llmModels.other : null,
    },
    dailyLimit,
    usedToday,
    byPurpose: Object.fromEntries(Object.entries(byPurpose).map(([p, b]) => [p, { usedToday: b.used, limit: b.limit }])) as Record<keyof typeof byPurpose, { usedToday: number; limit: number }>,
    paused,
  };
}

/**
 * The speaking voice for /health: the one in use (the first of the chain), its endpoint, the fallbacks in order, and
 * which one served the last reply (null before the first). Names and URLs only: never a key.
 */
export function voiceHealth(ctx: Pick<AppContext, "voice"> & { prerecorded?: AppContext["prerecorded"] }) {
  const [inUse, ...fallbacks] = ctx.voice.speech.chain;
  return {
    /** Speech recognition: the provider and model that listen, and the fallback (AssemblyAI -> Deepgram). */
    transcription: ctx.voice.status.stt ?? null,
    speech: inUse ? { provider: inUse.provider, voice: inUse.voice, endpoint: inUse.endpoint } : null,
    fallbacks: fallbacks.map((f) => ({ provider: f.provider, voice: f.voice, endpoint: f.endpoint })),
    lastServedBy: ctx.voice.speech.lastServedBy()?.voice ?? null,
    /** The last 20 replies: the voice that spoke, what was passed over and why, time to first byte. Never the text. */
    decisions: ctx.voice.decisions.list(),
    prerecordedLines: ctx.prerecorded?.size ?? 0,
  };
}

export async function healthView(ctx: AppContext) {
  const [chainId, blockNumber] = await Promise.all([ctx.client.getChainId(), ctx.client.getBlockNumber({ cacheTime: 0 })]);
  const feeds = await feedStatus(ctx, blockNumber, await latestTimestamp(ctx));
  const lastKeeperWrite = feeds.reduce<number | null>((max, f) => (f.lastWrite?.at && (max === null || f.lastWrite.at > max) ? f.lastWrite.at : max), null);
  const primary = primaryVault(ctx.deployment);
  const agent = ctx.signer?.account.address ?? primary.agent;
  const balance = await ctx.client.getBalance({ address: agent });
  return {
    ok: chainId === ctx.deployment.chainId,
    chainId,
    expectedChainId: ctx.deployment.chainId,
    blockNumber: blockNumber.toString(),
    agent: {
      address: agent,
      keyLoaded: ctx.signer !== null,
      matchesDemoVault: isAddressEqual(agent, primary.agent),
      ethBalance: toDecimalString(balance, 18),
      ethBalanceWei: balance.toString(),
    },
    llmFallback: ctx.llm !== null,
    llm: llmHealth(ctx),
    voice: voiceHealth(ctx),
    // Every vault factory; vaults from either are GlanceVaults, and the vault checks above never depend on which.
    factories: glanceFactories(ctx.deployment),
    keeper: {
      // The local pause file. The scheduled GitHub Actions keeper is paused by committing this file.
      pausedLocally: existsSync(ctx.config.KEEPER_PAUSE_FILE),
      lastWriteAt: lastKeeperWrite,
    },
    feeds,
    demoVaults: {
      testUSDG: ctx.deployment.demoVaultTestUSDG.address,
      paxosUSDG: ctx.deployment.demoVaultPaxosUSDG?.address ?? null,
      /** The headline vault (real Paxos USDG once funded); the TestUSDG vault stays as a fallback with its own faucet. */
      primary: primary.address,
      defaultVault: ctx.defaultVault,
      faucets: {
        paxosUSDG: ctx.deployment.demoVaultPaxosUSDG?.faucetUrl ?? null,
        testUSDG: ctx.deployment.demoVaultTestUSDG.faucetUrl ?? null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

/** One incremental event cache per running API (per context, so tests stay isolated), persisted under .cache. */
const portfolioCaches = new WeakMap<AppContext, VaultEventCache>();
export function portfolioEvents(ctx: AppContext): VaultEventCache {
  let cache = portfolioCaches.get(ctx);
  if (!cache) {
    cache = new VaultEventCache(
      {
        latestBlock: async () => (await chainNow(ctx)).number,
        deployBlock: (vault, latest) => vaultDeployBlock(ctx, vault, latest),
        events: async (vault, from, to) => toTradeEvents(await getVaultLogs(ctx, vault, from, to)),
        // The head and the new logs in one batch; logs past that head are left for the next read.
        since: async (vault, from) => {
          const [head, logs] = await Promise.all([chainNow(ctx), ctx.client.getLogs({ address: vault, fromBlock: from, toBlock: "latest" })]);
          const upTo = logs.filter((l) => l.blockNumber !== null && l.blockNumber <= head.number);
          return { to: head.number, events: toTradeEvents(await decodeVaultLogs(ctx, upTo)) };
        },
      },
      new PortfolioStore(ctx.cacheDir ? join(ctx.cacheDir, `portfolio-${ctx.deployment.chainId}.json`) : null),
    );
    portfolioCaches.set(ctx, cache);
  }
  return cache;
}

const vaultCreatedEvent = glanceVaultFactoryAbi.find((i) => i.type === "event" && i.name === "VaultCreated") as Extract<
  (typeof glanceVaultFactoryAbi)[number],
  { type: "event"; name: "VaultCreated" }
>;

/**
 * Where a vault's history starts: the block of its VaultCreated event, from either factory (V2 vaults from the V2
 * factory, V1 vaults from the original), found by one filtered log query per 2M blocks. A vault made outside a factory
 * (the demo vaults) falls back to a one-time binary search on its code. Either way the answer is stored with the vault.
 */
export async function vaultDeployBlock(ctx: AppContext, vault: Address, latest: bigint): Promise<bigint> {
  const floor = BigInt(ctx.deployment.blockNumber);
  const factories = glanceFactories(ctx.deployment).map((f) => f.address);
  const ranges: Array<[bigint, bigint]> = [];
  for (let start = floor; start <= latest; start += LOG_CHUNK_BLOCKS) ranges.push([start, start + LOG_CHUNK_BLOCKS - 1n < latest ? start + LOG_CHUNK_BLOCKS - 1n : latest]);
  try {
    const found = await Promise.all(
      ranges.map(([fromBlock, toBlock]) => ctx.client.getLogs({ address: factories, event: vaultCreatedEvent, args: { vault }, fromBlock, toBlock })),
    );
    const first = found.flat().find((l) => l.blockNumber !== null);
    if (first?.blockNumber != null) return first.blockNumber;
  } catch {
    // fall through to the search
  }
  return findDeployBlock((blockNumber) => ctx.client.getCode({ address: vault, blockNumber }), floor, latest);
}

export async function portfolioView(ctx: AppContext, vaultParam: string) {
  const events = portfolioEvents(ctx);
  let usdg: { address: Address; decimals: number } | null = null;
  const view = await buildPortfolio(
    {
      // The vault's USDG and its decimals are immutable: read once, then kept with the vault's events.
      readVault: async (vault) => {
        const known = events.store.get(vault)?.usdg;
        if (known) return { usdg: known.address, usdgDecimals: known.decimals };
        const v = await readVaultCore(ctx, vault);
        usdg = { address: v.usdg, decimals: v.usdgDecimals };
        return { usdg: v.usdg, usdgDecimals: v.usdgDecimals };
      },
      readPrice: async (symbol, vault) => {
        const p = await readPrice(ctx, stockBySymbol(ctx, symbol), vault);
        return { price: p.price, decimals: p.decimals, ageSeconds: p.ageSeconds, state: p.state };
      },
      balanceOf: (token, holder) => ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
      events,
      now: () => latestTimestamp(ctx),
    },
    ctx,
    vaultParam,
  );
  // Read from the chain this time: kept with the vault's events from now on.
  const record = events.store.get(view.vault);
  if (usdg && record) events.store.set(view.vault, { ...record, usdg });
  return view;
}

// ---------------------------------------------------------------------------
// Why it moved
// ---------------------------------------------------------------------------

/** About 3 days of Robinhood Chain testnet blocks, to find where a feed stood 3 days before its last update. */
const MOVE_LOOKBACK_BLOCKS = 1_600_000n;

/**
 * The move over the last 3 days of the feed's own history (its PriceSet events), measured up to its last update, so a
 * closed market reads "as of the last close". Null when there's no earlier point to compare with.
 */
export async function feedMove(ctx: AppContext, symbol: string): Promise<FeedMove | null> {
  const stock = stockBySymbol(ctx, symbol);
  const [latest, current] = await Promise.all([ctx.client.getBlockNumber({ cacheTime: 0 }), readPrice(ctx, stock, ctx.defaultVault)]);
  const logs = await ctx.client.getLogs({
    address: stock.feed,
    event: testPriceFeedAbi.find((i) => i.type === "event" && i.name === "PriceSet") as Extract<(typeof testPriceFeedAbi)[number], { type: "event"; name: "PriceSet" }>,
    fromBlock: startBlock(ctx, latest, MOVE_LOOKBACK_BLOCKS),
    toBlock: latest,
  });
  const points = logs
    .map((l) => ({ answer: l.args.answer as bigint, updatedAt: Number(l.args.updatedAt as bigint) }))
    .filter((p) => p.answer > 0n && p.updatedAt > 0)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  if (points.length === 0) return null;
  const windowStart = current.updatedAt - 3 * 86_400;
  const from = points.filter((p) => p.updatedAt <= windowStart).at(-1) ?? points[0]!;
  if (from.updatedAt >= current.updatedAt) return null;
  return { fromPrice: from.answer, toPrice: current.price, decimals: current.decimals, fromAt: from.updatedAt, toAt: current.updatedAt, marketState: current.state };
}

export async function whyView(ctx: AppContext, symbolParam: string): Promise<WhyAnswer> {
  const stock = stockBySymbol(ctx, symbolParam);
  return explainMove(
    { ...ctx.why, feedMove: (s) => feedMove(ctx, s), now: () => Date.now(), log: (l) => console.log(l) },
    { symbol: stock.symbol, name: stock.name },
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

const chartDepsByCtx = new WeakMap<AppContext, ChartDeps>();
const THRESHOLDS_TTL_MS = 10 * 60 * 1000;
const QUOTE_HISTORY_TTL_MS = 5 * 60 * 1000;

/** Everything a chart reads, built once per context (tests replace parts through ctx.chartOverrides). */
export function chartDeps(ctx: AppContext): ChartDeps {
  const known = chartDepsByCtx.get(ctx);
  if (known) return known;
  let mainnet: ReturnType<typeof mainnetClient> | null = null;
  const readers = new Map<string, FeedReader>();
  const thresholds = new Map<string, { at: number; value: Promise<{ openMaxAge: number; closedMaxAge: number } | null> }>();
  const refreshing = new Set<string>();
  const deps: ChartDeps = {
    reader(feed) {
      let r = readers.get(feed);
      if (!r) readers.set(feed, (r = chainlinkReader((mainnet ??= mainnetClient(ctx.config.RPC_MAINNET_URL)), feed)));
      return r;
    },
    store: new RoundStore(roundStoreFile(ctx)),
    quoteHistory: cachedQuoteHistory(new TtlCache<QuoteHistory>(quoteCacheFile(ctx), QUOTE_HISTORY_TTL_MS)),
    async keeperHistory(symbol, since) {
      const stock = stockBySymbol(ctx, symbol);
      const latest = (await chainNow(ctx)).number;
      // ~0.15s blocks: enough blocks to cover the range, from the deployment at the earliest.
      const lookback = BigInt(Math.ceil((Date.now() / 1000 - since) / 0.15));
      const event = testPriceFeedAbi.find((i) => i.type === "event" && i.name === "PriceSet") as Extract<(typeof testPriceFeedAbi)[number], { type: "event"; name: "PriceSet" }>;
      const [decimals, logs] = await Promise.all([
        ctx.client.readContract({ address: stock.feed, abi: testPriceFeedAbi, functionName: "decimals" }),
        ctx.client.getLogs({ address: stock.feed, event, fromBlock: startBlock(ctx, latest, lookback), toBlock: latest }),
      ]);
      return logs
        .map((l) => ({ t: Number(l.args.updatedAt as bigint), answer: l.args.answer as bigint, decimals }))
        .filter((p) => p.answer > 0n && p.t >= since)
        .sort((a, b) => a.t - b.t);
    },
    thresholds(symbol) {
      const hit = thresholds.get(symbol);
      if (hit && Date.now() - hit.at < THRESHOLDS_TTL_MS) return hit.value;
      const value = readPrice(ctx, stockBySymbol(ctx, symbol), ctx.defaultVault).then(
        (p) => ({ openMaxAge: Number(p.openMaxAge), closedMaxAge: Number(p.closedMaxAge) }),
        () => {
          thresholds.delete(symbol); // a failed read isn't remembered: the next chart asks again
          return null;
        },
      );
      thresholds.set(symbol, { at: Date.now(), value });
      return value;
    },
    trades(vault) {
      const record = portfolioEvents(ctx).store.get(vault);
      if (!record) {
        // Not cached yet: read it in the background (the portfolio checks it's a vault first), for the next chart.
        const key = vault.toLowerCase();
        if (!refreshing.has(key)) {
          refreshing.add(key);
          void portfolioView(ctx, vault)
            .catch(() => {})
            .finally(() => refreshing.delete(key));
        }
        return null;
      }
      return { events: record.events, usdgDecimals: record.usdg?.decimals ?? 6 };
    },
    // Only what "Why it moved" already has: a chart never asks Finnhub or Claude.
    news: (symbol) => ctx.why.summaries.get(symbol)?.value.sources ?? [],
    explorerUrl: ctx.config.EXPLORER_URL,
    now: () => Math.floor(Date.now() / 1000),
    ...ctx.chartOverrides,
  };
  chartDepsByCtx.set(ctx, deps);
  return deps;
}

export async function chartView(ctx: AppContext, symbolParam: string, range: ChartRange, vault?: Address) {
  const stock = stockBySymbol(ctx, symbolParam);
  const source =
    stock.priceSourceKind === "mainnet-mirror" && stock.mainnetFeed
      ? { kind: "mainnet-mirror" as const, feed: stock.mainnetFeed, description: stock.priceSource }
      : stock.priceSourceKind === "public-quote"
        ? { kind: "public-quote" as const, provider: "yahoo-finance", description: stock.priceSource }
        : null;
  return buildChart(
    chartDeps(ctx),
    { symbol: stock.symbol, token: stock.token, tokenDecimals: stock.tokenDecimals, source, ticker: usTicker(stock.symbol) ?? stock.symbol },
    range,
    vault,
  );
}
