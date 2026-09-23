/**
 * Chain reads and writes behind the HTTP routes: prices, vault state, activity, quotes with an on-chain preflight, and
 * agent trades. Every amount stays a bigint in its token's decimals until it is formatted for display.
 */
import {
  decodeEventLog,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";

import { erc20Abi, glanceVaultAbi, stockDeskAbi, testPriceFeedAbi } from "./abi.generated.js";
import type { CatalogEntry } from "./catalog.js";
import type { AppContext } from "./context.js";
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
    readonly status: 400 | 404 | 409 | 422 | 502 | 503,
    readonly code: string,
    message: string,
    readonly guard?: GuardError,
  ) {
    super(message);
  }
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
}

function classify(age: number, openMaxAge: number, closedMaxAge: number): MarketState {
  if (age <= openMaxAge) return "OPEN";
  if (age <= closedMaxAge) return "CLOSED";
  return "STALE";
}

async function latestTimestamp(ctx: AppContext): Promise<number> {
  const block = await ctx.client.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
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
  const [, , openMaxAge, closedMaxAge] = config;
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
  };
}

export async function priceView(ctx: AppContext, symbol: string, vaultParam?: string) {
  const stock = stockBySymbol(ctx, symbol);
  const vault = vaultParam ? getAddress(vaultParam) : ctx.deployment.demoVaultTestUSDG.address;
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
    priceSource: stock.priceSource,
    priceSourceKind: stock.priceSourceKind,
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
  const timestamps = new Map<bigint, number>();
  const out: DecodedLog[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: glanceVaultAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    // Robinhood Chain's RPC includes blockTimestamp on logs; fall back to a block read if it is missing.
    let timestamp = Number((log as Log & { blockTimestamp?: bigint | Hex }).blockTimestamp ?? 0);
    if (!timestamp && log.blockNumber !== null) {
      const cached = timestamps.get(log.blockNumber);
      timestamp = cached ?? Number((await ctx.client.getBlock({ blockNumber: log.blockNumber })).timestamp);
      timestamps.set(log.blockNumber, timestamp);
    }
    out.push({ eventName: decoded.eventName, args: (decoded.args ?? {}) as Record<string, unknown>, log, timestamp });
  }
  return out;
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
  const latest = await ctx.client.getBlockNumber({ cacheTime: 0 }); // never a cached height: a just-mined trade must be included
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
  const code = await ctx.client.getCode({ address: vault });
  if (!code || code === "0x") throw new ApiError(404, "NOT_A_VAULT", `There's no contract at ${vault}.`);
  const read = <F extends string>(functionName: F) =>
    ctx.client.readContract({ address: vault, abi: glanceVaultAbi, functionName: functionName as never });
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
    throw new ApiError(404, "NOT_A_VAULT", `${vault} isn't a Glance vault.`);
  }
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

  const items = logs.map(({ eventName, args, log, timestamp }) => {
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

  items.sort((a, b) => b.timestamp - a.timestamp || Number(b.blockNumber) - Number(a.blockNumber) || (b.logIndex ?? 0) - (a.logIndex ?? 0));
  return { vault, count: Math.min(limit, items.length), items: items.slice(0, limit) };
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

/** The desk in the deployment that quotes this vault's USDG and that the vault has approved. */
async function deskFor(ctx: AppContext, vault: Address, usdg: Address): Promise<Address> {
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
  const p = await prepare(ctx, req);
  const now = await latestTimestamp(ctx);
  const [price, windows] = await Promise.all([readPrice(ctx, p.stock, p.vault), readWindows(ctx, p.vault, now)]);
  const exCtx = explainContext(ctx, p, req.side, price.state, windows, now);
  const d = p.v.usdgDecimals;

  // Oracle-implied amount, before the desk's spread.
  const oracleOut =
    req.side === "buy"
      ? usdgToTokens(p.amount, d, price.price, price.decimals, p.stock.tokenDecimals)
      : tokenValueInUsdg(p.amount, p.stock.tokenDecimals, price.price, price.decimals, d);

  let deskOut: bigint | null = null;
  let deskError: GuardError | null = null;
  try {
    deskOut = await ctx.client.readContract({
      address: p.desk,
      abi: stockDeskAbi,
      functionName: req.side === "buy" ? "quoteBuy" : "quoteSell",
      args: [p.stock.token, p.amount],
    });
  } catch (err) {
    deskError = explainRevert(decodeRevert(revertDataFromError(err)), exCtx);
  }
  const spreadBps = Number(await ctx.client.readContract({ address: p.desk, abi: stockDeskAbi, functionName: "spreadBps" }));

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
      throw new ApiError(422, quote.preflight.guard.code, quote.preflight.guard.message, quote.preflight.guard);
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
      const guard = explainRevert(decodeRevert(revertDataFromError(err)), exCtx);
      throw new ApiError(422, guard.code, guard.message, guard);
    }
    const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 60_000 });

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

export async function healthView(ctx: AppContext) {
  const [chainId, blockNumber] = await Promise.all([ctx.client.getChainId(), ctx.client.getBlockNumber({ cacheTime: 0 })]);
  const agent = ctx.signer?.account.address ?? ctx.deployment.demoVaultTestUSDG.agent;
  const balance = await ctx.client.getBalance({ address: agent });
  return {
    ok: chainId === ctx.deployment.chainId,
    chainId,
    expectedChainId: ctx.deployment.chainId,
    blockNumber: blockNumber.toString(),
    agent: {
      address: agent,
      keyLoaded: ctx.signer !== null,
      matchesDemoVault: isAddressEqual(agent, ctx.deployment.demoVaultTestUSDG.agent),
      ethBalance: toDecimalString(balance, 18),
      ethBalanceWei: balance.toString(),
    },
    llmFallback: ctx.llm !== null,
    demoVaults: {
      testUSDG: ctx.deployment.demoVaultTestUSDG.address,
      paxosUSDG: ctx.deployment.demoVaultPaxosUSDG?.address ?? null,
    },
  };
}
