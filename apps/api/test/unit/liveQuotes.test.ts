/**
 * Live market prices (display only) and the drift guard, and the SPY/QQQ "Price too old" fix. A fake Finnhub, a fake
 * Yahoo and a fake chain client: no network, no keys (fakes built at runtime), nothing sent.
 */
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { agentExecutor } from "../../src/basket.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { CLOSED_POLL_MS, gapBps, LiveQuotes, OPEN_POLL_MS, usMarketOpen } from "../../src/liveQuotes.js";
import { driftCheck, readPrice, refuseOnDrift, stockBySymbol } from "../../src/services.js";
import { replyFor } from "../../src/voice/routes.js";
import { FAKE_FINNHUB_KEY } from "../support/fake-keys.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const env = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const SYMBOLS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD", "SPY", "QQQ"];
// Friday 25 Sep 2026, 10:00 in New York (the market is open).
const OPEN_AT = Date.parse("2026-09-25T14:00:00Z");

/** A fake Finnhub quote endpoint: each symbol's price, or a status to fail with. */
function finnhub(prices: Record<string, number | number[]>, calls: Array<{ url: string; key: string | null }> = []) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), key: new Headers(init?.headers).get("X-Finnhub-Token") });
    const p = prices[u.searchParams.get("symbol")!];
    if (Array.isArray(p)) return new Response("error", { status: p[0] });
    return Response.json({ c: p ?? 0, t: p ? Math.floor(OPEN_AT / 1000) - 5 : 0 });
  }) as unknown as typeof fetch;
}

describe("the US market's hours (the poll cadence)", () => {
  it.each([
    ["2026-09-25T14:00:00Z", true], // Friday 10:00 New York
    ["2026-09-25T13:29:00Z", false], // 9:29, before the open
    ["2026-09-25T13:30:00Z", true], // 9:30
    ["2026-09-25T20:00:00Z", false], // 16:00, the close
    ["2026-09-26T15:00:00Z", false], // Saturday
  ])("%s -> open %s", (at, open) => {
    expect(usMarketOpen(Date.parse(at))).toBe(open);
  });
});

describe("LiveQuotes", () => {
  it("Finnhub for every symbol, the key only in a header (never in the URL), each quote with its source and time", async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    const q = new LiveQuotes({ symbols: SYMBOLS, finnhubKey: FAKE_FINNHUB_KEY, fetch: finnhub({ TSLA: 373.9, AMZN: 220.5, PLTR: 30.1, NFLX: 700, AMD: 160, SPY: 768.4, QQQ: 741.8 }, calls), now: () => OPEN_AT, yahoo: async () => null, log: () => {} });
    await q.refresh();
    expect(q.get("TSLA")).toEqual({ symbol: "TSLA", price: 373.9, source: "finnhub", quotedAt: Math.floor(OPEN_AT / 1000) - 5, fetchedAt: OPEN_AT });
    expect(q.all()).toHaveLength(7);
    expect(calls).toHaveLength(7);
    for (const c of calls) {
      expect(c.key).toBe(FAKE_FINNHUB_KEY);
      expect(c.url).not.toContain(FAKE_FINNHUB_KEY);
    }
  });

  it("Finnhub failing for a symbol (a 500, or a zero quote): the Yahoo quote, marked yahoo; one log line, no key", async () => {
    const lines: string[] = [];
    const q = new LiveQuotes({
      symbols: ["TSLA", "SPY", "QQQ"],
      finnhubKey: FAKE_FINNHUB_KEY,
      fetch: finnhub({ TSLA: 373.9, SPY: [500] }),
      yahoo: async (s) => (s === "SPY" ? { price: 768.2, quotedAt: 1_790_000_000 } : null),
      now: () => OPEN_AT,
      log: (l) => lines.push(l),
    });
    await q.refresh();
    expect(q.get("SPY")).toMatchObject({ price: 768.2, source: "yahoo" });
    expect(q.get("TSLA")?.source).toBe("finnhub");
    expect(q.get("QQQ")).toBeNull(); // neither answered
    expect(lines).toEqual(["[quotes] Finnhub failed for SPY (Finnhub answered 500), QQQ (Finnhub: no quote); used Yahoo where it answered"]);
    expect(lines.join()).not.toContain(FAKE_FINNHUB_KEY);
  });

  it("no Finnhub key: Yahoo only", async () => {
    const fetchSpy = vi.fn();
    const q = new LiveQuotes({ symbols: ["NFLX"], fetch: fetchSpy as unknown as typeof fetch, yahoo: async () => ({ price: 701, quotedAt: 1 }), now: () => OPEN_AT, log: () => {} });
    await q.refresh();
    expect(q.get("NFLX")?.source).toBe("yahoo");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every 15s while open (7 symbols: 28 calls a minute, under Finnhub's 60), every 5 minutes while closed; old quotes aren't live", async () => {
    let now = OPEN_AT;
    const q = new LiveQuotes({ symbols: SYMBOLS, finnhubKey: FAKE_FINNHUB_KEY, fetch: finnhub({ TSLA: 373.9 }), yahoo: async () => null, now: () => now, log: () => {} });
    expect(q.pollMs()).toBe(OPEN_POLL_MS);
    expect(SYMBOLS.length * (60_000 / OPEN_POLL_MS)).toBeLessThanOrEqual(60);
    await q.refresh();
    now += 2 * OPEN_POLL_MS + 30_000;
    expect(q.get("TSLA")).not.toBeNull();
    now += 1;
    expect(q.get("TSLA")).toBeNull(); // missed two polls: not live any more
    now = Date.parse("2026-09-26T15:00:00Z");
    expect(q.pollMs()).toBe(CLOSED_POLL_MS);
  });

  it("the poll loop runs at the market's cadence and stops", async () => {
    vi.useFakeTimers({ now: OPEN_AT });
    const fetchFn = finnhub({ TSLA: 1 });
    const q = new LiveQuotes({ symbols: ["TSLA"], finnhubKey: FAKE_FINNHUB_KEY, fetch: fetchFn, yahoo: async () => null, log: () => {} });
    q.start();
    await vi.advanceTimersByTimeAsync(OPEN_POLL_MS * 3 + 100);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    q.stop();
    await vi.advanceTimersByTimeAsync(OPEN_POLL_MS * 3);
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/** A context whose live quotes are TSLA at `live` (or none), and whose chain reads the given oracle price. */
async function setup(o: { live?: number; oracle?: number; tokenConfig?: readonly [boolean, string, number, number] } = {}) {
  const ctx = createContext(loadConfig(env), () => {});
  const now = Date.now();
  ctx.liveQuotes = new LiveQuotes({ symbols: SYMBOLS, finnhubKey: FAKE_FINNHUB_KEY, fetch: finnhub(o.live === undefined ? {} : { TSLA: o.live }), yahoo: async () => null, now: () => now, log: () => {} });
  await ctx.liveQuotes.refresh();
  const feedUpdatedAt = BigInt(Math.floor(now / 1000) - 3 * 3600);
  const simulateContract = vi.fn(async () => ({ request: {} }));
  const client = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "latestRoundData") return [1n, BigInt(Math.round((o.oracle ?? 370) * 1e8)), 0n, feedUpdatedAt, 1n];
      if (functionName === "decimals") return 8;
      if (functionName === "tokenConfig") return o.tokenConfig ?? [true, "0x0000000000000000000000000000000000000001", 72_000, 345_600];
      throw new Error(`unexpected read ${functionName}`);
    }),
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: BigInt(Math.floor(now / 1000)) })),
    simulateContract,
  };
  (ctx as { client: unknown }).client = client;
  (ctx as { signer: unknown }).signer = { account: { address: "0x1111111111111111111111111111111111111111" } };
  return { ctx: ctx as AppContext, simulateContract };
}

describe("the drift guard (LIVE_ORACLE_MAX_GAP_BPS, default 200 = 2%)", () => {
  const tesla = (ctx: AppContext) => stockBySymbol(ctx, "TSLA");
  const oracle = (usd: number) => ({ price: BigInt(Math.round(usd * 1e8)), decimals: 8 });

  it("defaults to 2%", () => {
    expect(loadConfig(env).LIVE_ORACLE_MAX_GAP_BPS).toBe(200);
    expect(Math.round(gapBps(377.4, 370))).toBe(200);
  });

  it("within 2%: passes (checked, gap reported)", async () => {
    const { ctx } = await setup({ live: 373.9 });
    expect(driftCheck(ctx, tesla(ctx), oracle(370))).toMatchObject({ checked: true, blocked: false, gapBps: 105, maxGapBps: 200 });
    expect(() => refuseOnDrift(ctx, tesla(ctx), oracle(370), "buy TSLA")).not.toThrow();
  });

  it("more than 2% apart: refused, with the sentence to say and both prices", async () => {
    const { ctx } = await setup({ live: 380 });
    const d = driftCheck(ctx, tesla(ctx), oracle(370));
    expect(d.blocked).toBe(true);
    expect(d.guard).toMatchObject({
      code: "PRICE_DRIFT",
      message: "The on-chain price is behind the market right now, so I won't trade Tesla yet.",
      detail: { livePrice: "$380.00", oraclePrice: "$370.00", gapBps: 270, gap: "2.7%", maxGapBps: 200, liveSource: "finnhub" },
    });
    let status = 0;
    let code = "";
    try {
      refuseOnDrift(ctx, tesla(ctx), oracle(370), "buy TSLA");
    } catch (err) {
      ({ status, code } = err as { status: number; code: string });
    }
    expect([status, code]).toEqual([422, "PRICE_DRIFT"]);
  });

  it("no live quote: never blocks, and says so in the log", async () => {
    const { ctx } = await setup({});
    const lines: string[] = [];
    expect(driftCheck(ctx, tesla(ctx), oracle(370), (l) => lines.push(l))).toMatchObject({ checked: false, blocked: false, guard: null });
    expect(lines).toEqual(["[drift] no live quote for TSLA: not blocking"]);
  });

  it("a basket leg is checked just before it's sent: refused legs never reach the chain", async () => {
    const blocked = await setup({ live: 400, oracle: 370 });
    const req = { vault: "0x426B48569E52C9ad4fEc6F828102619575d60B20" as const, legs: [{ symbol: "TSLA", amount: "10" }] };
    const x = agentExecutor(blocked.ctx, req as never, [{ args: [], exCtx: {} }] as never);
    const err = await x.prepare(0).catch((e: Error) => e);
    expect((err as { code?: string }).code).toBe("PRICE_DRIFT");
    expect(x.explain(0, err)).toBe("The on-chain price is behind the market right now, so I won't trade Tesla yet.");
    expect(blocked.simulateContract).not.toHaveBeenCalled();

    const fine = await setup({ live: 371, oracle: 370 });
    await agentExecutor(fine.ctx, req as never, [{ args: [], exCtx: {} }] as never).prepare(0);
    expect(fine.simulateContract).toHaveBeenCalledTimes(1);
  });
});

describe("live prices where people see them", () => {
  beforeEach(() => vi.useRealTimers());

  it("GET /quotes/live: all seven assets, each with its price, source and age (CORS as every route)", async () => {
    const { ctx } = await setup({ live: 373.9 });
    const res = await createApp(ctx).request("/quotes/live");
    const body = (await res.json()) as { marketOpen: boolean; pollMs: number; quotes: Array<{ symbol: string; live: { price: string; source: string } | null }> };
    expect(body.quotes.map((q) => q.symbol)).toEqual(SYMBOLS);
    expect(body.quotes[0]).toMatchObject({ symbol: "TSLA", live: { price: "373.90", source: "finnhub" } });
    expect(body.quotes.find((q) => q.symbol === "SPY")?.live).toBeNull();
  });

  it("voice quotes the live price (\"Tesla is at $373.90\"), with the vault's price in the facts", async () => {
    const { ctx } = await setup({ live: 373.9, oracle: 370 });
    const r = await replyFor(ctx, { intent: "price", symbol: "TSLA", amount: null } as never, {}, "0x426B48569E52C9ad4fEc6F828102619575d60B20");
    expect(r.reply).toBe("Tesla is at $373.90. The market's open.");
    expect(r.facts).toMatchObject({ price: "373.90", source: "live (finnhub)", vaultPrice: "370" });
  });
});

describe("SPY and QQQ in a vault that never added them (the \"Price too old\" bug)", () => {
  it("a token the vault never configured is classified with the standard 20h/96h rule, not as too old; approved says false", async () => {
    const { ctx } = await setup({ tokenConfig: [false, "0x0000000000000000000000000000000000000000", 0, 0] });
    const p = await readPrice(ctx, stockBySymbol(ctx, "SPY"), "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113");
    expect(p).toMatchObject({ state: "OPEN", approved: false, configured: false, openMaxAge: 72_000, closedMaxAge: 345_600 });
    expect(p.ageSeconds).toBeGreaterThanOrEqual(3 * 3600 - 1); // 3 hours old: open under 20h, as AMZN and AMD are
  });

  it("a configured token keeps the vault's own thresholds (the vault's real rule)", async () => {
    const { ctx } = await setup({ tokenConfig: [true, "0x0000000000000000000000000000000000000001", 3_600, 7_200] });
    const p = await readPrice(ctx, stockBySymbol(ctx, "SPY"), "0x426B48569E52C9ad4fEc6F828102619575d60B20");
    expect(p).toMatchObject({ state: "STALE", approved: true, configured: true, openMaxAge: 3_600, closedMaxAge: 7_200 });
  });
});
