/**
 * The Claude budget: Haiku only (Opus refused unless ALLOW_OPUS), per-purpose daily budgets under the total with their
 * UTC reset, the batched company-name lookup and its 7-day cache, and the one-hour pause after a budget error. A fake
 * client stands in for Anthropic: no test touches the network.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext, llmFiles } from "../../src/context.js";
import { createLlmResolver, looksLikeCompanyName, MAX_NAMES, selectCandidates, type MessagesClient } from "../../src/llm.js";
import { chooseModel, HAIKU, isBudgetError, LlmBudget, MAX_OUTPUT_TOKENS, NAME_CACHE_TTL_MS, NameCache, normalizeName, PAUSE_MS, type BudgetLimits } from "../../src/llmBudget.js";
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

function resolverWith(client: MessagesClient, opts: { limit?: number | BudgetLimits; cacheFile?: string | null; usageFile?: string | null; now?: () => number; log?: (l: string) => void } = {}) {
  const now = opts.now ?? (() => T0);
  const budget = new LlmBudget(opts.limit ?? 150, opts.usageFile ?? null, opts.log ?? quiet, now);
  const cache = new NameCache(opts.cacheFile ?? null, now);
  const resolver = createLlmResolver({ apiKey: undefined, model: HAIKU, catalog: catalog.text, budget, cache, log: opts.log ?? quiet, client })!;
  return { resolver, budget, cache };
}

describe("models", () => {
  it("defaults every Claude call to Haiku, including the old ANTHROPIC_MODEL name", () => {
    const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE }), quiet);
    expect(c.llmModels).toEqual({ resolver: HAIKU, intent: HAIKU, why: HAIKU, other: HAIKU });
    expect(HAIKU).toBe("claude-haiku-4-5");
  });

  it("refuses Opus without ALLOW_OPUS, with one warning line, and uses Haiku", () => {
    const log = vi.fn();
    expect(chooseModel("claude-opus-5", false, "resolver", log)).toBe(HAIKU);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/resolver model "claude-opus-5" refused/);
    const lines: string[] = [];
    const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, ANTHROPIC_MODEL: "claude-opus-5", INTENT_MODEL: "claude-opus-4-7", WHY_MODEL: "claude-opus-5" }), (l) => lines.push(l));
    expect(c.llmModels).toEqual({ resolver: HAIKU, intent: HAIKU, why: HAIKU, other: HAIKU });
    expect(lines.filter((l) => l.includes("refused"))).toHaveLength(3);
    // RESOLVER_MODEL wins over the old name.
    expect(createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, RESOLVER_MODEL: "claude-sonnet-5", ANTHROPIC_MODEL: "claude-opus-5" }), quiet).llmModels.resolver).toBe("claude-sonnet-5");
  });

  it("allows Opus only with ALLOW_OPUS=1", () => {
    expect(chooseModel("claude-opus-5", true, "resolver", quiet)).toBe("claude-opus-5");
    const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, RESOLVER_MODEL: "claude-opus-5", ALLOW_OPUS: "1" }), quiet);
    expect(c.llmModels.resolver).toBe("claude-opus-5");
  });

  it("asks for small answers only", async () => {
    const { client, create } = fakeClient({ listed: [] });
    await resolverWith(client).resolver.resolveNames(["Acme Widgets"]);
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ model: HAIKU, max_tokens: MAX_OUTPUT_TOKENS });
    expect(MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(256);
  });
});

/** Default budgets, as in the environment's defaults. */
const DEFAULTS: BudgetLimits = { total: 250, perPurpose: { resolver: 40, intent: 80, why: 60, other: 70 } };

describe("company lookup: one call per glance", () => {
  it("sends every unresolved candidate in one call, and maps answers back by index", async () => {
    const { client, create } = fakeClient({ listed: [{ index: 2, symbol: "TSLA" }, { index: 3, symbol: "NOPE" }] });
    const { resolver } = resolverWith(client);
    const out = await resolver.resolveNames(["Acme Widgets", "Tesla Motors", "Initech", "Tesla motors"]);
    expect(create).toHaveBeenCalledTimes(1);
    const sent = (create.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }])[0].messages[0]!.content;
    expect(sent).toBe("1. Acme Widgets\n2. Tesla Motors\n3. Initech"); // deduplicated
    expect(out).toEqual([
      { name: "Acme Widgets", symbol: null, source: "llm" },
      { name: "Tesla Motors", symbol: "TSLA", source: "llm" },
      { name: "Initech", symbol: null, source: "llm" }, // not a catalog symbol: dropped
    ]);
  });

  it("caps a glance at MAX_NAMES names and skips anything that doesn't look like a company", async () => {
    const { client, create } = fakeClient({ listed: [] });
    const many = Array.from({ length: 70 }, (_, i) => `Company${i} Holdings`);
    const out = await resolverWith(client).resolver.resolveNames(["the", "Monday", "lowercase words", "$%^", "x", ...many]);
    expect(MAX_NAMES).toBe(40);
    expect(out).toHaveLength(40);
    expect(out[0]!.name).toBe("Company0 Holdings");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("recognises company-like names", () => {
    for (const ok of ["Tesla", "Palantir Technologies", "AT&T", "Berkshire Hathaway Inc.", "3M", "McDonald's"]) expect(looksLikeCompanyName(ok)).toBe(true);
    for (const no of ["the", "The", "Monday", "tesla", "a very long sentence that goes on and on", "Reuters", "!!", "12"]) expect(looksLikeCompanyName(no)).toBe(false);
    expect(selectCandidates(["Apple", "apple", "The Apple", "Apple's"])).toEqual(["Apple"]);
  });

  it("makes no call when there is nothing new to ask", async () => {
    const { client, create } = fakeClient({ listed: [] });
    const { resolver } = resolverWith(client);
    expect(await resolver.resolveNames([])).toEqual([]);
    expect(await resolver.resolveNames(["the", "Monday"])).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("routes", () => {
  const post = async (app: ReturnType<typeof createApp>, path: string, body: unknown) => {
    const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it("POST /resolve (every page load and DOM change) uses the dictionary only: never Claude", async () => {
    const { client, create } = fakeClient({ listed: [{ index: 1, symbol: "TSLA" }] });
    const { resolver } = resolverWith(client);
    const app = createApp({ ...ctx, llm: resolver });
    const none = await post(app, "/resolve", { text: "Acme Widgets and Initech posted results." });
    expect(none.body).toMatchObject({ source: "none", count: 0 });
    const dict = await post(app, "/resolve", { text: "Shares of Tesla rose." });
    expect(dict.body).toMatchObject({ source: "dictionary", count: 1 });
    expect(create).not.toHaveBeenCalled();
  });

  it("POST /resolve/names (a glance) makes one Claude call for every name, and answers with catalog entries", async () => {
    const { client, create } = fakeClient({ listed: [{ index: 2, symbol: "TSLA" }] });
    const { resolver } = resolverWith(client);
    const app = createApp({ ...ctx, llm: resolver });
    const res = await post(app, "/resolve/names", { names: ["Acme Widgets", "Tesla Motors", "Initech"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ asked: 3, count: 1, names: [{ name: "Tesla Motors", symbol: "TSLA", source: "llm", stock: { symbol: "TSLA" } }] });
    expect(create).toHaveBeenCalledTimes(1);
    // Without Claude: nothing asked, no error.
    expect((await post(createApp(ctx), "/resolve/names", { names: ["Tesla Motors"] })).body).toEqual({ asked: 0, count: 0, names: [] });
  });
});

describe("name cache", () => {
  it("a cached name makes no API call, however it's spaced or cased", async () => {
    const { client, create } = fakeClient({ listed: [{ index: 1, symbol: "TSLA" }] });
    const { resolver } = resolverWith(client);
    await resolver.resolveNames(["Tesla Motors"]);
    expect(await resolver.resolveNames(["  TESLA   motors ", "Tesla Motors's"])).toEqual([{ name: "TESLA motors", symbol: "TSLA", source: "cache" }]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("caches 'not listed' too, and only asks about new names", async () => {
    const { client, create } = fakeClient({ listed: [] });
    const { resolver } = resolverWith(client);
    await resolver.resolveNames(["Acme Widgets", "Initech"]);
    await resolver.resolveNames(["Acme Widgets", "Initech", "Globex"]);
    expect(create).toHaveBeenCalledTimes(2);
    const second = (create.mock.calls[1] as unknown as [{ messages: Array<{ content: string }> }])[0].messages[0]!.content;
    expect(second).toBe("1. Globex");
    await resolver.resolveNames(["Globex", "Acme Widgets"]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("survives a restart through its file, keyed by hash (no names on disk), for 7 days", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glance-llm-"));
    const cacheFile = join(dir, "resolver-names.json");
    let now = T0;
    const clock = () => now;
    const one = fakeClient({ listed: [] });
    await resolverWith(one.client, { cacheFile, now: clock }).resolver.resolveNames(["Acme Widgets"]);
    expect(readFileSync(cacheFile, "utf8")).not.toMatch(/acme/i);

    now = T0 + NAME_CACHE_TTL_MS - 1; // six days and change later, after a restart: still cached
    const two = fakeClient({ listed: [] });
    await resolverWith(two.client, { cacheFile, now: clock }).resolver.resolveNames(["ACME widgets"]);
    expect(two.create).not.toHaveBeenCalled();

    now = T0 + NAME_CACHE_TTL_MS + 1; // a week later: asked again
    const three = fakeClient({ listed: [] });
    await resolverWith(three.client, { cacheFile, now: clock }).resolver.resolveNames(["Acme Widgets"]);
    expect(three.create).toHaveBeenCalledTimes(1);
    expect(NAME_CACHE_TTL_MS).toBe(7 * 24 * 3_600_000);
  });

  it("normalizes case, whitespace, a leading 'the', possessives and trailing punctuation", () => {
    expect(normalizeName("  The Tesla\n\tInc's. ")).toBe("tesla inc");
    expect(new NameCache(null).get("anything")).toBeUndefined();
  });
});

describe("per-purpose budgets", () => {
  it("defaults: 250 in total; resolver 40, intent 80, why 60, other 70", () => {
    const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE }), quiet);
    expect(c.llmBudget.limits).toEqual(DEFAULTS);
    const set = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, LLM_DAILY_CALL_LIMIT: "10", LLM_BUDGET_RESOLVER: "1", LLM_BUDGET_INTENT: "2", LLM_BUDGET_WHY: "3", LLM_BUDGET_OTHER: "4" }), quiet);
    expect(set.llmBudget.limits).toEqual({ total: 10, perPurpose: { resolver: 1, intent: 2, why: 3, other: 4 } });
  });

  it("when the resolver's budget is used up only the resolver falls back (to the dictionary); intent keeps using Claude", async () => {
    const log = vi.fn();
    const limits: BudgetLimits = { total: 250, perPurpose: { resolver: 1, intent: 80, why: 60, other: 70 } };
    const budget = new LlmBudget(limits, null, log, () => T0);
    const r = fakeClient({ listed: [] });
    const resolver = createLlmResolver({ apiKey: undefined, model: HAIKU, catalog: catalog.text, budget, cache: new NameCache(null), log: quiet, client: r.client })!;
    const i = fakeClient({ intent: "price", symbol: "TSLA", amount: null, reply: null });
    const intent = createClaudeIntent(undefined, HAIKU, catalog.entries, 3_000, { budget, client: i.client, log: quiet })!;
    await resolver.resolveNames(["Acme Widgets"]);
    expect(await resolver.resolveNames(["Initech", "Globex"])).toEqual([
      { name: "Initech", symbol: null, source: "none" },
      { name: "Globex", symbol: null, source: "none" },
    ]);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(await understand("Tesla, thoughts on where that's sitting", {}, catalog.entries, intent)).toMatchObject({ source: "claude" }); // the rules can't read it: Claude
    expect(i.create).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter(([l]) => l === "[llm] resolver budget reached (1 today), using the dictionary")).toHaveLength(1);
    // Nothing was cached for the names that weren't asked: tomorrow's glance may ask about them.
    expect(budget.status().byPurpose).toMatchObject({ resolver: { used: 1, limit: 1 }, intent: { used: 1, limit: 80 } });
  });

  it("when intent's budget is used up, intents use the rules; the resolver keeps working", async () => {
    const budget = new LlmBudget({ total: 250, perPurpose: { resolver: 40, intent: 0, why: 60, other: 70 } }, null, quiet, () => T0);
    const i = fakeClient({ intent: "unknown", symbol: null, amount: null, reply: "?" });
    const intent = createClaudeIntent(undefined, HAIKU, catalog.entries, 3_000, { budget, client: i.client, log: quiet })!;
    expect(await understand("buy ten dollars of Tesla", {}, catalog.entries, intent)).toMatchObject({ intent: "buy", symbol: "TSLA", amount: "10", source: "rules" });
    expect(i.create).not.toHaveBeenCalled();
    expect(budget.tryAcquire("resolver")).toBe(true);
    expect(budget.tryAcquire("why")).toBe(true);
  });

  it("the total ceiling still applies across purposes", () => {
    const log = vi.fn();
    const budget = new LlmBudget({ total: 3, perPurpose: { resolver: 40, intent: 80, why: 60, other: 70 } }, null, log, () => T0);
    expect([budget.tryAcquire("resolver"), budget.tryAcquire("intent"), budget.tryAcquire("why"), budget.tryAcquire("other")]).toEqual([true, true, true, false]);
    expect(log).toHaveBeenCalledWith("[llm] LLM daily limit reached, using rules");
  });

  it("records the purpose of every call in the usage file, and reads older files without it", () => {
    const dir = mkdtempSync(join(tmpdir(), "glance-llm-"));
    const usage = join(dir, "llm-usage.json");
    const b = new LlmBudget(DEFAULTS, usage, quiet, () => T0);
    b.tryAcquire("resolver");
    b.tryAcquire("intent");
    b.tryAcquire("intent");
    b.tryAcquire("why");
    expect(JSON.parse(readFileSync(usage, "utf8"))).toMatchObject({ day: "2026-09-24", used: 4, byPurpose: { resolver: 1, intent: 2, why: 1, other: 0 } });
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ day: "2026-09-24", used: 150, pausedUntil: 0 }));
    expect(new LlmBudget(DEFAULTS, old, quiet, () => T0).status()).toMatchObject({ usedToday: 150, byPurpose: { resolver: { used: 0 } } });
  });
});

describe("daily limit", () => {
  it("at the limit, the lookup answers with the dictionary (no matches) and never errors, logging one line", async () => {
    const log = vi.fn();
    const { client, create } = fakeClient({ listed: [] });
    const { resolver, budget } = resolverWith(client, { limit: 2, log });
    await resolver.resolveNames(["Name One"]);
    await resolver.resolveNames(["Name Two"]);
    await expect(resolver.resolveNames(["Name Three"])).resolves.toEqual([{ name: "Name Three", symbol: null, source: "none" }]);
    await expect(resolver.resolveNames(["Name Four"])).resolves.toEqual([{ name: "Name Four", symbol: null, source: "none" }]);
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

  it("counts every Claude call across the API: resolver and intent share the total", async () => {
    const budget = new LlmBudget(2, null, quiet, () => T0);
    const r = fakeClient({ listed: [] });
    const resolver = createLlmResolver({ apiKey: undefined, model: HAIKU, catalog: catalog.text, budget, cache: new NameCache(null), log: quiet, client: r.client })!;
    const i = fakeClient({ intent: "price", symbol: "TSLA", amount: null, reply: null });
    const intent = createClaudeIntent(undefined, HAIKU, catalog.entries, 3_000, { budget, client: i.client, log: quiet })!;
    await resolver.resolveNames(["Acme"]);
    await understand("Tesla, thoughts on where that's sitting", {}, catalog.entries, intent);
    await understand("Tesla, thoughts on where that's sitting", {}, catalog.entries, intent); // over the limit: rules
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
    const first = await understand("Tesla, thoughts on where that's sitting", {}, catalog.entries, intent);
    expect(first).toMatchObject({ intent: "unknown", source: "rules" });
    expect(budget.status().paused).toBe(true);
    await understand("Tesla, thoughts on where that's sitting", {}, catalog.entries, intent);
    expect(bad.create).toHaveBeenCalledTimes(1); // paused: not asked again
    expect(log.mock.calls.some(([l]) => /pausing Claude for 1 hour/.test(l))).toBe(true);
    now = T0 + PAUSE_MS + 1;
    expect(budget.status().paused).toBe(false);
    await understand("Tesla, thoughts on where that's sitting", {}, catalog.entries, intent);
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

  it("the resolver pauses on a budget error and then answers from the dictionary, caching nothing", async () => {
    const budget = new LlmBudget(150, null, quiet, () => T0);
    const bad = failing({ status: 429, message: "rate limited" });
    const cache = new NameCache(null);
    const resolver = createLlmResolver({ apiKey: undefined, model: HAIKU, catalog: catalog.text, budget, cache, log: quiet, client: bad.client })!;
    await expect(resolver.resolveNames(["First Co"])).resolves.toEqual([{ name: "First Co", symbol: null, source: "none" }]);
    await expect(resolver.resolveNames(["Second Co"])).resolves.toEqual([{ name: "Second Co", symbol: null, source: "none" }]);
    expect(cache.size).toBe(0);
    expect(bad.create).toHaveBeenCalledTimes(1);
  });
});

describe("visibility", () => {
  it("logs one line per call with purpose, model and tokens, and never the text or the key", async () => {
    const lines: string[] = [];
    const { client } = fakeClient({ listed: [] }, { input_tokens: 900, output_tokens: 12 });
    await resolverWith(client, { log: (l) => lines.push(l) }).resolver.resolveNames(["Secret Acme Name"]);
    expect(lines).toEqual(["[llm] resolver claude-haiku-4-5 in=900 out=12"]);
  });

  it("files default to apps/api/.cache, memory only in tests", () => {
    expect(llmFiles(loadConfig({ NODE_ENV: "test" }))).toEqual({ cache: null, usage: null });
    const dev = llmFiles(loadConfig({ NODE_ENV: "development" }));
    expect(dev.cache).toMatch(/apps\/api\/\.cache\/resolver-names\.json$/);
    expect(dev.usage).toMatch(/apps\/api\/\.cache\/llm-usage\.json$/);
    expect(llmFiles(loadConfig({ NODE_ENV: "development", RESOLVER_CACHE_FILE: "" }))).toEqual({ cache: null, usage: null });
  });

  it("/health reports the models, the limit, calls used and whether Claude is paused", () => {
    const zero = (limit: number) => ({ usedToday: 0, limit });
    expect(llmHealth(ctx)).toEqual({
      models: { resolver: null, intent: null, why: null, showme: null },
      dailyLimit: 250,
      usedToday: 0,
      byPurpose: { resolver: zero(40), intent: zero(80), why: zero(60), other: zero(70) },
      paused: false,
    });
    const budget = new LlmBudget(5, null, quiet, () => T0);
    budget.tryAcquire("why");
    budget.failed({ status: 402 });
    const withClaude = { ...ctx, llm: {} as never, intentModel: {} as never, llmBudget: budget, why: { ...ctx.why, summarizer: {} as never } };
    expect(llmHealth(withClaude)).toMatchObject({ models: { resolver: HAIKU, intent: HAIKU, why: HAIKU }, dailyLimit: 5, usedToday: 1, paused: true });
    expect(llmHealth(withClaude).byPurpose.why).toEqual({ usedToday: 1, limit: 5 });
  });
});
