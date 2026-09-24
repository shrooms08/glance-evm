/**
 * Portfolio: average cost from the vault's own trade events, in bigint; transfers in at zero cost; an incremental event
 * cache; and the same 503 / 404 split as /vault.
 */
import { resolve } from "node:path";

import { ContractFunctionZeroDataError, HttpRequestError, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { averageCost, buildPortfolio, findDeployBlock, portfolioSentence, reconcile, replay, VaultEventCache, type EventSource, type TradeEvent } from "../../src/portfolio.js";
import { RPC_TROUBLE_MESSAGE } from "../../src/rpc.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
const TSLA = ctx.catalog.bySymbol.get("TSLA")!.token;
const AMD = ctx.catalog.bySymbol.get("AMD")!.token;
const VAULT = "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113" as Address;
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F" as Address;
const E18 = 10n ** 18n;
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

let n = 0;
const buy = (usdgIn: bigint, tokensOut: bigint, token: Address = TSLA): TradeEvent => ({ kind: "buy", token, usdgIn, tokensOut, block: BigInt(++n), logIndex: 0, txHash: TX(n), timestamp: 1_000 + n });
const sell = (tokensIn: bigint, usdgOut: bigint, token: Address = TSLA): TradeEvent => ({ kind: "sell", token, tokensIn, usdgOut, block: BigInt(++n), logIndex: 0, txHash: TX(n), timestamp: 1_000 + n });
const withdraw = (amount: bigint, token: Address = TSLA): TradeEvent => ({ kind: "withdraw", token, amount, block: BigInt(++n), logIndex: 0, txHash: TX(n), timestamp: 1_000 + n });

describe("average cost", () => {
  it("buys add quantity and cost; the average is cost per whole share", () => {
    const h = replay([buy(10_000_000n, E18 / 40n), buy(30_000_000n, E18 / 10n)]).get(TSLA.toLowerCase())!;
    expect(h.qty).toBe(E18 / 40n + E18 / 10n); // 0.125 TSLA
    expect(h.costBasis).toBe(40_000_000n); // $40
    expect(averageCost(h, 18)).toBe(320_000_000n); // $320 a share
    expect(h.lastBuy?.txHash).toBe(TX(n));
  });

  it("a partial sell takes out cost at the average and books the difference as realized", () => {
    const h = replay([buy(40_000_000n, E18 / 8n), sell(E18 / 16n, 25_000_000n)]).get(TSLA.toLowerCase())!;
    expect(h.qty).toBe(E18 / 16n);
    expect(h.costBasis).toBe(20_000_000n);
    expect(h.realizedPnl).toBe(5_000_000n); // sold $20 of cost for $25
    expect(averageCost(h, 18)).toBe(320_000_000n); // unchanged by a sale
  });

  it("a full sell clears the cost exactly, whatever the rounding, and a loss is negative", () => {
    const h = replay([buy(10_000_001n, 3n), sell(1n, 3_000_000n), sell(2n, 5_000_000n)]).get(TSLA.toLowerCase())!;
    expect(h.qty).toBe(0n);
    expect(h.costBasis).toBe(0n); // 10_000_001 * 1 / 3 rounded down, then the rest on the full sale
    expect(h.realizedPnl).toBe(3_000_000n - 3_333_333n + (5_000_000n - 6_666_668n));
  });

  it("rounds in bigint, never through floating point", () => {
    // 3 buys of $0.10 for 0.1 TSLA each: no 0.30000000000000004 anywhere.
    const h = replay([buy(100_000n, E18 / 10n), buy(100_000n, E18 / 10n), buy(100_000n, E18 / 10n)]).get(TSLA.toLowerCase())!;
    expect(h.costBasis).toBe(300_000n);
    expect(averageCost(h, 18)).toBe(1_000_000n); // exactly $1.00 a share
    const odd = replay([buy(1_000_000n, 3n * E18)]).get(TSLA.toLowerCase())!;
    expect(averageCost(odd, 18)).toBe(333_333n); // $0.333333, rounded down
  });

  it("a stock withdrawn by the owner leaves at average cost with no realized PnL", () => {
    const h = replay([buy(40_000_000n, E18 / 8n), withdraw(E18 / 16n)]).get(TSLA.toLowerCase())!;
    expect(h.qty).toBe(E18 / 16n);
    expect(h.costBasis).toBe(20_000_000n);
    expect(h.realizedPnl).toBe(0n);
  });

  it("shares that arrived outside a trade count at zero cost and are flagged", () => {
    const h = reconcile(replay([buy(40_000_000n, E18 / 8n)]).get(TSLA.toLowerCase())!, E18 / 8n + E18 / 8n);
    expect(h.transferredIn).toBe(E18 / 8n);
    expect(h.qty).toBe(E18 / 4n);
    expect(h.costBasis).toBe(40_000_000n);
    expect(averageCost(h, 18)).toBe(160_000_000n);
    const onlyGift = reconcile({ qty: 0n, costBasis: 0n, realizedPnl: 0n, lastBuy: null }, E18);
    expect(onlyGift).toMatchObject({ qty: E18, costBasis: 0n, transferredIn: E18 });
  });

  it("keeps tokens apart, and orders events by block and log index", () => {
    const events = [buy(10_000_000n, E18, AMD), { ...buy(5_000_000n, E18), block: 0n }];
    const m = replay(events);
    expect(m.get(AMD.toLowerCase())!.costBasis).toBe(10_000_000n);
    expect(m.get(TSLA.toLowerCase())!.costBasis).toBe(5_000_000n);
  });

  it("speaks one plain sentence", () => {
    expect(portfolioSentence(2, 62_000_000n, 10_000_000n, 1_400_000n, 6)).toBe("You hold $62 across 2 stocks, up $1.40 overall.");
    expect(portfolioSentence(1, 9_920_000n, 0n, -80_000n, 6)).toBe("You hold $9.92 across 1 stock, down $0.08 overall.");
    expect(portfolioSentence(0, 0n, 50_000_000n, 0n, 6)).toBe("No stocks yet. Everything's in USDG. You have $50 to trade with.");
  });
});

describe("incremental event cache", () => {
  it("reads from the deploy block once, then only new blocks", async () => {
    let latest = 100n;
    const reads: Array<[bigint, bigint]> = [];
    const source: EventSource = {
      latestBlock: async () => latest,
      deployBlock: vi.fn(async () => 40n),
      events: async (_v, from, to) => {
        reads.push([from, to]);
        return from <= 50n && 50n <= to ? [buy(10_000_000n, E18)] : [];
      },
    };
    const cache = new VaultEventCache(source);
    expect(await cache.get(VAULT)).toHaveLength(1);
    latest = 120n;
    expect(await cache.get(VAULT)).toHaveLength(1);
    expect(await cache.get(VAULT)).toHaveLength(1); // nothing new: no read
    expect(reads).toEqual([
      [40n, 100n],
      [101n, 120n],
    ]);
    expect(source.deployBlock).toHaveBeenCalledTimes(1);
  });

  it("finds the deploy block by binary search on the code, or falls back to the floor", async () => {
    const code = async (b: bigint) => (b >= 1_234n ? ("0x6080" as Hex) : ("0x" as Hex));
    expect(await findDeployBlock(code, 1_000n, 2_000n)).toBe(1_234n);
    expect(await findDeployBlock(async () => Promise.reject(new Error("no archive")), 1_000n, 2_000n)).toBe(1_000n);
  });
});

describe("buildPortfolio", () => {
  it("values each position at the oracle price, with PnL in $ and %, and totals", async () => {
    const events = new VaultEventCache({ latestBlock: async () => 10n, deployBlock: async () => 1n, events: async () => [buy(10_000_000n, E18 / 40n)] });
    const p = await buildPortfolio(
      {
        readVault: async () => ({ usdg: USDG, usdgDecimals: 6 }),
        readPrice: async (symbol) => ({ price: symbol === "TSLA" ? 44_000_000_000n : 1n, decimals: 8, ageSeconds: 3_600, state: "OPEN" }),
        balanceOf: async (token) => (token === USDG ? 50_000_000n : token === TSLA ? E18 / 40n : 0n),
        events,
        now: async () => 1_790_000_000,
      },
      ctx,
      VAULT,
    );
    expect(p.positions.map((x) => x.symbol)).toEqual(["TSLA"]);
    const t = p.positions[0]!;
    expect(t.value.formatted).toBe("$11"); // 0.025 x $440
    expect(t.unrealizedPnl.formatted).toBe("+$1");
    expect(t.unrealizedPnlPct).toBe("+10%");
    expect(t.avgCost.formatted).toBe("$400");
    expect(t.priceAge.text).toBe("1 hour");
    expect(p.totals.value.formatted).toBe("$61");
    expect(p.usdg.formatted).toBe("$50");
    expect(p.sentence).toBe("You hold $11 across 1 stock, up $1 overall.");
  });
});

describe("GET /portfolio: an unreachable chain is not 'not a vault'", () => {
  const app = createApp(ctx);
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as { error: { code: string; message: string } } };
  };

  it("RPC trouble: 503 RPC_UNAVAILABLE", async () => {
    const down = new HttpRequestError({ url: "https://rpc.example", details: "fetch failed" });
    vi.spyOn(ctx.client, "readContract").mockRejectedValue(down);
    vi.spyOn(ctx.client, "getCode").mockRejectedValue(down);
    const { status, body } = await get(`/portfolio/${VAULT}`);
    expect(status).toBe(503);
    expect(body.error).toEqual({ code: "RPC_UNAVAILABLE", message: RPC_TROUBLE_MESSAGE });
    vi.restoreAllMocks();
  });

  it("the chain answered, no vault there: 404 NOT_A_VAULT", async () => {
    vi.spyOn(ctx.client, "readContract").mockRejectedValue(new ContractFunctionZeroDataError({ functionName: "owner" }));
    vi.spyOn(ctx.client, "getCode").mockResolvedValue(undefined);
    const { status, body } = await get(`/portfolio/${VAULT}`);
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_A_VAULT");
    vi.restoreAllMocks();
  });

  it("is rate limited per IP", async () => {
    const limitedCtx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, PORTFOLIO_RATE_LIMIT_PER_MINUTE: "1" }), () => {});
    const limited = createApp(limitedCtx);
    vi.spyOn(limitedCtx.client, "readContract").mockRejectedValue(new ContractFunctionZeroDataError({ functionName: "owner" }));
    vi.spyOn(limitedCtx.client, "getCode").mockResolvedValue(undefined);
    await limited.request(`/portfolio/0x000000000000000000000000000000000000dEaD`);
    const second = await limited.request(`/portfolio/0x000000000000000000000000000000000000dEaD`);
    expect(second.status).toBe(429);
    vi.restoreAllMocks();
  });
});
