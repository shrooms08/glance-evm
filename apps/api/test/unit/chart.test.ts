/**
 * Price charts: walking Chainlink rounds backwards (across a phase boundary), the range cutoff, the round store (a round
 * is never fetched twice, restarts included), the NFLX fallbacks, markers from caches only (never Finnhub or Claude),
 * and the rate limit. A fake feed stands in for the mainnet RPC: no test touches the network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import {
  buildChart,
  HEAD_TTL_MS,
  pointsFor,
  RoundStore,
  roundIdOf,
  walkRounds,
  type ChartDeps,
  type ChartStock,
  type FeedReader,
  type Round,
} from "../../src/chart.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { chartView } from "../../src/services.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const base = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
const FEED = "0x4A1166a659A55625345e9515b32adECea5547C38";
const T = 1_790_000_000; // "now" in these tests
const HOUR = 3_600;

/**
 * A fake proxy: phase 1 has rounds 1..5, phase 2 has rounds 1..3, one every 6 hours, the newest 1 hour ago. Records
 * every round id it's asked for.
 */
function fakeFeed() {
  const rounds = new Map<bigint, Round>();
  const ids = [...[1n, 2n, 3n, 4n, 5n].map((a) => roundIdOf(1, a)), ...[1n, 2n, 3n].map((a) => roundIdOf(2, a))];
  ids.forEach((id, i) => rounds.set(id, { roundId: id, answer: BigInt(300 + i) * 10n ** 8n, updatedAt: T - HOUR - (ids.length - 1 - i) * 6 * HOUR }));
  const asked: bigint[] = [];
  let head = roundIdOf(2, 3n);
  const reader: FeedReader & { asked: bigint[] } = {
    asked,
    decimals: vi.fn(async () => 8),
    latest: vi.fn(async () => rounds.get(head)!),
    rounds: vi.fn(async (want: readonly bigint[]) => {
      asked.push(...want);
      return want.map((id) => rounds.get(id) ?? null);
    }),
    phaseLatest: vi.fn(async (phase: number) => (phase === 1 ? 5n : null)),
  };
  const publish = (answer: bigint, at: number) => {
    head += 1n;
    rounds.set(head, { roundId: head, answer, updatedAt: at });
    return rounds.get(head)!;
  };
  return { reader, rounds, publish, head: () => rounds.get(head)! };
}

describe("walking rounds", () => {
  it("walks back across a phase boundary, through the previous phase's last round, and stops at the first round", async () => {
    const f = fakeFeed();
    const store = new RoundStore(null);
    const got = await walkRounds(f.reader, store, FEED, 0, f.head());
    expect(got.map((r) => [Number(r.roundId >> 64n), Number(r.roundId & 0xffffn)])).toEqual([
      [1, 1], [1, 2], [1, 3], [1, 4], [1, 5],
      [2, 1], [2, 2], [2, 3],
    ]);
    expect(f.reader.phaseLatest).toHaveBeenCalledWith(1);
    expect(store.floor(FEED)).toBe(roundIdOf(1, 1n));
  });

  it("stops at the range start, keeping the round that stood when the range opened", async () => {
    const f = fakeFeed();
    const since = T - 20 * HOUR; // inside phase 2's span: rounds at -13h, -7h, -1h are in; -19h... is the opener
    const got = await walkRounds(f.reader, new RoundStore(null), FEED, since, f.head());
    expect(got.map((r) => T - r.updatedAt)).toEqual([25 * HOUR, 19 * HOUR, 13 * HOUR, 7 * HOUR, HOUR]);
    const points = pointsFor(got, since, 8);
    expect(points[0]).toEqual({ t: since, price: 303, formatted: "$303" }); // the price standing at the start
    expect(points.map((p) => p.t)).toEqual([since, T - 19 * HOUR, T - 13 * HOUR, T - 7 * HOUR, T - HOUR]);
  });

  it("never fetches a stored round again, even after a restart; only rounds newer than the store", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "glance-chart-")), "chart-rounds-4663.json");
    const f = fakeFeed();
    await walkRounds(f.reader, new RoundStore(file), FEED, 0, f.head());
    const firstAsked = [...f.reader.asked];
    expect(firstAsked).toHaveLength(7); // everything below the head

    const newHead = f.publish(310n * 10n ** 8n, T - 60);
    const restarted = new RoundStore(file);
    const again = await walkRounds(f.reader, restarted, FEED, 0, newHead);
    expect(again).toHaveLength(9);
    expect(f.reader.asked.slice(firstAsked.length)).toEqual([]); // the new head came with latestRoundData; nothing re-read
    expect(f.reader.phaseLatest).toHaveBeenCalledTimes(1); // the floor is stored: no phase lookups either
    expect(restarted.get(FEED, newHead.roundId)).toEqual(newHead);
    expect(f.reader.decimals).toHaveBeenCalledTimes(1);
  });

  it("a warm walk reads nothing: every round it needs is in the store", async () => {
    const f = fakeFeed();
    const store = new RoundStore(null);
    const since = T - 20 * HOUR;
    await walkRounds(f.reader, store, FEED, since, f.head());
    const reads = (f.reader.rounds as ReturnType<typeof vi.fn>).mock.calls.length;
    const again = await walkRounds(f.reader, store, FEED, since, f.head());
    expect(again.map((r) => T - r.updatedAt)).toEqual([25 * HOUR, 19 * HOUR, 13 * HOUR, 7 * HOUR, HOUR]);
    expect((f.reader.rounds as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
    // A longer range reuses the rounds the first page already read past its start: still nothing new to read.
    await walkRounds(f.reader, store, FEED, 0, f.head());
    expect((f.reader.rounds as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
  });

  it("stops cleanly where the feed has no earlier round (a missing round)", async () => {
    const f = fakeFeed();
    f.rounds.delete(roundIdOf(2, 1n));
    const got = await walkRounds(f.reader, new RoundStore(null), FEED, 0, f.head());
    expect(got.map((r) => r.roundId)).toEqual([roundIdOf(2, 2n), roundIdOf(2, 3n)]);
  });
});

const TSLA: ChartStock = { symbol: "TSLA", token: base.catalog.bySymbol.get("TSLA")!.token, tokenDecimals: 18, ticker: "TSLA", source: { kind: "mainnet-mirror", feed: FEED, description: "RHTSLA / USD" } };
const NFLX: ChartStock = { symbol: "NFLX", token: base.catalog.bySymbol.get("NFLX")!.token, tokenDecimals: 18, ticker: "NFLX", source: { kind: "public-quote", provider: "yahoo-finance", description: "Yahoo" } };

function deps(over: Partial<ChartDeps> = {}): ChartDeps {
  const f = fakeFeed();
  return {
    reader: () => f.reader,
    store: new RoundStore(null),
    quoteHistory: vi.fn(async () => ({ points: [{ t: T - 2 * HOUR, price: 1200.5 }, { t: T - HOUR, price: 1210 }], detail: "Yahoo Finance NFLX, 5-minute closes" })),
    keeperHistory: vi.fn(async () => [{ t: T - 3 * HOUR, answer: 119_000_000_000n, decimals: 8 }]),
    thresholds: async () => ({ openMaxAge: 2 * HOUR, closedMaxAge: 4 * 86_400 }),
    trades: () => null,
    news: () => [],
    explorerUrl: "https://explorer.example",
    now: () => T,
    ...over,
  };
}

describe("buildChart", () => {
  it("TSLA: Chainlink rounds within the range, with the source, last update and market state", async () => {
    const c = await buildChart(deps(), TSLA, "1D");
    expect(c.points.map((p) => T - p.t)).toEqual([24 * HOUR, 19 * HOUR, 13 * HOUR, 7 * HOUR, HOUR]);
    expect(c.source).toEqual({ label: "Chainlink", detail: `RHTSLA / USD, Robinhood Chain mainnet feed ${FEED}` });
    expect(c).toMatchObject({ symbol: "TSLA", range: "1D", lastUpdated: T - HOUR, asOf: T, marketState: "OPEN", markers: [] });
  });

  it("re-reads the head at most every 15 seconds", async () => {
    let now = T;
    const f = fakeFeed();
    const d = deps({ reader: () => f.reader, now: () => now });
    await buildChart(d, TSLA, "1D");
    await buildChart(d, TSLA, "1W");
    expect(f.reader.latest).toHaveBeenCalledTimes(1);
    now += HEAD_TTL_MS / 1000 + 1;
    await buildChart(d, TSLA, "1D"); // served from the stored head, refreshed behind
    await vi.waitFor(() => expect(f.reader.latest).toHaveBeenCalledTimes(2));
  });

  it("NFLX: the public quote's history, labelled; the keeper's prices with a note when it fails", async () => {
    const quoted = await buildChart(deps(), NFLX, "1D");
    expect(quoted.source).toEqual({ label: "Public quote", detail: "Yahoo Finance NFLX, 5-minute closes" });
    expect(quoted.points).toEqual([
      { t: T - 2 * HOUR, price: 1200.5, formatted: "$1,200.50" },
      { t: T - HOUR, price: 1210, formatted: "$1,210" },
    ]);
    const limited = await buildChart(deps({ quoteHistory: async () => Promise.reject(new Error("Yahoo answered 429")) }), NFLX, "1D");
    expect(limited.source).toMatchObject({ label: "Glance keeper", note: "Limited history: only the prices our keeper has recorded." });
    expect(limited.points).toEqual([{ t: T - 3 * HOUR, price: 1190, formatted: "$1,190" }]);
  });

  it("no history at all: no points, no market state, never an error", async () => {
    const empty = await buildChart(deps({ quoteHistory: async () => Promise.reject(new Error("down")), keeperHistory: async () => [] }), NFLX, "1W");
    expect(empty).toMatchObject({ points: [], lastUpdated: null, marketState: null });
  });
});

describe("markers: from caches only", () => {
  const VAULT = "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113" as Address;
  const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

  it("the vault's buys and sells of this stock, and cached news, within the range", async () => {
    const summarize = vi.fn();
    const companyNews = vi.fn();
    const quote = vi.fn();
    const ctx: AppContext = {
      ...base,
      why: { ...base.why, summarizer: { summarize } as never, news: { companyNews, quote } },
      chartOverrides: { reader: () => fakeFeed().reader, thresholds: async () => null, now: () => T },
    };
    ctx.why.summaries.set("TSLA", {
      symbol: "TSLA",
      move: null,
      summary: null,
      sources: [
        { title: "Tesla deliveries beat", url: "https://news.example/a", site: "Example", publishedAt: new Date((T - 5 * HOUR) * 1000).toISOString() },
        { title: "Old news", url: "https://news.example/b", site: "Example", publishedAt: new Date((T - 9 * 86_400) * 1000).toISOString() },
      ],
      generatedAt: new Date(T * 1000).toISOString(),
    });
    const { portfolioEvents } = await import("../../src/services.js");
    portfolioEvents(ctx).store.set(VAULT, {
      deployBlock: 1n,
      scannedTo: 10n,
      usdg: { address: VAULT, decimals: 6 },
      events: [
        { kind: "buy", token: TSLA.token, usdgIn: 10_000_000n, tokensOut: 25n * 10n ** 15n, block: 2n, logIndex: 0, txHash: tx(1), timestamp: T - 6 * HOUR },
        { kind: "sell", token: TSLA.token, tokensIn: 10n ** 16n, usdgOut: 4_100_000n, block: 3n, logIndex: 0, txHash: tx(2), timestamp: T - 2 * HOUR },
        { kind: "buy", token: base.catalog.bySymbol.get("AMD")!.token, usdgIn: 5_000_000n, tokensOut: 10n ** 16n, block: 4n, logIndex: 0, txHash: tx(3), timestamp: T - HOUR },
      ],
    });
    const c = await chartView(ctx, "TSLA", "1D", VAULT);
    expect(c.markers).toEqual([
      { kind: "news", t: T - 5 * HOUR - 0, title: "Tesla deliveries beat", url: "https://news.example/a", site: "Example" },
      { kind: "buy", t: T - 6 * HOUR, amount: "$10", price: "$400", txHash: tx(1), explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/${tx(1)}` },
      { kind: "sell", t: T - 2 * HOUR, amount: "$4.10", price: "$410", txHash: tx(2), explorerUrl: `https://explorer.testnet.chain.robinhood.com/tx/${tx(2)}` },
    ].sort((a, b) => a.t - b.t));
    // A chart never asks for news or a summary: only what "Why it moved" already has.
    expect(summarize).not.toHaveBeenCalled();
    expect(companyNews).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });
});

describe("GET /chart", () => {
  it("validates the range, and is rate limited per IP (60 a minute by default)", async () => {
    expect(loadConfig({}).CHART_RATE_LIMIT_PER_MINUTE).toBe(60);
    const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "", CHART_RATE_LIMIT_PER_MINUTE: "2" }), () => {});
    ctx.chartOverrides = { reader: () => fakeFeed().reader, thresholds: async () => null, now: () => T };
    const app = createApp(ctx);
    const ok = await app.request("/chart/TSLA?range=1W");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { points: unknown[] }).points.length).toBeGreaterThan(0);
    expect((await app.request("/chart/TSLA?range=5Y")).status).toBe(400);
    const limited = await app.request("/chart/TSLA?range=1D");
    expect(limited.status).toBe(429);
  });
});
