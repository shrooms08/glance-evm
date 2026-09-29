/**
 * Explaining a chart of any US stock, not only the catalog's: market candles from Yahoo Finance's public chart endpoint
 * (a fake here: no network), cached per ticker and range; the facts computed in code (bounces and trend included); the
 * page's chart chosen and logged with its path; and a trade of a stock outside the catalog refused in plain words.
 */
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { computeFacts } from "@glance/core/chart-facts";
import { LINES } from "@glance/core/persona";

import { createApp } from "../../src/app.js";
import { cachedQuoteHistory, MARKET_SOURCE, yahooHistory, type QuoteHistory } from "../../src/chart.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { createShowMe, pricesNote, symbolsFor, type ShowMeInput } from "../../src/showme.js";
import { chartContextFor, chartPathLog, summarize } from "../../src/showmeChart.js";
import { TtlCache } from "../../src/ttlCache.js";
import { LlmBudget } from "../../src/llmBudget.js";
import { rulesIntent, validateIntent } from "../../src/voice/intent.js";
import { replyFor } from "../../src/voice/routes.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const env = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const T = 1_790_000_000;

/** A week of NVDA: down to a low on day 2, a bounce, a dip, and a climb (hourly, 5 a day). */
const NVDA_WEEK = [180, 178, 175, 172, 170, 171, 174, 177, 179, 181, 178, 176, 177, 180, 183, 185, 186, 188, 187, 190].map((price, i) => ({ t: T - (20 - i) * 3600 * 5, price }));

/** A fake Yahoo Finance chart endpoint: the URL asked, and the answer (meta name, timestamps, closes). */
function fakeYahoo(points = NVDA_WEEK, name = "NVIDIA Corporation", status = 200) {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    if (status !== 200) return new Response("nope", { status });
    return Response.json({ chart: { result: [{ meta: { longName: name, shortName: "NVIDIA Corp" }, timestamp: points.map((p) => p.t), indicators: { quote: [{ close: points.map((p) => p.price) }] } }] } });
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

/** A context whose market candles come from the fake (the catalog's Chainlink reads are never needed here). */
function ctxWithCandles(history: (ticker: string, range: string) => Promise<QuoteHistory>): AppContext {
  const ctx = createContext(loadConfig(env), () => {});
  ctx.chartOverrides = { quoteHistory: history as never, reader: () => { throw new Error("offline"); }, thresholds: async () => null, now: () => T };
  return ctx;
}

describe("candles for any US ticker (Yahoo Finance's public chart endpoint)", () => {
  it("the chart's own window: 1 day is 5-minute candles, 6 months daily, 5 years weekly; the name comes along", async () => {
    const { fetchFn, urls } = fakeYahoo();
    const h = await yahooHistory("NVDA", "6M", fetchFn);
    expect(urls[0]).toBe("https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=6mo&interval=1d");
    expect(h).toMatchObject({ detail: "Yahoo Finance NVDA, daily closes", name: "NVIDIA Corporation" });
    expect(h.points).toHaveLength(20);
    await yahooHistory("NVDA", "1D", fetchFn);
    await yahooHistory("NVDA", "5Y", fetchFn);
    expect(urls.slice(1)).toEqual(["https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d&interval=5m", "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=5y&interval=1wk"]);
  });

  it("cached per ticker and range: the same chart twice is one fetch; another range is another", async () => {
    const { fetchFn } = fakeYahoo();
    const history = cachedQuoteHistory(new TtlCache<QuoteHistory>(null, 5 * 60_000), fetchFn);
    await history("NVDA", "1W");
    await history("NVDA", "1W");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await history("NVDA", "1M");
    await history("AAPL", "1W");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("GET /chart/NVDA and its facts: the market's candles, labelled Yahoo Finance, named NVIDIA", async () => {
    const asked: string[] = [];
    const ctx = ctxWithCandles(async (ticker, range) => (asked.push(`${ticker}:${range}`), { points: NVDA_WEEK, detail: `Yahoo Finance ${ticker}, 30-minute closes`, name: "NVIDIA Corporation" }));
    const app = createApp(ctx);
    const chart = (await (await app.request("/chart/NVDA?range=1W")).json()) as any;
    expect(chart).toMatchObject({ symbol: "NVDA", name: "NVIDIA Corporation", range: "1W", source: { label: MARKET_SOURCE, detail: "Yahoo Finance NVDA, 30-minute closes" } });
    expect(chart.points).toHaveLength(20);
    const facts = (await (await app.request("/chart/NVDA/facts?range=1W")).json()) as any;
    expect(facts.facts[0]).toMatchObject({ symbol: "NVDA", name: "NVIDIA", source: "Yahoo Finance", low: { price: 170 }, high: { price: 190 }, sinceBuy: null });
    expect(asked).toEqual(["NVDA:1W", "NVDA:1W"]);
  });

  it("a catalog stock on a range longer than Glance's own (the page's 6 months): the market's candles too", async () => {
    const asked: string[] = [];
    const ctx = ctxWithCandles(async (ticker, range) => (asked.push(`${ticker}:${range}`), { points: NVDA_WEEK, detail: "Yahoo Finance TSLA, daily closes" }));
    const chart = (await (await createApp(ctx).request("/chart/TSLA?range=6M")).json()) as any;
    expect(chart).toMatchObject({ symbol: "TSLA", name: "Tesla", range: "6M", source: { label: "Yahoo Finance" } });
    expect(asked).toEqual(["TSLA:6M"]);
  });

  it("a ticker with no prices: a plain 404; not a ticker at all: a 400", async () => {
    const ctx = ctxWithCandles(async () => {
      throw new Error("Yahoo answered 404");
    });
    const app = createApp(ctx);
    const res = await app.request("/chart/ZZZZ?range=1D");
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toMatchObject({ code: "NO_MARKET_DATA", message: "I can't find ZZZZ's prices right now." });
    expect((await app.request("/chart/12?range=1D")).status).toBe(400);
  });
});

describe("the facts for a stock outside the catalog, computed in code", () => {
  const f = computeFacts({ symbol: "NVDA", name: "NVIDIA", range: "1W", source: "Yahoo Finance", asOf: T, points: NVDA_WEEK })!;

  it("high, low, change, and where it bounced (a low, then a clear rise), in time order", () => {
    expect(f).toMatchObject({ first: { price: 180 }, last: { price: 190 }, change: { abs: 10, pct: 5.56 }, low: { price: 170 }, high: { price: 190 } });
    expect(f.bounces.map((b) => [b.from.price, b.to.price, b.pct])).toEqual([
      [170, 181, 6.47],
      [176, 190, 7.95],
    ]);
  });

  it("the trend: a straight line through every price, up", () => {
    expect(f.trend.direction).toBe("up");
    expect(f.trend.pct).toBeGreaterThan(0);
    expect(f.trend.from.t).toBe(NVDA_WEEK[0]!.t);
    expect(f.trend.to.t).toBe(NVDA_WEEK.at(-1)!.t);
    const flat = computeFacts({ symbol: "X", name: "X", range: "1D", source: "Yahoo Finance", asOf: T, points: [100, 100.1, 99.9, 100, 100.05].map((price, i) => ({ t: T + i * 60, price })) })!;
    expect(flat.trend.direction).toBe("flat");
    expect(flat.bounces).toEqual([]);
  });
});

describe("the page's chart: the path, logged", () => {
  const withNvda = () => ctxWithCandles(async () => ({ points: NVDA_WEEK, detail: "Yahoo Finance NVDA, 30-minute closes", name: "NVIDIA Corporation" }));

  it("the page's chart decides the stock and its own range, for any US ticker; one log line says which path and why", async () => {
    const lines: string[] = [];
    const got = await chartContextFor(
      withNvda(),
      { question: "show me where it bounced this week", pageChart: { symbol: "NVDA", range: "1W", drawOn: "page", method: "vision", reason: "linear time axis; our high and low sit inside the plot" } },
      (l) => lines.push(l),
    );
    expect(got.facts[0]).toMatchObject({ symbol: "NVDA", name: "NVIDIA", range: "1W", source: "Yahoo Finance" });
    expect(got.charts[0]).toMatchObject({ symbol: "NVDA", name: "NVIDIA", source: "Yahoo Finance" });
    expect(lines).toEqual(["[chart] NVDA 1W, Yahoo Finance prices: page chart via vision (linear time axis; our high and low sit inside the plot)"]);
  });

  it("each path's line: DOM labels, vision, the overlay (a fallback, or asked for), Glance's own chart, no data", () => {
    const at = { symbol: "TSLA", range: "1D" as const, source: "Chainlink" };
    expect(chartPathLog({ symbol: "TSLA", range: "1D", drawOn: "page", method: "dom", reason: "linear time axis" }, at, "")).toBe("[chart] TSLA 1D, Chainlink prices: page chart via DOM labels (linear time axis)");
    expect(chartPathLog({ symbol: "TSLA", range: "1D", drawOn: "lens", reason: "our line isn't on the page's" }, at, "")).toBe("[chart] TSLA 1D, Chainlink prices: Glance overlay (our line isn't on the page's)");
    expect(chartPathLog({ symbol: "TSLA", range: "1D", drawOn: "lens", forced: true }, at, "")).toBe("[chart] TSLA 1D, Chainlink prices: Glance overlay (asked for)");
    expect(chartPathLog(null, at, "the question names TSLA")).toBe("[chart] TSLA 1D, Chainlink prices: Glance's own chart (the question names TSLA)");
    expect(chartPathLog(null, null, "NVDA 1W: no prices")).toBe("[chart] no chart data (NVDA 1W: no prices)");
  });

  it("Show me may draw on the page's NVDA chart (not only the catalog's), and says whose prices it used", async () => {
    const f = computeFacts({ symbol: "NVDA", name: "NVIDIA", range: "1W", source: "Yahoo Finance", asOf: T, points: NVDA_WEEK })!;
    const chart = summarize({ symbol: "NVDA", name: "NVIDIA Corporation", range: "1W", points: NVDA_WEEK.map((p) => ({ ...p, formatted: `$${p.price}` })), source: { label: "Yahoo Finance", detail: "" }, lastUpdated: T, asOf: T, marketState: null, markers: [] }, "NVIDIA", [])!;
    const input: ShowMeInput = { question: "show me where it bounced this week", page: { text: "" }, charts: [chart], facts: [f], pageChart: { symbol: "NVDA", range: "1W", site: "tradingview", drawOn: "page", method: "vision" } };
    const catalog = new Set(["TSLA", "AMD"]);
    expect([...symbolsFor(input, catalog)].sort()).toEqual(["AMD", "NVDA", "TSLA"]);
    expect(pricesNote(input)).toBe("I'm using Yahoo Finance's prices, which can differ a little from this chart.");
    const bounce = f.bounces[0]!;
    const create = vi.fn(async () => ({ content: [{ type: "text", text: `It bounced from $170.00 [CHART_POINT:NVDA:${bounce.from.t}], up 6.47% to $181.00.` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    const showMe = createShowMe({ apiKey: undefined, model: "claude-haiku-4-5-20251001", budget: new LlmBudget(100, null, () => {}), symbols: ["TSLA", "AMD"], log: () => {}, client: { messages: { create } } as never })!;
    const a = await showMe.answer(input);
    expect(a.spoken).toBe("It bounced from $170.00, up 6.47% to $181.00. I'm using Yahoo Finance's prices, which can differ a little from this chart.");
    expect(a.actions.find((x) => x.kind === "CHART_POINT")).toMatchObject({ symbol: "NVDA", t: bounce.from.t });
  });
});

describe("trading a stock outside the catalog: refused in plain words", () => {
  const ctx = createContext(loadConfig(env), () => {});
  const catalog = ctx.catalog.entries;
  const page = { pageStock: { symbol: "NVDA", name: "NVIDIA" } };
  const intentOf = (said: string, context = page) => validateIntent(rulesIntent(said, catalog, context), said, catalog);
  const list = catalog.map((c) => c.symbol);

  it("the list is the catalog's, never written out by hand", () => {
    expect(list).toEqual(["TSLA", "AMZN", "PLTR", "NFLX", "AMD", "SPY", "QQQ"]);
    expect(LINES.notTradable("NVIDIA", list)).toBe("I can explain NVIDIA, but your vault only trades TSLA, AMZN, PLTR, NFLX, AMD, SPY and QQQ.");
  });

  it("'buy $10 of Nvidia' on NVDA's chart, 'sell it', 'buy this': the refusal, and no trade intent reaches a card", async () => {
    for (const said of ["buy ten dollars of Nvidia", "sell it", "buy $10 of this", "buy $25 of NVDA"]) {
      const got = intentOf(said);
      expect(got.offCatalog, said).toEqual({ symbol: "NVDA", name: "NVIDIA" });
      expect(got.symbol, said).toBeNull();
      expect((await replyFor(ctx, got, page)).reply, said).toBe("I can explain NVIDIA, but your vault only trades TSLA, AMZN, PLTR, NFLX, AMD, SPY and QQQ.");
    }
  });

  it("a catalog stock on the same page still trades; without a page stock, it's not a guess", () => {
    expect(intentOf("buy ten dollars of Tesla")).toMatchObject({ intent: "buy", symbol: "TSLA", amount: "10" });
    expect(intentOf("buy ten dollars of Tesla").offCatalog).toBeUndefined();
    expect(intentOf("buy ten dollars of Nvidia", {} as typeof page)).toMatchObject({ intent: "unknown" });
    expect(intentOf("don't buy Nvidia").offCatalog).toBeUndefined();
  });
});
