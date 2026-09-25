/**
 * Why it moved: only the headlines given, cited; advice and predictions thrown away; cached; graceful without Claude or
 * Finnhub. Fakes stand in for both: no network.
 */
import { resolve } from "node:path";

import { containsAdvice, NEWS_UNAVAILABLE, NO_CLEAR_NEWS, TONE_RULES } from "@glance/core/tone";
import { usTicker } from "@glance/core/tickers";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { MessagesClient } from "../../src/llm.js";
import { LlmBudget } from "../../src/llmBudget.js";
import { TtlCache } from "../../src/ttlCache.js";
import { rulesIntent } from "../../src/voice/intent.js";
import {
  checkSummary,
  createFinnhub,
  createWhySummarizer,
  explainMove,
  spokenSummary,
  type FeedMove,
  type NewsArticle,
  type NewsClient,
  type WhyAnswer,
  type WhyDeps,
} from "../../src/why.js";
import { FAKE_FINNHUB_KEY } from "../support/fake-keys.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const quiet = () => {};
const T0 = Date.parse("2026-09-24T12:00:00Z");
const TESLA = { symbol: "TSLA", name: "Tesla" };

const articles: NewsArticle[] = [
  { headline: "Tesla deliveries beat estimates", url: "https://news.example/1", source: "Reuters", datetime: T0 / 1000 - 3_600 },
  { headline: "Tesla recalls some Model Y vehicles", url: "https://news.example/2", source: "AP", datetime: T0 / 1000 - 7_200 },
  { headline: "EV stocks rise on rate hopes", url: "https://news.example/3", source: "Bloomberg", datetime: T0 / 1000 - 10_800 },
  { headline: "Tesla opens new Supercharger sites", url: "https://news.example/4", source: "Yahoo", datetime: T0 / 1000 - 14_400 },
];
const move: FeedMove = { fromPrice: 37_000_000_000n, toPrice: 38_000_000_000n, decimals: 8, fromAt: T0 / 1000 - 72 * 3_600, toAt: T0 / 1000, marketState: "OPEN" };

function fakeNews(opts: { down?: boolean } = {}) {
  const news: NewsClient = {
    companyNews: vi.fn(async () => {
      if (opts.down) throw new Error("Finnhub unreachable");
      return articles;
    }),
    quote: vi.fn(async () => ({ c: 380, pc: 370, dp: 2.7, t: T0 / 1000 })),
  };
  return news;
}

function fakeClaude(summary: string) {
  const create = vi.fn(async () => ({ content: [{ type: "tool_use", id: "t", name: "write_summary", input: { summary } }], usage: { input_tokens: 300, output_tokens: 40 }, stop_reason: "tool_use" }));
  return { client: { messages: { create } } as unknown as MessagesClient, create };
}

function deps(over: Partial<WhyDeps> & { summary?: string; limit?: number } = {}) {
  const claude = fakeClaude(over.summary ?? "Reports point to deliveries that beat estimates [1], and the rise may also reflect wider EV optimism [3].");
  const budget = new LlmBudget(over.limit ?? 150, null, quiet, () => T0);
  const d: WhyDeps = {
    news: fakeNews(),
    summarizer: createWhySummarizer({ model: "claude-haiku-4-5", budget, log: quiet, client: claude.client }),
    summaries: new TtlCache<Omit<WhyAnswer, "cached">>(null, 3 * 3_600_000, () => T0),
    feedMove: async () => move,
    now: () => T0,
    ...over,
  };
  return { d, claude, budget };
}

describe("the summary", () => {
  it("uses only the headlines given, numbered, and keeps a cited, hedged summary", async () => {
    const { d, claude } = deps();
    const a = await explainMove(d, TESLA);
    expect(a.summary).toBe("Reports point to deliveries that beat estimates [1], and the rise may also reflect wider EV optimism [3].");
    expect(a.sources).toHaveLength(4);
    expect(a.cached).toBe(false);
    const call = (claude.create.mock.calls[0] as unknown[])[0] as { system: string; max_tokens: number; model: string; messages: Array<{ content: string }> };
    expect(call.model).toBe("claude-haiku-4-5");
    expect(call.max_tokens).toBeLessThanOrEqual(256);
    expect(call.system).toContain("Use ONLY the numbered headlines provided.");
    for (const rule of TONE_RULES) expect(call.system).toContain(rule);
    const prompt = call.messages[0]!.content;
    articles.forEach((x, i) => expect(prompt).toContain(`[${i + 1}] ${x.headline}`));
    expect(prompt).toContain("It moved +2.7% over 3 days ($370.00 to $380.00).");
  });

  it("requires citations, and only to headlines that exist", () => {
    expect(checkSummary("Deliveries beat estimates [1].", 4)).toEqual({ ok: true, text: "Deliveries beat estimates [1]." });
    expect(checkSummary("Deliveries beat estimates.", 4)).toEqual({ ok: false, reason: "citations" });
    expect(checkSummary("Reports point to a recall [9].", 4)).toEqual({ ok: false, reason: "citations" });
    expect(checkSummary(NO_CLEAR_NEWS, 4)).toEqual({ ok: true, text: NO_CLEAR_NEWS });
    // At most two sentences.
    expect(checkSummary("One [1]. Two [2]. Three [3].", 4)).toEqual({ ok: true, text: "One [1]. Two [2]." });
  });

  it("the advice guard drops a summary that advises or predicts, leaving the top 3 headlines", async () => {
    for (const bad of [
      "Deliveries beat estimates [1], so you should consider buying.",
      "Analysts set a price target of $500 [2].",
      "The stock will rise after the delivery beat [1].",
      "Tesla is expected to reach new highs [1].",
      "Buy now: deliveries beat estimates [1].",
    ]) {
      const { d } = deps({ summary: bad });
      const a = await explainMove(d, TESLA);
      expect(a.summary).toBeNull();
      expect(a.summaryNote).toBe("guarded");
      expect(a.sources.map((s) => s.title)).toEqual(articles.slice(0, 3).map((x) => x.headline));
    }
    expect(containsAdvice("Reports point to a delivery beat [1].")).toBe(false);
  });

  it("'No clear news explains this move.' is a fine answer", async () => {
    const a = await explainMove(deps({ summary: NO_CLEAR_NEWS }).d, TESLA);
    expect(a.summary).toBe(NO_CLEAR_NEWS);
  });

  it("is spoken without the citation marks", () => {
    const a = { symbol: "TSLA", move: null, summary: "Reports point to a delivery beat [1] and EV optimism [3].", sources: [], generatedAt: "", cached: false };
    expect(spokenSummary(a, "Tesla")).toBe("Reports point to a delivery beat and EV optimism.");
    expect(spokenSummary({ ...a, summary: null, sources: [{ title: "x", url: "", site: "", publishedAt: "" }] }, "Tesla")).toBe("Here are the latest headlines about Tesla.");
  });
});

describe("caching and fallbacks", () => {
  it("a cache hit makes no Finnhub or Claude call", async () => {
    const { d, claude } = deps();
    await explainMove(d, TESLA);
    const again = await explainMove(d, TESLA);
    expect(again.cached).toBe(true);
    expect(d.news!.companyNews).toHaveBeenCalledTimes(1);
    expect(claude.create).toHaveBeenCalledTimes(1);
  });

  it("at the LLM daily limit: the top 3 headlines, no summary, no error, and not cached", async () => {
    const { d, claude } = deps({ limit: 0 });
    const a = await explainMove(d, TESLA);
    expect(a.summary).toBeNull();
    expect(a.summaryNote).toBe("llm-unavailable");
    expect(a.sources).toHaveLength(3);
    expect(claude.create).not.toHaveBeenCalled();
    await explainMove(d, TESLA);
    expect(d.news!.companyNews).toHaveBeenCalledTimes(2); // not cached: asked again later
  });

  it("if Claude fails: the same headlines-only answer", async () => {
    const budget = new LlmBudget(150, null, quiet, () => T0);
    const failing = { messages: { create: vi.fn(async () => Promise.reject(Object.assign(new Error("overloaded"), { status: 529 }))) } } as unknown as MessagesClient;
    const { d } = deps({ summarizer: createWhySummarizer({ model: "claude-haiku-4-5", budget, log: quiet, client: failing }) });
    const a = await explainMove(d, TESLA);
    expect(a).toMatchObject({ summary: null, summaryNote: "llm-unavailable" });
    expect(a.sources).toHaveLength(3);
  });

  it("Finnhub down: 'News isn't available right now.', no error", async () => {
    const { d, claude } = deps({ news: fakeNews({ down: true }) });
    const a = await explainMove(d, TESLA);
    expect(a.summary).toBe(NEWS_UNAVAILABLE);
    expect(a.sources).toEqual([]);
    expect(claude.create).not.toHaveBeenCalled();
    expect(a.move?.pct).toBe("+2.7%"); // our own feed still says how it moved
  });

  it("no Finnhub key at all: the same graceful message", async () => {
    const a = await explainMove(deps({ news: null }).d, TESLA);
    expect(a.summary).toBe(NEWS_UNAVAILABLE);
  });
});

describe("the move", () => {
  it("comes from our feed history, and says so when the market is closed", async () => {
    const open = await explainMove(deps().d, TESLA);
    expect(open.move).toMatchObject({ pct: "+2.7%", from: "$370.00", to: "$380.00", window: "over 3 days", source: "glance-feed" });
    const closed = await explainMove(deps({ feedMove: async () => ({ ...move, marketState: "CLOSED" }) }).d, TESLA);
    expect(closed.move?.note).toBe("The market is closed, so this is the move as of the last close.");
  });

  it("falls back to Finnhub's quote, clearly labelled, when our history is too short", async () => {
    const a = await explainMove(deps({ feedMove: async () => null }).d, TESLA);
    expect(a.move).toMatchObject({ pct: "+2.7%", from: "$370.00", to: "$380.00", window: "since the previous close", source: "finnhub-quote", label: "Finnhub quote (change since the previous close)" });
  });

  it("maps Robinhood Stock Tokens to their US tickers", () => {
    expect(["TSLA", "AMZN", "PLTR", "NFLX", "AMD"].map(usTicker)).toEqual(["TSLA", "AMZN", "PLTR", "NFLX", "AMD"]);
    expect(usTicker("NOPE")).toBeNull();
  });
});

describe("Finnhub client", () => {
  it("caches responses for 15 minutes and never leaks the key in errors", async () => {
    let now = T0;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(articles), { status: 200 }));
    const f = createFinnhub({ apiKey: FAKE_FINNHUB_KEY, fetch: fetchFn as unknown as typeof fetch, cache: new TtlCache(null, 15 * 60_000, () => now) });
    await f.companyNews("TSLA", "2026-09-21", "2026-09-24");
    await f.companyNews("TSLA", "2026-09-21", "2026-09-24");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 15 * 60_000;
    await f.companyNews("TSLA", "2026-09-21", "2026-09-24");
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const down = createFinnhub({ apiKey: FAKE_FINNHUB_KEY, fetch: (async () => new Response("no", { status: 502 })) as unknown as typeof fetch, cache: new TtlCache(null, 1) });
    const err = await down.companyNews("TSLA", "a", "b").catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(FAKE_FINNHUB_KEY);
  });
});

describe("GET /why", () => {
  const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, FINNHUB_API_KEY: FAKE_FINNHUB_KEY, ANTHROPIC_API_KEY: "", WHY_RATE_LIMIT_PER_MINUTE: "2" }), quiet);
  ctx.why.news = fakeNews({ down: true }); // no network in unit tests
  vi.spyOn(ctx.client, "getBlockNumber").mockRejectedValue(new Error("no chain in unit tests"));
  const app = createApp(ctx);

  it("answers gracefully, never exposes the key, refuses unknown symbols, and is rate limited", async () => {
    const res = await app.request("/why/TSLA");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).summary).toBe(NEWS_UNAVAILABLE);
    expect(text).not.toContain(FAKE_FINNHUB_KEY);
    expect((await app.request("/why/NOPE")).status).toBe(404);
    expect((await app.request("/why/TSLA")).status).toBe(429);
  });
});

describe("voice: the new questions", () => {
  const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, ANTHROPIC_API_KEY: "" }), quiet);
  const catalog = ctx.catalog.entries;
  it("'how am I doing?', 'what do I own?' and 'show my portfolio' open the portfolio", () => {
    for (const said of ["how am I doing?", "what do I own", "show my portfolio", "Show me my positions"]) {
      expect(rulesIntent(said, catalog)).toMatchObject({ intent: "portfolio", symbol: null });
    }
  });
  it("'why did Tesla move?' asks why it moved; a bare 'why?' still explains a refusal", () => {
    expect(rulesIntent("why did Tesla move?", catalog)).toMatchObject({ intent: "why", symbol: "TSLA" });
    expect(rulesIntent("why is AMD down today", catalog)).toMatchObject({ intent: "why", symbol: "AMD" });
    expect(rulesIntent("why?", catalog)).toMatchObject({ intent: "explain" });
    expect(rulesIntent("why was that blocked", catalog)).toMatchObject({ intent: "explain" });
  });
});
