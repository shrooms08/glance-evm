/**
 * The Claude budget: Haiku only (Opus refused unless ALLOW_OPUS), the resolver cache, the daily cap with its UTC reset,
 * and the one-hour pause after a budget error. A fake client stands in for Anthropic: no test touches the network.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createContext, llmFiles } from "../../src/context.js";
import { createLlmResolver, type MessagesClient } from "../../src/llm.js";
import { chooseModel, HAIKU, isBudgetError, LlmBudget, MAX_OUTPUT_TOKENS, normalizeForCache, PAUSE_MS, ResolverCache } from "../../src/llmBudget.js";
import { llmHealth } from "../../src/services.js";
import { createClaudeIntent, understand } from "../../src/voice/intent.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const quiet = () => {};
const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, ANTHROPIC_API_KEY: "" }), quiet);
const catalog = ctx.catalog;

const T0 = Date.parse("2026-09-24T12:00:00Z");

/** A fake Anthropic client that answers with a tool call and counts the calls. */
function fakeClient(input: unknown, usage = { input_tokens: 812, output_tokens: 31 }) {
  const create = vi.fn(async () => ({ content: [{ type: "tool_use", id: "t", name: "x", input }], usage, stop_reason: "tool_use" }));
  return { client: { messages: { create } } as unknown as MessagesClient, create };
}

function resolverWith(client: MessagesClient, opts: { limit?: number; cacheFile?: string | null; usageFile?: string | null; now?: () => number; log?: (l: string) => void } = {}) {
  const now = opts.now ?? (() => T0);
  const budget = new LlmBudget(opts.limit ?? 150, opts.usageFile ?? null, opts.log ?? quiet, now);
  const cache = new ResolverCache(opts.cacheFile ?? null, now);
  const resolver = createLlmResolver({ apiKey: undefined, model: HAIKU, catalog: catalog.text, budget, cache, log: opts.log ?? quiet, client })!;
  return { resolver, budget, cache };
}

describe("models", () => {
  it("defaults every Claude call to Haiku, including the old ANTHROPIC_MODEL name", () => {
    const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE }), quiet);
    expect(c.llmModels).toEqual({ resolver: HAIKU, intent: HAIKU });
    expect(HAIKU).toBe("claude-haiku-4-5");
  });

  it("refuses Opus without ALLOW_OPUS, with one warning line, and uses Haiku", () => {
    const log = vi.fn();
    expect(chooseModel("claude-opus-5", false, "resolver", log)).toBe(HAIKU);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/resolver model "claude-opus-5" refused/);
    const lines: string[] = [];
    const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, ANTHROPIC_MODEL: "claude-opus-5", INTENT_MODEL: "claude-opus-4-7" }), (l) => lines.push(l));
    expect(c.llmModels).toEqual({ resolver: HAIKU, intent: HAIKU });
    expect(lines.filter((l) => l.includes("refused"))).toHaveLength(2);
    // RESOLVER_MODEL wins over the old name.
    expect(createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, RESOLVER_MODEL: "claude-sonnet-5", ANTHROPIC_MODEL: "claude-opus-5" }), quiet).llmModels.resolver).toBe("claude-sonnet-5");
  });

  it("allows Opus only with ALLOW_OPUS=1", () => {
    expect(chooseModel("claude-opus-5", true, "resolver", quiet)).toBe("claude-opus-5");
    const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, RESOLVER_MODEL: "claude-opus-5", ALLOW_OPUS: "1" }), quiet);
    expect(c.llmModels.resolver).toBe("claude-opus-5");
  });

  it("asks for small answers only", async () => {
    const { client, create } = fakeClient({ mentions: [] });
    await resolverWith(client).resolver.resolve("some text");
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ model: HAIKU, max_tokens: MAX_OUTPUT_TOKENS });
    expect(MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(256);
  });
});

describe("resolver cache", () => {
  it("a cache hit makes no API call, for the same text however it's spaced or cased", async () => {
    const { client, create } = fakeClient({ mentions: [{ symbol: "TSLA", quote: "the EV maker" }] });
    const { resolver } = resolverWith(client);
    const first = await resolver.resolve("Shares of the EV maker rose.");
    expect(first.map((m) => [m.symbol, m.start])).toEqual([["TSLA", 10]]);
    const again = await resolver.resolve("  shares of THE EV maker   rose. ");
    expect(create).toHaveBeenCalledTimes(1);
    expect(again).toEqual([]); // quote not verbatim in this casing: dropped, but still no call
    expect(await resolver.resolve("Shares of the EV maker rose.")).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("caches 'not a listed stock' too", async () => {
    const { client, create } = fakeClient({ mentions: [] });
    const { resolver } = resolverWith(client);
    expect(await resolver.resolve("Acme Widgets")).toEqual([]);
    expect(await resolver.resolve("acme widgets")).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("survives a restart through its file, keyed by hash (no page text on disk), for 24 hours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glance-llm-"));
    const cacheFile = join(dir, "resolver.json");
    let now = T0;
    const clock = () => now;
    const one = fakeClient({ mentions: [] });
    await resolverWith(one.client, { cacheFile, now: clock }).resolver.resolve("Acme Widgets");
    expect(readFileSync(cacheFile, "utf8")).not.toMatch(/acme/i);

    const two = fakeClient({ mentions: [] });
    await resolverWith(two.client, { cacheFile, now: clock }).resolver.resolve("ACME widgets");
    expect(two.create).not.toHaveBeenCalled();

    now = T0 + 24 * 3_600_000 + 1; // a day later: asked again
    const three = fakeClient({ mentions: [] });
    await resolverWith(three.client, { cacheFile, now: clock }).resolver.resolve("Acme Widgets");
    expect(three.create).toHaveBeenCalledTimes(1);
  });

  it("normalizes case and whitespace", () => {
    expect(normalizeForCache("  Tesla\n\tInc  ")).toBe("tesla inc");
  });
});

describe("daily limit", () => {
  it("at the limit, /resolve answers with the dictionary (no matches) and never errors, logging one line", async () => {
    const log = vi.fn();
    const { client, create } = fakeClient({ mentions: [] });
    const { resolver, budget } = resolverWith(client, { limit: 2, log });
    await resolver.resolve("text one");
    await resolver.resolve("text two");
    await expect(resolver.resolve("text three")).resolves.toEqual([]);
    await expect(resolver.resolve("text four")).resolves.toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.filter(([l]) => l === "[llm] LLM daily limit reached, using rules")).toHaveLength(1);
    expect(budget.status()).toMatchObject({ dailyLimit: 2, usedToday: 2, paused: false });
  });

  it("at the limit, voice intents use the rules parser with no error", async () => {
    const budget = new LlmBudget(0, null, quiet, () => T0);
    const { client, create } = fakeClient({ intent: "unknown", symbol: null, amount: null, reply: "?" });
    const model = createClaudeIntent(undefined, HAIKU, catalog.entries, 3_000, { budget, client, log: quiet })!;
    const result = await understand("buy ten dollars of Tesla", {}, catalog.entries, model);
    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ intent: "buy", symbol: "TSLA", amount: "10", source: "rules" });
  });

  it("counts every Claude call across the API: resolver and intent share one budget", async () => {
    const budget = new LlmBudget(2, null, quiet, () => T0);
    const r = fakeClient({ mentions: [] });
    const resolver = createLlmResolver({ apiKey: undefined, model: HAIKU, catalog: catalog.text, budget, cache: new ResolverCache(null), log: quiet, client: r.client })!;
    const i = fakeClient({ intent: "price", symbol: "TSLA", amount: null, reply: null });
    const intent = createClaudeIntent(undefined, HAIKU, catalog.entries, 3_000, { budget, client: i.client, log: quiet })!;
    await resolver.resolve("a");
    await understand("what's Tesla at", {}, catalog.entries, intent);
    await understand("what's Tesla at", {}, catalog.entries, intent); // over the limit: rules
    expect(r.create.mock.calls.length + i.create.mock.calls.length).toBe(2);
  });

  it("resets at 00:00 UTC, and the counter survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "glance-llm-"));
    const usage = join(dir, "llm-usage.json");
    let now = Date.parse("2026-09-24T23:59:59Z");
    const clock = () => now;
    const a = new LlmBudget(1, usage, quiet, clock);
    expect(a.tryAcquire()).toBe(true);
    expect(a.tryAcquire()).toBe(false);
    const b = new LlmBudget(1, usage, quiet, clock); // restarted the same day: still used up
    expect(b.tryAcquire()).toBe(false);
    now = Date.parse("2026-09-25T00:00:00Z");
    expect(b.status().usedToday).toBe(0);
    expect(b.tryAcquire()).toBe(true);
    expect(new LlmBudget(1, usage, quiet, clock).status()).toMatchObject({ usedToday: 1 });
  });
});

describe("budget errors", () => {
  function failing(err: unknown) {
    const create = vi.fn(async () => {
      throw err;
    });
    return { client: { messages: { create } } as unknown as MessagesClient, create };
  }

  it("a 402 pauses Claude for an hour: rules fallback, no error, no further calls", async () => {
    let now = T0;
    const log = vi.fn();
    const budget = new LlmBudget(150, null, log, () => now);
    const bad = failing(Object.assign(new Error("402 Payment Required"), { status: 402 }));
    const intent = createClaudeIntent(undefined, HAIKU, catalog.entries, 3_000, { budget, client: bad.client, log })!;
    const first = await understand("buy ten dollars of Tesla", {}, catalog.entries, intent);
    expect(first).toMatchObject({ intent: "buy", source: "rules" });
    expect(budget.status().paused).toBe(true);
    await understand("what's Tesla at", {}, catalog.entries, intent);
    expect(bad.create).toHaveBeenCalledTimes(1); // paused: not asked again
    expect(log.mock.calls.some(([l]) => /pausing Claude for 1 hour/.test(l))).toBe(true);
    now = T0 + PAUSE_MS + 1;
    expect(budget.status().paused).toBe(false);
    await understand("what's Tesla at", {}, catalog.entries, intent);
    expect(bad.create).toHaveBeenCalledTimes(2);
  });

  it("a 'credit balance' error, a 401 and a 429 pause too; other errors don't", () => {
    expect(isBudgetError({ status: 400, message: "Your credit balance is too low to access the Anthropic API." })).toBe(true);
    expect(isBudgetError({ status: 400, error: { error: { message: "Your credit balance is too low" } } })).toBe(true);
    expect(isBudgetError({ status: 401 })).toBe(true);
    expect(isBudgetError({ status: 429 })).toBe(true);
    expect(isBudgetError({ status: 500, message: "overloaded" })).toBe(false);
    expect(isBudgetError(new Error("timeout"))).toBe(false);
  });

  it("the resolver pauses on a budget error and then answers from the dictionary", async () => {
    const budget = new LlmBudget(150, null, quiet, () => T0);
    const bad = failing({ status: 429, message: "rate limited" });
    const resolver = createLlmResolver({ apiKey: undefined, model: HAIKU, catalog: catalog.text, budget, cache: new ResolverCache(null), log: quiet, client: bad.client })!;
    await expect(resolver.resolve("first")).rejects.toBeDefined(); // /resolve turns this into "no matches"
    await expect(resolver.resolve("second")).resolves.toEqual([]);
    expect(bad.create).toHaveBeenCalledTimes(1);
  });
});

describe("visibility", () => {
  it("logs one line per call with purpose, model and tokens, and never the text or the key", async () => {
    const lines: string[] = [];
    const { client } = fakeClient({ mentions: [] }, { input_tokens: 900, output_tokens: 12 });
    await resolverWith(client, { log: (l) => lines.push(l) }).resolver.resolve("Secret page text about Acme");
    expect(lines).toEqual(["[llm] resolve claude-haiku-4-5 in=900 out=12"]);
  });

  it("files default to apps/api/.cache, memory only in tests", () => {
    expect(llmFiles(loadConfig({ NODE_ENV: "test" }))).toEqual({ cache: null, usage: null });
    const dev = llmFiles(loadConfig({ NODE_ENV: "development" }));
    expect(dev.cache).toMatch(/apps\/api\/\.cache\/resolver\.json$/);
    expect(dev.usage).toMatch(/apps\/api\/\.cache\/llm-usage\.json$/);
    expect(llmFiles(loadConfig({ NODE_ENV: "development", RESOLVER_CACHE_FILE: "" }))).toEqual({ cache: null, usage: null });
  });

  it("/health reports the models, the limit, calls used and whether Claude is paused", () => {
    expect(llmHealth(ctx)).toEqual({ models: { resolver: null, intent: null }, dailyLimit: 150, usedToday: 0, paused: false });
    const budget = new LlmBudget(5, null, quiet, () => T0);
    budget.tryAcquire();
    budget.failed({ status: 402 });
    const withClaude = { ...ctx, llm: {} as never, intentModel: {} as never, llmBudget: budget };
    expect(llmHealth(withClaude)).toEqual({ models: { resolver: HAIKU, intent: HAIKU }, dailyLimit: 5, usedToday: 1, paused: true });
  });
});
