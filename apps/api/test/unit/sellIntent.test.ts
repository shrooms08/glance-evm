/**
 * Selling by voice: what the intent step makes of a sell, and what Glance says back.
 *   "sell ten dollars of Tesla" (dollars), "sell all my Palantir", "sell half my Tesla" (part of the holding), a stock
 *   Glance doesn't trade, a basket, and a stock the vault holds none of. A fraction, like an amount, is only ever one the
 *   user said. Fakes only: a fake chain for the holding, a fake Claude.
 */
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { createClaudeIntent, rulesIntent, saidFraction, understand, validateIntent, type Intent } from "../../src/voice/intent.js";
import { replyFor } from "../../src/voice/routes.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
const catalog = ctx.catalog.entries;
const VAULT = "0x2222222222222222222222222222222222222222";

const intentOf = (said: string) => validateIntent(rulesIntent(said, catalog), said, catalog);

/** The same context, on a chain where the vault holds `held` shares of everything. */
function holding(held: bigint): AppContext {
  const c = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
  (c as { client: unknown }).client = { readContract: vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "balanceOf" ? held : 0n)) };
  return c;
}

describe("sell intents", () => {
  it("dollars: sell ten dollars of Tesla", () => {
    expect(intentOf("Sell ten dollars of Tesla")).toMatchObject({ intent: "sell", symbol: "TSLA", amount: "10" });
    expect(intentOf("sell $25 of AMD")).toMatchObject({ intent: "sell", symbol: "AMD", amount: "25" });
    expect(intentOf("please sell twenty five dollars worth of Amazon")).toMatchObject({ intent: "sell", symbol: "AMZN", amount: "25" });
  });

  it("all of it, or half: sell all my Palantir, sell half my Tesla", () => {
    expect(intentOf("Sell all my Palantir")).toMatchObject({ intent: "sell", symbol: "PLTR", amount: null, fraction: "1" });
    expect(intentOf("sell all of my Palantir shares")).toMatchObject({ intent: "sell", symbol: "PLTR", fraction: "1" });
    expect(intentOf("Sell half my Tesla")).toMatchObject({ intent: "sell", symbol: "TSLA", amount: null, fraction: "0.5" });
    expect(intentOf("sell everything in Netflix")).toMatchObject({ intent: "sell", symbol: "NFLX", fraction: "1" });
    // "get rid of" is a sell, never "get" (a buy).
    expect(intentOf("could you get rid of half of my Tesla")).toMatchObject({ intent: "sell", symbol: "TSLA", fraction: "0.5" });
  });

  it("no amount said: still a sell, and Glance asks how much", async () => {
    const got = intentOf("sell my Tesla");
    expect(got).toMatchObject({ intent: "sell", symbol: "TSLA", amount: null });
    expect(got.fraction).toBeUndefined();
    expect((await replyFor(ctx, got, {})).reply).toBe("Sure. How much Tesla should I sell? Say a dollar amount, all, or half.");
  });

  it("a stock Glance doesn't trade: not a sell, and it says so", async () => {
    const got = intentOf("sell all my Nokia");
    expect(got.intent).toBe("unknown");
    expect(got.symbol).toBeNull();
    expect(got.fraction).toBeUndefined();
    expect((await replyFor(ctx, got, {})).reply).toBe("I can't find that stock in Glance's list, so there's nothing I can sell. Try: sell all my Tesla.");
  });

  it("a stock the vault holds none of: said at once (and the card shows the same refusal)", async () => {
    const got = intentOf("sell all my Palantir");
    expect((await replyFor(holding(0n), got, {}, VAULT)).reply).toBe("You don't hold any Palantir in your vault, so there's nothing to sell.");
  });

  it("held: the reply names the sell, and the card checks it on chain", async () => {
    const some = holding(10n ** 18n);
    expect((await replyFor(some, intentOf("sell all my Palantir"), {}, VAULT)).reply).toBe("Selling all your Palantir. Let me check your limits first.");
    expect((await replyFor(some, intentOf("sell half my Tesla"), {}, VAULT)).reply).toBe("Selling half your Tesla. Let me check your limits first.");
    expect((await replyFor(some, intentOf("sell ten dollars of Tesla"), {}, VAULT)).reply).toBe("Selling $10 of Tesla. Let me check your limits first.");
  });

  it("a basket isn't sold as one: the reply asks for the stock", async () => {
    const got = intentOf("sell my Tech basket");
    expect(got).toMatchObject({ intent: "sell", symbol: null });
    expect((await replyFor(ctx, got, {})).reply).toBe("I can't sell a basket as one. Name the stock instead, like “sell all my Tesla”.");
  });

  it("never a sell from a negation, a question or the past", () => {
    for (const said of ["don't sell all my Tesla", "should I sell half my Tesla?", "I sold all my Palantir yesterday"]) {
      const got = intentOf(said);
      expect(got.intent, said).not.toBe("sell");
      expect(got.fraction, said).toBeUndefined();
    }
  });

  it("a fraction is only ever one the user said (all and half together is ambiguous: none)", () => {
    expect(saidFraction("sell all my Tesla")).toBe("1");
    expect(saidFraction("sell half my Tesla")).toBe("0.5");
    expect(saidFraction("sell half of all my Tesla")).toBeNull();
    const invented: Intent = { intent: "sell", symbol: "TSLA", amount: "10", fraction: "1", source: "claude" };
    const out = validateIntent(invented, "sell ten dollars of Tesla", catalog);
    expect(out.fraction).toBeUndefined();
    expect(out.amount).toBe("10");
    expect(out.note).toContain("fraction 1 was not said");
    // Never on a buy.
    expect(validateIntent({ ...invented, intent: "buy" }, "buy all of Tesla", catalog).fraction).toBeUndefined();
  });

  it("Claude's reading: all and half map to the holding's fraction, validated like the rules'", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "tool_use", id: "t", name: "record_intent", input: { intent: "sell", symbol: "TSLA", amount: null, fraction: "half", reply: null } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const model = createClaudeIntent(undefined, "claude-haiku-4-5-20251001", catalog, 3_000, { client: { messages: { create } } as never, log: () => {} })!;
    // Phrased so the rules can't decide it: Claude reads it.
    const got = await understand("Tesla, let half of it go", {}, catalog, model);
    expect(create).toHaveBeenCalledTimes(1);
    expect(got).toMatchObject({ intent: "sell", symbol: "TSLA", amount: null, fraction: "0.5", source: "claude" });
  });
});
