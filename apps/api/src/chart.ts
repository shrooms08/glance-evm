/**
 * GET /chart/:symbol?range=1D|1W|1M[&vault=0x…]: the price history behind a stock, for Glance's charts.
 *
 *   TSLA, AMZN, PLTR, AMD   The Chainlink feed each stand-in mirrors, on Robinhood Chain mainnet (RPC_MAINNET_URL),
 *                           read round by round: latestRoundData, then getRoundData backwards until the range start
 *                           (plus the round before it, the price that stood when the range opened). Round ids carry
 *                           the proxy's phase in their top 16 bits: (phaseId << 64) | aggregatorRound. Stepping below
 *                           round 1 of a phase moves to the previous phase's last round (via phaseAggregators), and
 *                           stops cleanly at phase 1. Reads go 100 at a time through Multicall3 (batched JSON-RPC if
 *                           that fails).
 *   NFLX                    No Chainlink feed: the public quote's own history (Yahoo Finance chart), labelled "Public
 *                           quote". If that fails, the prices our keeper has written, with a "limited history" note.
 *
 * Rounds never change, so every round fetched is kept per feed in the gitignored .cache and never fetched again; a
 * warm chart only asks for the head (at most every HEAD_TTL_MS) and any rounds newer than the ones stored.
 *
 * Markers (with ?vault=): that vault's buys and sells of the stock from the portfolio event cache, and news from the
 * "Why it moved" answer cache. Caches only: a chart never calls Finnhub or Claude.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createPublicClient, getAddress, http, parseAbi, type Address, type PublicClient } from "viem";

import { RANGE_SECONDS, type ChartData, type ChartMarker, type ChartPoint, type ChartRange } from "@glance/core/chart";
import { formatUsd, toDecimalString } from "@glance/core/format";

import type { AppContext } from "./context.js";
import type { TradeEvent } from "./portfolio.js";
import { TtlCache } from "./ttlCache.js";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
/** Rounds per read (one Multicall3 call). */
export const PAGE = 100;
/** How often a feed's head (latestRoundData) is re-read. */
export const HEAD_TTL_MS = 15_000;
const PHASE_SHIFT = 64n;
const AGG_MASK = (1n << PHASE_SHIFT) - 1n;

export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function phaseAggregators(uint16 phaseId) view returns (address)",
  "function latestRound() view returns (uint256)",
]);

export interface Round {
  roundId: bigint;
  answer: bigint;
  updatedAt: number;
}

export const phaseOf = (id: bigint) => Number(id >> PHASE_SHIFT);
export const aggRoundOf = (id: bigint) => id & AGG_MASK;
export const roundIdOf = (phase: number, agg: bigint) => (BigInt(phase) << PHASE_SHIFT) | agg;

/** How a feed is read: its head, a batch of rounds (null where a round doesn't exist), a phase's last round. */
export interface FeedReader {
  decimals(): Promise<number>;
  latest(): Promise<Round>;
  rounds(ids: readonly bigint[]): Promise<Array<Round | null>>;
  /** The last aggregator round of `phase` (via the proxy's phaseAggregators), or null if there's none. */
  phaseLatest(phase: number): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The round store (persisted: rounds never change)
// ---------------------------------------------------------------------------------------------------------------------

interface StoredFeed {
  decimals: number;
  /** roundId -> [answer, updatedAt] */
  rounds: Record<string, [string, number]>;
  /** The lowest round reached going back: nothing exists below it (the feed's first round, or a phase we can't cross). */
  floor?: string;
  /** phase -> its last aggregator round: a closed phase never changes, so it's looked up once. */
  phases?: Record<string, string>;
}

export class RoundStore {
  private feeds: Record<string, StoredFeed> = {};

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      this.feeds = (JSON.parse(readFileSync(file, "utf8")) as { feeds?: Record<string, StoredFeed> }).feeds ?? {};
    } catch {
      this.feeds = {};
    }
  }

  private feed(address: string): StoredFeed | undefined {
    return this.feeds[address.toLowerCase()];
  }

  decimals(address: string): number | undefined {
    return this.feed(address)?.decimals;
  }

  get(address: string, id: bigint): Round | undefined {
    const r = this.feed(address)?.rounds[id.toString()];
    return r ? { roundId: id, answer: BigInt(r[0]), updatedAt: r[1] } : undefined;
  }

  floor(address: string): bigint | undefined {
    const f = this.feed(address)?.floor;
    return f === undefined ? undefined : BigInt(f);
  }

  phaseLatest(address: string, phase: number): bigint | undefined {
    const p = this.feed(address)?.phases?.[phase];
    return p === undefined ? undefined : BigInt(p);
  }

  get size(): number {
    return Object.values(this.feeds).reduce((n, f) => n + Object.keys(f.rounds).length, 0);
  }

  save(address: string, decimals: number, rounds: readonly Round[], floor?: bigint, phases: ReadonlyMap<number, bigint | null> = new Map()) {
    const key = address.toLowerCase();
    const f = (this.feeds[key] ??= { decimals, rounds: {} });
    f.decimals = decimals;
    for (const r of rounds) f.rounds[r.roundId.toString()] = [r.answer.toString(), r.updatedAt];
    if (floor !== undefined) f.floor = floor.toString();
    for (const [phase, latest] of phases) if (latest !== null) (f.phases ??= {})[phase] = latest.toString();
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = join(dirname(this.file), `.${Date.now()}-${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify({ feeds: this.feeds }));
      renameSync(tmp, this.file);
    } catch {
      // best effort: memory still holds them
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Walking rounds backwards
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Every round from the head back to the first one published before `since` (the price that stood at the range's
 * start), oldest first. Stored rounds are reused, never re-read; missing ones are read PAGE at a time. Crosses phase
 * boundaries through the proxy's previous phase; stops cleanly where no earlier round exists.
 */
export async function walkRounds(reader: FeedReader, store: RoundStore, feed: string, since: number, head: Round): Promise<Round[]> {
  const decimals = store.decimals(feed) ?? (await reader.decimals());
  const floor = store.floor(feed);
  const out: Round[] = [head];
  const fresh: Round[] = store.get(feed, head.roundId) ? [] : [head];
  let cursor: bigint | null = head.roundId;
  let reachedFloor: bigint | undefined;
  const phaseLatest = new Map<number, bigint | null>();

  /** The round id just below `id`, or null at the beginning (with the previous phase's head looked up if needed). */
  const below = async (id: bigint): Promise<bigint | null> => {
    if (floor !== undefined && id <= floor) return null;
    const agg = aggRoundOf(id);
    if (agg > 1n) return id - 1n;
    const phase = phaseOf(id);
    if (phase <= 1) return null;
    const stored = store.phaseLatest(feed, phase - 1);
    if (stored !== undefined) return roundIdOf(phase - 1, stored);
    if (!phaseLatest.has(phase - 1)) phaseLatest.set(phase - 1, await reader.phaseLatest(phase - 1).catch(() => null));
    const prev = phaseLatest.get(phase - 1);
    return prev ? roundIdOf(phase - 1, prev) : null;
  };

  // Step down one round at a time through the store (no reads); at the first round the store doesn't have, read a
  // page of up to PAGE missing rounds in one batch, and carry on.
  walk: while (cursor !== null && out.at(-1)!.updatedAt >= since) {
    const next = await below(cursor);
    if (next === null) {
      reachedFloor = cursor;
      break;
    }
    const stored = store.get(feed, next);
    if (stored) {
      out.push(stored);
      cursor = next;
      continue;
    }
    const ids = [next];
    for (let id: bigint | null = next; ids.length < PAGE; ) {
      id = await below(id);
      if (id === null || store.get(feed, id)) break;
      ids.push(id);
    }
    const read = await reader.rounds(ids);
    let done = false;
    let lastValid = cursor;
    for (const [n, id] of ids.entries()) {
      const r = read[n] ?? null;
      if (!r || r.updatedAt === 0) {
        // No such round: this is as far back as the feed goes.
        reachedFloor = lastValid;
        break walk;
      }
      fresh.push(r); // kept even past the range start: already paid for, and the next longer range needs it
      lastValid = id;
      if (done) continue;
      out.push(r);
      cursor = id;
      if (r.updatedAt < since) done = true;
    }
    if (done) break;
  }
  if (fresh.length || reachedFloor !== undefined || phaseLatest.size) store.save(feed, decimals, fresh, reachedFloor, phaseLatest);
  return out.reverse();
}

/** The points for a range: the price standing at the start (clamped to it), then every round inside the range. */
export function pointsFor(rounds: readonly Round[], since: number, decimals: number): ChartPoint[] {
  const point = (t: number, answer: bigint): ChartPoint => ({ t, price: Number(toDecimalString(answer, decimals)), formatted: formatUsd(answer, decimals) });
  const inside = rounds.filter((r) => r.updatedAt >= since && r.answer > 0n);
  const before = [...rounds].reverse().find((r) => r.updatedAt < since && r.answer > 0n);
  const out = before ? [point(since, before.answer)] : [];
  for (const r of inside) out.push(point(r.updatedAt, r.answer));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------------------------------

/** A mainnet Chainlink proxy, read through Multicall3 (batched JSON-RPC when that fails). */
export function chainlinkReader(client: PublicClient, feed: Address): FeedReader {
  const one = (roundId: bigint) =>
    client.readContract({ address: feed, abi: aggregatorAbi, functionName: "getRoundData", args: [roundId] }).then(
      (r): Round => ({ roundId, answer: r[1], updatedAt: Number(r[3]) }),
      () => null,
    );
  return {
    decimals: () => client.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }),
    async latest() {
      const r = await client.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" });
      return { roundId: r[0], answer: r[1], updatedAt: Number(r[3]) };
    },
    async rounds(ids) {
      try {
        const res = await client.multicall({
          multicallAddress: MULTICALL3,
          allowFailure: true,
          contracts: ids.map((roundId) => ({ address: feed, abi: aggregatorAbi, functionName: "getRoundData" as const, args: [roundId] as const })),
        });
        return res.map((r, i) => (r.status === "success" ? { roundId: ids[i]!, answer: r.result[1], updatedAt: Number(r.result[3]) } : null));
      } catch {
        return Promise.all(ids.map(one));
      }
    },
    async phaseLatest(phase) {
      const agg = await client.readContract({ address: feed, abi: aggregatorAbi, functionName: "phaseAggregators", args: [phase] });
      if (/^0x0+$/.test(agg)) return null;
      const latest = await client.readContract({ address: agg, abi: aggregatorAbi, functionName: "latestRound" });
      return latest > 0n ? latest : null;
    },
  };
}

export interface QuoteHistory {
  points: Array<{ t: number; price: number }>;
  detail: string;
  /** The company's name, as the source gives it ("NVIDIA Corporation"). */
  name?: string;
}

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_PARAMS: Record<ChartRange, { range: string; interval: string; label: string }> = {
  "1D": { range: "1d", interval: "5m", label: "5-minute" },
  "1W": { range: "5d", interval: "30m", label: "30-minute" },
  "1M": { range: "1mo", interval: "1h", label: "hourly" },
  "3M": { range: "3mo", interval: "1d", label: "daily" },
  "6M": { range: "6mo", interval: "1d", label: "daily" },
  YTD: { range: "ytd", interval: "1d", label: "daily" },
  "1Y": { range: "1y", interval: "1d", label: "daily" },
  "5Y": { range: "5y", interval: "1wk", label: "weekly" },
  "10Y": { range: "10y", interval: "1mo", label: "monthly" },
  ALL: { range: "max", interval: "1mo", label: "monthly" },
};

/**
 * Finer candles for fitting a page's chart, which may draw every minute (Yahoo's own 1 day chart does): 5-minute
 * closes smooth away the day's extremes the page shows. Only the short ranges have a finer step.
 */
const YAHOO_FINE: Partial<Record<ChartRange, { range: string; interval: string; label: string }>> = {
  "1D": { range: "1d", interval: "1m", label: "1-minute" },
  "1W": { range: "5d", interval: "15m", label: "15-minute" },
  "1M": { range: "1mo", interval: "30m", label: "30-minute" },
};

/** The public quote's own history (Yahoo Finance's chart endpoint, the same source the keeper quotes from). */
/** Which candles: `fine` a finer step (short ranges), `prepost` the pre- and after-market too (a page showing them). */
export interface CandleOptions {
  fine?: boolean;
  prepost?: boolean;
}

export async function yahooHistory(ticker: string, range: ChartRange, doFetch: typeof fetch = fetch, opts: CandleOptions = {}): Promise<QuoteHistory> {
  const p = (opts.fine ? YAHOO_FINE[range] : undefined) ?? YAHOO_PARAMS[range];
  const res = await doFetch(`${YAHOO}/${encodeURIComponent(ticker)}?range=${p.range}&interval=${p.interval}${opts.prepost ? "&includePrePost=true" : ""}`, {
    headers: { "user-agent": "Mozilla/5.0 (Glance price chart)", accept: "application/json" },
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`Yahoo answered ${res.status}`);
  const body = (await res.json()) as {
    chart?: { result?: Array<{ meta?: { shortName?: string; longName?: string }; timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> };
  };
  const r = body.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const close = r?.indicators?.quote?.[0]?.close ?? [];
  const points = ts.flatMap((t, i) => (typeof close[i] === "number" && close[i]! > 0 ? [{ t, price: close[i]! }] : []));
  if (points.length === 0) throw new Error("Yahoo: no history");
  const name = r?.meta?.longName || r?.meta?.shortName;
  return { points, detail: `Yahoo Finance ${ticker}, ${p.label} closes${opts.prepost ? " (with pre- and after-market)" : ""}`, ...(name ? { name } : {}) };
}

/** The label a chart's source goes by when its prices are the market's own candles (any US stock, any range). */
export const MARKET_SOURCE = "Yahoo Finance";

/**
 * A chart of the market's own prices: for a stock outside the catalog, or a range longer than Glance's Chainlink
 * history (a page's "6 months"). Candles from Yahoo Finance's public chart endpoint, cached per ticker and range.
 */
export function marketChartData(symbol: string, range: ChartRange, h: QuoteHistory, asOf: number, name?: string): ChartData {
  const points = h.points.map((p) => ({ t: p.t, price: p.price, formatted: formatUsd(BigInt(Math.round(p.price * 100)), 2) }));
  return {
    symbol,
    name: name ?? h.name ?? symbol,
    range,
    points,
    source: { label: MARKET_SOURCE, detail: h.detail, note: "Market prices, for explaining the chart. Glance trades only on Chainlink prices." },
    lastUpdated: points.at(-1)?.t ?? null,
    asOf,
    marketState: null,
    markers: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------------------------------

export interface ChartDeps {
  /** A reader per mainnet feed. */
  reader(feed: Address): FeedReader;
  store: RoundStore;
  quoteHistory(ticker: string, range: ChartRange, opts?: CandleOptions): Promise<QuoteHistory>;
  /** The prices our keeper wrote to the testnet stand-in feed, when there's no other history. */
  keeperHistory(symbol: string, since: number): Promise<Array<{ t: number; answer: bigint; decimals: number }>>;
  /** The vault's freshness thresholds for the stock (to classify the market as the vault would), or null. */
  thresholds(symbol: string): Promise<{ openMaxAge: number; closedMaxAge: number } | null>;
  /** Cached trade events for a vault (null when none are cached yet) and its USDG decimals. */
  trades(vault: Address): { events: TradeEvent[]; usdgDecimals: number } | null;
  /** Cached "why it moved" sources for a symbol (never fetched here). */
  news(symbol: string): Array<{ title: string; url: string; site: string; publishedAt: string }>;
  explorerUrl: string;
  now(): number; // unix seconds
}

/** Past this age a cached head is refreshed before answering; younger than it, it's served and refreshed behind. */
export const HEAD_MAX_STALE_MS = 5 * 60 * 1000;

const heads = new WeakMap<ChartDeps, Map<string, { at: number; head: Promise<Round>; settled: boolean; refreshing?: boolean }>>();

/**
 * The feed's head: re-read at most every HEAD_TTL_MS. Between HEAD_TTL_MS and HEAD_MAX_STALE_MS old, the stored head
 * answers at once and a fresh one is read in the background (Chainlink publishes minutes to hours apart, so a few
 * seconds' staleness costs nothing, and a warm chart never waits on the mainnet RPC).
 */
function headOf(deps: ChartDeps, feed: Address): Promise<Round> {
  let m = heads.get(deps);
  if (!m) heads.set(deps, (m = new Map()));
  const nowMs = deps.now() * 1000;
  const hit = m.get(feed);
  const read = () => {
    const entry: { at: number; head: Promise<Round>; settled: boolean; refreshing?: boolean } = { at: nowMs, head: deps.reader(feed).latest(), settled: false };
    entry.head.then(
      () => (entry.settled = true),
      () => {
        if (m.get(feed) === entry) m.delete(feed);
      },
    );
    return entry;
  };
  if (hit && nowMs - hit.at < HEAD_TTL_MS) return hit.head;
  if (hit?.settled && nowMs - hit.at < HEAD_MAX_STALE_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      const next = read();
      next.head.then(
        () => m.set(feed, next),
        () => (hit.refreshing = false),
      );
    }
    return hit.head;
  }
  const entry = read();
  m.set(feed, entry);
  return entry.head;
}

function classify(age: number, t: { openMaxAge: number; closedMaxAge: number } | null): ChartData["marketState"] {
  if (!t) return null;
  return age <= t.openMaxAge ? "OPEN" : age <= t.closedMaxAge ? "CLOSED" : "STALE";
}

export interface ChartStock {
  symbol: string;
  token: Address;
  tokenDecimals: number;
  source: { kind: "mainnet-mirror"; feed: string; description: string } | { kind: "public-quote"; provider: string; description: string } | null;
  ticker: string;
}

export async function buildChart(deps: ChartDeps, stock: ChartStock, range: ChartRange, vault?: Address): Promise<ChartData> {
  const asOf = deps.now();
  const since = asOf - RANGE_SECONDS[range];
  const thresholdsP = deps.thresholds(stock.symbol).catch(() => null);
  let points: ChartPoint[] = [];
  let source: ChartData["source"];
  let lastUpdated: number | null = null;

  if (stock.source?.kind === "mainnet-mirror") {
    const feed = getAddress(stock.source.feed);
    const reader = deps.reader(feed);
    const head = await headOf(deps, feed);
    const rounds = await walkRounds(reader, deps.store, feed, since, head);
    const decimals = deps.store.decimals(feed) ?? (await reader.decimals());
    points = pointsFor(rounds, since, decimals);
    lastUpdated = head.updatedAt;
    source = { label: "Chainlink", detail: `${stock.source.description}, Robinhood Chain mainnet feed ${feed}` };
  } else {
    try {
      const h = await deps.quoteHistory(stock.ticker, range);
      const inRange = h.points.filter((p) => p.t >= since);
      points = (inRange.length >= 2 ? inRange : h.points).map((p) => ({ t: p.t, price: p.price, formatted: formatUsd(BigInt(Math.round(p.price * 100)), 2) }));
      lastUpdated = points.at(-1)?.t ?? null;
      source = { label: "Public quote", detail: h.detail };
    } catch {
      const written = await deps.keeperHistory(stock.symbol, since).catch(() => []);
      points = written.map((w) => ({ t: w.t, price: Number(toDecimalString(w.answer, w.decimals)), formatted: formatUsd(w.answer, w.decimals) }));
      lastUpdated = points.at(-1)?.t ?? null;
      source = { label: "Glance keeper", detail: "The prices our keeper wrote to the testnet feed", note: "Limited history: only the prices our keeper has recorded." };
    }
  }

  const thresholds = await thresholdsP;
  const marketState = lastUpdated === null ? null : classify(asOf - lastUpdated, thresholds);
  return { symbol: stock.symbol, range, points, source, lastUpdated, asOf, marketState, markers: markersFor(deps, stock, since, asOf, vault) };
}

/** Trade and news markers from the caches only. */
export function markersFor(deps: Pick<ChartDeps, "trades" | "news" | "explorerUrl">, stock: Pick<ChartStock, "symbol" | "token" | "tokenDecimals">, since: number, until: number, vault?: Address): ChartMarker[] {
  const out: ChartMarker[] = [];
  if (vault) {
    const cached = deps.trades(vault);
    const d = cached?.usdgDecimals ?? 6;
    for (const e of cached?.events ?? []) {
      if (e.kind === "withdraw" || e.token.toLowerCase() !== stock.token.toLowerCase() || e.timestamp < since || e.timestamp > until) continue;
      const usdg = e.kind === "buy" ? e.usdgIn : e.usdgOut;
      const shares = e.kind === "buy" ? e.tokensOut : e.tokensIn;
      const perShare = shares > 0n ? (usdg * 10n ** BigInt(stock.tokenDecimals)) / shares : 0n;
      out.push({
        kind: e.kind,
        t: e.timestamp,
        amount: formatUsd(usdg, d),
        price: formatUsd(perShare, d),
        txHash: e.txHash,
        explorerUrl: deps.explorerUrl ? `${deps.explorerUrl.replace(/\/$/, "")}/tx/${e.txHash}` : null,
      });
    }
  }
  for (const n of deps.news(stock.symbol)) {
    const t = Math.floor(Date.parse(n.publishedAt) / 1000);
    if (Number.isFinite(t) && t >= since && t <= until) out.push({ kind: "news", t, title: n.title, url: n.url, site: n.site });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------------------

export function mainnetClient(url: string): PublicClient {
  return createPublicClient({ transport: http(url, { batch: { batchSize: 100 }, retryCount: 2, timeout: 10_000 }) }) as PublicClient;
}

export function roundStoreFile(ctx: Pick<AppContext, "cacheDir">): string | null {
  return ctx.cacheDir ? join(ctx.cacheDir, "chart-rounds-4663.json") : null;
}

export function quoteCacheFile(ctx: Pick<AppContext, "cacheDir">): string | null {
  return ctx.cacheDir ? join(ctx.cacheDir, "chart-quotes.json") : null;
}

/** Yahoo history, cached 5 minutes (it's an intraday series; the chart doesn't need it fresher). */
export function cachedQuoteHistory(cache: TtlCache<QuoteHistory>, doFetch?: typeof fetch) {
  return async (ticker: string, range: ChartRange, opts: CandleOptions = {}) => {
    const key = `${ticker}:${range}${opts.fine ? ":fine" : ""}${opts.prepost ? ":prepost" : ""}`;
    const hit = cache.get(key);
    if (hit) return hit.value;
    const h = await yahooHistory(ticker, range, doFetch, opts);
    cache.set(key, h);
    return h;
  };
}
