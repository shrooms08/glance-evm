/**
 * GET /portfolio/:vault: what the vault holds, what it paid, and how it's doing.
 *
 * Cost basis comes from the vault's own trade events, average-cost method, all in bigint (USDG has 6 decimals, the
 * stocks 18; nothing goes through floating point):
 *   Bought(token, router, usdgIn, tokensOut, ...)     qty += tokensOut; cost += usdgIn
 *   Sold(token, router, tokensIn, usdgOut, ...)       cost out = cost x tokensIn / qty (rounded down; all of it on a
 *                                                     full sale); realized += usdgOut - cost out; qty -= tokensIn
 *   Withdrawn(token, amount), a stock                 the owner took shares out: qty and cost shrink the same way, no
 *                                                     realized PnL (nothing was sold)
 *   anything the vault holds beyond that              arrived outside a trade: counted at zero cost, flagged
 *                                                     transferredIn
 * Prices are the vault's own oracle feeds, as for every other Glance number.
 *
 * Events are cached per vault and read incrementally: from the vault's deploy block the first time, then only the
 * blocks since the last read. The cache is persisted (PortfolioStore, under the gitignored .cache dir), with the
 * vault's deploy block and its immutable USDG address and decimals, so a restart doesn't pay for the first read again.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAddress, type Address, type Hex } from "viem";

import { formatSignedPercent, formatSignedUsd, formatUsd, signedBps, tokenValueInUsdg } from "@glance/core/format";
import { EMPTY_PORTFOLIO, upDown } from "@glance/core/tone";

import type { AppContext } from "./context.js";
import { formatDuration, formatQuantity, toDecimalString } from "./format.js";

// ---------------------------------------------------------------------------------------------------------------------
// The average-cost engine (pure)
// ---------------------------------------------------------------------------------------------------------------------

export type TradeEvent =
  | { kind: "buy"; token: Address; usdgIn: bigint; tokensOut: bigint; block: bigint; logIndex: number; txHash: Hex; timestamp: number }
  | { kind: "sell"; token: Address; tokensIn: bigint; usdgOut: bigint; block: bigint; logIndex: number; txHash: Hex; timestamp: number }
  | { kind: "withdraw"; token: Address; amount: bigint; block: bigint; logIndex: number; txHash: Hex; timestamp: number };

export interface Holding {
  /** Shares held according to the vault's events. */
  qty: bigint;
  /** USDG paid for the shares still held (raw, 6 decimals). */
  costBasis: bigint;
  /** USDG gained (or lost) on shares sold. */
  realizedPnl: bigint;
  lastBuy: { txHash: Hex; timestamp: number } | null;
}

const empty = (): Holding => ({ qty: 0n, costBasis: 0n, realizedPnl: 0n, lastBuy: null });

/** Cost to take out when `out` of `h.qty` shares leave: proportional, rounded down, and all of it when they all go. */
function costOut(h: Holding, out: bigint): bigint {
  if (h.qty === 0n) return 0n;
  if (out >= h.qty) return h.costBasis;
  return (h.costBasis * out) / h.qty;
}

/** Replays the vault's trade events, oldest first, into one holding per token (keys are lowercase addresses). */
export function replay(events: readonly TradeEvent[]): Map<string, Holding> {
  const sorted = [...events].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const out = new Map<string, Holding>();
  for (const e of sorted) {
    const key = e.token.toLowerCase();
    const h = out.get(key) ?? empty();
    if (e.kind === "buy") {
      h.qty += e.tokensOut;
      h.costBasis += e.usdgIn;
      h.lastBuy = { txHash: e.txHash, timestamp: e.timestamp };
    } else {
      const shares = e.kind === "sell" ? e.tokensIn : e.amount;
      const cost = costOut(h, shares);
      if (e.kind === "sell") h.realizedPnl += e.usdgOut - cost;
      h.costBasis -= cost;
      h.qty = shares >= h.qty ? 0n : h.qty - shares;
    }
    out.set(key, h);
  }
  return out;
}

/**
 * Brings a holding in line with what the vault actually holds. More than the events explain arrived outside a trade:
 * it's added at zero cost and reported as transferredIn. (Less can't happen through the vault's own functions; if a
 * lagging read shows it, quantity and cost shrink proportionally.)
 */
export function reconcile(h: Holding, balance: bigint): Holding & { transferredIn: bigint } {
  if (balance >= h.qty) return { ...h, qty: balance, transferredIn: balance - h.qty };
  const cost = costOut(h, h.qty - balance);
  return { ...h, qty: balance, costBasis: h.costBasis - cost, transferredIn: 0n };
}

/** Average cost of one whole share, in raw USDG (rounded down); 0 with nothing held. */
export function averageCost(h: Pick<Holding, "qty" | "costBasis">, tokenDecimals: number): bigint {
  return h.qty === 0n ? 0n : (h.costBasis * 10n ** BigInt(tokenDecimals)) / h.qty;
}

// ---------------------------------------------------------------------------------------------------------------------
// Incremental event cache
// ---------------------------------------------------------------------------------------------------------------------

export interface EventSource {
  latestBlock(): Promise<bigint>;
  /** The first block the vault's code exists at (or a safe lower bound). */
  deployBlock(vault: Address, latest: bigint): Promise<bigint>;
  /** The vault's trade events in [from, to]. */
  events(vault: Address, from: bigint, to: bigint): Promise<TradeEvent[]>;
  /**
   * Optional: the vault's trade events from `from` up to the chain head, with the head, in one round trip (the head and
   * the logs in one batch). Used for a vault already read once; may throw (e.g. a range too long), and then `events`
   * is used instead.
   */
  since?(vault: Address, from: bigint): Promise<{ to: bigint; events: TradeEvent[] }>;
}

/** What's kept per vault: where it starts, how far it's been read, its trades, and its (immutable) USDG. */
export interface VaultRecord {
  deployBlock: bigint;
  scannedTo: bigint;
  events: TradeEvent[];
  usdg?: { address: Address; decimals: number };
}

/**
 * The persisted side of the event cache: one JSON file (bigints as strings), rewritten atomically after each change.
 * Memory only when `file` is null (tests).
 */
export class PortfolioStore {
  private vaults: Record<string, VaultRecord> = {};

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"), (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as { vaults?: Record<string, VaultRecord> };
      this.vaults = saved.vaults ?? {};
    } catch {
      this.vaults = {};
    }
  }

  get(vault: Address): VaultRecord | undefined {
    return this.vaults[vault.toLowerCase()];
  }

  set(vault: Address, record: VaultRecord) {
    this.vaults[vault.toLowerCase()] = record;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = join(dirname(this.file), `.${Date.now()}-${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify({ vaults: this.vaults }, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
      renameSync(tmp, this.file);
    } catch {
      // best effort: memory still holds it
    }
  }
}

/** Per vault: its deploy block, the last block read, and every trade event so far. Reads only what's new. */
export class VaultEventCache {
  private inflight = new Map<string, Promise<TradeEvent[]>>();

  constructor(
    private readonly source: EventSource,
    readonly store: PortfolioStore = new PortfolioStore(null),
  ) {}

  async get(vault: Address): Promise<TradeEvent[]> {
    const key = vault.toLowerCase();
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.refresh(vault).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refresh(vault: Address): Promise<TradeEvent[]> {
    const known = this.store.get(vault);
    if (known && this.source.since) {
      try {
        const { to, events: fresh } = await this.source.since(vault, known.scannedTo + 1n);
        if (to <= known.scannedTo) return known.events; // no block since the last read
        const events = [...known.events, ...fresh];
        this.store.set(vault, { ...this.store.get(vault)!, scannedTo: to, events });
        return events;
      } catch {
        // fall back to the chunked read below
      }
    }
    const latest = await this.source.latestBlock();
    const deployBlock = known?.deployBlock ?? (await this.source.deployBlock(vault, latest));
    const from = known ? known.scannedTo + 1n : deployBlock;
    if (from > latest) {
      if (!known) this.store.set(vault, { deployBlock, scannedTo: deployBlock - 1n, events: [] });
      return known?.events ?? [];
    }
    const fresh = await this.source.events(vault, from, latest);
    const events = [...(known?.events ?? []), ...fresh];
    // Merged with what's stored now (the vault's USDG may have been saved while this read ran).
    this.store.set(vault, { ...this.store.get(vault), deployBlock, scannedTo: latest, events });
    return events;
  }
}

/**
 * The block a vault was deployed in, by a search on its code (so a vault created long after the deployment is read from
 * its own first block). Each round probes `fanout` blocks at once (one RPC batch), narrowing the range `fanout + 1`
 * times per round trip: about 5 round trips for 400k blocks instead of 19. Falls back to `floor` if the RPC can't
 * answer for past blocks.
 */
export async function findDeployBlock(getCode: (block: bigint) => Promise<Hex | undefined>, floor: bigint, latest: bigint, fanout = 16): Promise<bigint> {
  const has = async (b: bigint) => {
    const code = await getCode(b);
    return Boolean(code && code !== "0x");
  };
  try {
    let lo = floor;
    let hi = latest;
    const [atLo, atHi] = await Promise.all([has(lo), has(hi)]);
    if (!atHi) return floor;
    if (atLo) return lo;
    // Invariant: no code at lo, code at hi.
    while (hi - lo > 1n) {
      const span = hi - lo;
      const n = BigInt(fanout) < span - 1n ? BigInt(fanout) : span - 1n;
      const probes = Array.from({ length: Number(n) }, (_, i) => lo + (span * BigInt(i + 1)) / (n + 1n));
      const found = await Promise.all(probes.map(has));
      const firstWith = found.indexOf(true);
      if (firstWith === -1) lo = probes.at(-1)!;
      else {
        hi = probes[firstWith]!;
        if (firstWith > 0) lo = probes[firstWith - 1]!;
      }
    }
    return hi;
  } catch {
    return floor;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------------------------------

const money = (raw: bigint, decimals: number) => ({ raw: raw.toString(), value: toDecimalString(raw, decimals), formatted: formatUsd(raw, decimals) });
const signed = (raw: bigint, decimals: number) => ({ raw: raw.toString(), value: toDecimalString(raw, decimals), formatted: formatSignedUsd(raw, decimals) });
const shares = (raw: bigint, decimals: number, symbol: string) => ({ raw: raw.toString(), value: toDecimalString(raw, decimals), formatted: formatQuantity(raw, decimals, symbol) });

export interface PortfolioDeps {
  readVault(vault: Address): Promise<{ usdg: Address; usdgDecimals: number }>;
  readPrice(symbol: string, vault: Address): Promise<{ price: bigint; decimals: number; ageSeconds: number; state: "OPEN" | "CLOSED" | "STALE" }>;
  balanceOf(token: Address, holder: Address): Promise<bigint>;
  events: VaultEventCache;
  now(): Promise<number>;
}

export async function buildPortfolio(deps: PortfolioDeps, ctx: Pick<AppContext, "catalog">, vaultParam: string) {
  const vault = getAddress(vaultParam);
  // One parallel wave: the vault (its USDG is immutable, so it comes from the store once known), its events, the time,
  // and every stock's balance and price. Only the USDG balance waits for the vault's USDG address.
  const vaultP = deps.readVault(vault);
  const stocksP = Promise.all(ctx.catalog.entries.map((stock) => Promise.all([deps.balanceOf(stock.token, vault), deps.readPrice(stock.symbol, vault)])));
  let v: Awaited<typeof vaultP>, events: TradeEvent[], usdgBalance: bigint, now: number, stockReads: Awaited<typeof stocksP>;
  try {
    [v, events, usdgBalance, now, stockReads] = await Promise.all([
      vaultP,
      // After the vault check, so an address that isn't a vault never starts a scan (or lands in the store).
      vaultP.then(() => deps.events.get(vault)),
      vaultP.then((x) => deps.balanceOf(x.usdg, vault)),
      deps.now(),
      stocksP,
    ]);
  } catch (err) {
    await vaultP; // 404 NOT_A_VAULT / 503 RPC_UNAVAILABLE come from here, as for /vault, whichever read failed first
    throw err;
  }
  const d = v.usdgDecimals;
  const holdings = replay(events);

  const rows = await Promise.all(
    ctx.catalog.entries.map(async (stock, i) => {
      const [balance, price] = stockReads[i]!;
      const h = reconcile(holdings.get(stock.token.toLowerCase()) ?? empty(), balance);
      const value = tokenValueInUsdg(h.qty, stock.tokenDecimals, price.price, price.decimals, d);
      const unrealized = value - h.costBasis;
      return {
        held: h.qty > 0n,
        realized: h.realizedPnl,
        cost: h.costBasis,
        value,
        unrealized,
        position: {
          symbol: stock.symbol,
          name: stock.name,
          token: stock.token,
          qty: shares(h.qty, stock.tokenDecimals, stock.symbol),
          avgCost: money(averageCost(h, stock.tokenDecimals), d),
          costBasis: money(h.costBasis, d),
          price: { raw: price.price.toString(), decimals: price.decimals, value: toDecimalString(price.price, price.decimals), formatted: formatUsd((price.price * 10n ** BigInt(d)) / 10n ** BigInt(price.decimals), d) },
          priceAge: { seconds: price.ageSeconds, text: formatDuration(price.ageSeconds) },
          marketState: price.state,
          value: money(value, d),
          unrealizedPnl: signed(unrealized, d),
          unrealizedPnlPct: formatSignedPercent(unrealized, h.costBasis),
          unrealizedPnlBps: signedBps(unrealized, h.costBasis),
          realizedPnl: signed(h.realizedPnl, d),
          transferredIn: h.transferredIn > 0n ? shares(h.transferredIn, stock.tokenDecimals, stock.symbol) : null,
          lastBuy: h.lastBuy,
        },
      };
    }),
  );

  const held = rows.filter((r) => r.held);
  const stocksValue = held.reduce((s, r) => s + r.value, 0n);
  const costBasis = held.reduce((s, r) => s + r.cost, 0n);
  const unrealizedPnl = held.reduce((s, r) => s + r.unrealized, 0n);
  const realizedPnl = rows.reduce((s, r) => s + r.realized, 0n);
  const totals = {
    value: money(usdgBalance + stocksValue, d),
    stocksValue: money(stocksValue, d),
    costBasis: money(costBasis, d),
    unrealizedPnl: signed(unrealizedPnl, d),
    unrealizedPnlPct: formatSignedPercent(unrealizedPnl, costBasis),
    realizedPnl: signed(realizedPnl, d),
  };
  return {
    vault,
    usdg: { address: v.usdg, ...money(usdgBalance, d) },
    positions: held.map((r) => r.position),
    totals,
    sentence: portfolioSentence(held.length, stocksValue, usdgBalance, unrealizedPnl + realizedPnl, d),
    asOf: now,
  };
}

/** One spoken sentence, plain and without advice: "You hold $62 across 2 stocks, up $1.40 overall." */
export function portfolioSentence(stocks: number, stocksValue: bigint, usdg: bigint, overall: bigint, decimals: number): string {
  if (stocks === 0) return `${EMPTY_PORTFOLIO} You have ${formatUsd(usdg, decimals)} to trade with.`;
  const across = `${formatUsd(stocksValue, decimals)} across ${stocks} ${stocks === 1 ? "stock" : "stocks"}`;
  return `You hold ${across}, ${upDown(overall, (x) => formatUsd(x, decimals))} overall.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Wiring to the chain
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Turns the vault's decoded logs into trade events: Bought, Sold and Withdrawn. (A USDG withdrawal lands under the USDG
 * key, which positions never read: only the stock tokens are looked up.)
 */
export function toTradeEvents(
  logs: ReadonlyArray<{ eventName: string; args: Record<string, unknown>; log: { blockNumber: bigint | null; logIndex: number | null; transactionHash: Hex | null }; timestamp: number }>,
): TradeEvent[] {
  const out: TradeEvent[] = [];
  for (const { eventName, args, log, timestamp } of logs) {
    const base = { block: log.blockNumber ?? 0n, logIndex: log.logIndex ?? 0, txHash: (log.transactionHash ?? "0x") as Hex, timestamp };
    if (eventName === "Bought") out.push({ kind: "buy", token: args.token as Address, usdgIn: args.usdgIn as bigint, tokensOut: args.tokensOut as bigint, ...base });
    else if (eventName === "Sold") out.push({ kind: "sell", token: args.token as Address, tokensIn: args.tokensIn as bigint, usdgOut: args.usdgOut as bigint, ...base });
    else if (eventName === "Withdrawn") out.push({ kind: "withdraw", token: args.token as Address, amount: args.amount as bigint, ...base });
  }
  return out;
}

