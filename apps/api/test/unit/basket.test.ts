/**
 * Baskets: the plan (weights, rounding to the cent, the remainder to the largest leg), weights validation, the legs'
 * preflight together (one failing leg; the rest against the cap left), one signature over every leg (tamper, replay),
 * sequential execution with local nonces (a nonce error re-read once; a revert stops the basket with a partial
 * report), the job routes, and the voice rules. Fakes only: generated keys, a fake clock, a fake chain.
 */
import { resolve } from "node:path";

import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { basketProblems, BUILT_IN_BASKETS, equalWeights, parseSplit, planBasket, toCents } from "@glance/core/basket";
import { basketTypedData, bodyHash, SESSION_HEADERS } from "@glance/core/session";

import { createApp } from "../../src/app.js";
import { combineLegs, executeLegs, type LegExecutor, type LegQuote, type LegResult } from "../../src/basket.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { ApiError } from "../../src/services.js";
import { createTradeAuth } from "../../src/tradeAuth.js";
import { rulesIntent, understand, validateIntent } from "../../src/voice/intent.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const ctx = createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" }), () => {});
const catalog = ctx.catalog.entries;

const NOW = 1_790_000_000;
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const ALLOWED = ["TSLA", "AMZN", "AMD", "NFLX", "PLTR"];

describe("the plan", () => {
  it("equal weights sum to 100% (the first legs take the leftover basis points)", () => {
    expect(equalWeights(["A", "B", "C"]).map((l) => l.weightBps)).toEqual([3334, 3333, 3333]);
    expect(BUILT_IN_BASKETS[0]!.legs.map((l) => l.weightBps)).toEqual([2000, 2000, 2000, 2000, 2000]);
  });

  it("each leg is total x weight, rounded down to the cent; the remainder goes to the largest leg", () => {
    expect(planBasket("30", BUILT_IN_BASKETS[0]!.legs).map((l) => l.amount)).toEqual(["6.00", "6.00", "6.00", "6.00", "6.00"]);
    // $10 in thirds: 3.33 each, 1 cent left, to the largest (the first, 3334 bps).
    expect(planBasket("10", equalWeights(["A", "B", "C"])).map((l) => l.amount)).toEqual(["3.34", "3.33", "3.33"]);
    // 70/30 of $0.99: 0.69 and 0.29 -> 1 cent left to the 70% leg.
    expect(planBasket("0.99", [{ symbol: "A", weightBps: 3000 }, { symbol: "B", weightBps: 7000 }]).map((l) => l.amount)).toEqual(["0.29", "0.70"]);
    // The legs always add up to the total exactly.
    for (const total of ["1", "7.77", "12.34", "100", "999.99"]) {
      const cents = planBasket(total, equalWeights(["A", "B", "C", "D", "E", "F", "G"])).reduce((s, l) => s + toCents(l.amount)!, 0n);
      expect(cents).toBe(toCents(total));
    }
  });

  it("refuses a total that isn't dollars and cents", () => {
    for (const bad of ["0", "-5", "1.234", "ten", ""]) expect(() => planBasket(bad, equalWeights(["A"]))).toThrow();
    expect(toCents("$12.5")).toBe(1250n);
  });

  it("weights validation: 100%, no duplicates, only tokens the vault allows, a name", () => {
    expect(basketProblems(BUILT_IN_BASKETS[0]!, ALLOWED)).toEqual([]);
    expect(basketProblems({ name: "EV", legs: [{ symbol: "TSLA", weightBps: 5000 }, { symbol: "AMD", weightBps: 4000 }] }, ALLOWED)).toEqual(["The weights add up to 90%, not 100%."]);
    expect(basketProblems({ name: "EV", legs: [{ symbol: "TSLA", weightBps: 5000 }, { symbol: "TSLA", weightBps: 5000 }] }, ALLOWED)).toEqual(["TSLA is in the basket twice."]);
    expect(basketProblems({ name: "X", legs: [{ symbol: "AAPL", weightBps: 10_000 }] }, ALLOWED)).toEqual(["Your vault can't buy AAPL."]);
    expect(basketProblems({ name: " ", legs: [] }, ALLOWED)).toEqual(["Give the basket a name.", "Add at least one stock."]);
    expect(basketProblems({ name: "Z", legs: [{ symbol: "TSLA", weightBps: 0 }, { symbol: "AMD", weightBps: 10_000 }] }, ALLOWED)).toContain("TSLA's weight must be more than 0%.");
  });

  it("splits: \"50/50\", \"60 40\"; anything that doesn't fit the legs or 100% is null", () => {
    expect(parseSplit("50/50", 2)).toEqual([5000, 5000]);
    expect(parseSplit("60 40", 2)).toEqual([6000, 4000]);
    expect(parseSplit("50/50", 3)).toBeNull();
    expect(parseSplit("60/60", 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

const USDG = (n: number) => String(BigInt(Math.round(n * 100)) * 10n ** 16n); // 18 decimals
const ok = (symbol: string, usd: number): LegQuote =>
  ({ symbol, amountIn: { raw: USDG(usd) }, price: { value: "100" }, preflight: { ok: true }, _call: { args: [symbol] } }) as unknown as LegQuote;
const refused = (symbol: string, usd: number, guardCode: string, message: string): LegQuote =>
  ({ symbol, amountIn: { raw: USDG(usd) }, price: { value: "100" }, preflight: { ok: false, guard: { code: guardCode, message } }, _call: { args: [symbol] } }) as unknown as LegQuote;
const vaultFacts = (capLeft: number, usdg: number) => ({ usdg: { decimals: 18 }, buyWindow: { remaining: { raw: USDG(capLeft) } }, balances: { usdg: { raw: USDG(usdg) } } });
const req = (legs: Array<[string, string]>) => ({ vault: VAULT, legs: legs.map(([symbol, amount]) => ({ symbol, amount })) });

describe("preflight, every leg", () => {
  it("one failing leg says why and gets no call; the others pass; the cap left after counts only the passing legs", () => {
    const r = combineLegs(
      req([["TSLA", "10"], ["AMD", "10"], ["NFLX", "10"]]),
      [ok("TSLA", 10), refused("AMD", 10, "StalePrice", "AMD's price is too old to trade on."), ok("NFLX", 10)],
      vaultFacts(100, 500),
    );
    expect(r.legs.map((l) => [l.symbol, l.ok, l.reason ?? null])).toEqual([
      ["TSLA", true, null],
      ["AMD", false, "AMD's price is too old to trade on."],
      ["NFLX", true, null],
    ]);
    expect(r.passing).toBe(2);
    expect(r.calls.map((c) => c !== null)).toEqual([true, false, true]);
    expect(r.capLeft).toBe("$100");
    expect(r.capLeftAfter).toBe("$80");
  });

  it("a leg the quote refused outright (e.g. a token the vault doesn't allow) is a failing leg, not an error", () => {
    const r = combineLegs(req([["TSLA", "5"], ["PLTR", "5"]]), [ok("TSLA", 5), { error: new ApiError(422, "TOKEN_NOT_ALLOWED", "Your vault can't buy PLTR.") }], vaultFacts(100, 100));
    expect(r.legs[1]).toMatchObject({ ok: false, code: "TOKEN_NOT_ALLOWED", reason: "Your vault can't buy PLTR." });
  });

  it("the rolling buy cap across all legs combined: the leg that would go past it fails", () => {
    const r = combineLegs(req([["TSLA", "30"], ["AMD", "30"], ["NFLX", "30"]]), [ok("TSLA", 30), ok("AMD", 30), ok("NFLX", 30)], vaultFacts(70, 500));
    expect(r.legs.map((l) => l.code ?? "ok")).toEqual(["ok", "ok", "BASKET_DAILY_CAP"]);
    expect(r.capLeftAfter).toBe("$10");
  });

  it("the vault's USDG, across all legs", () => {
    const r = combineLegs(req([["TSLA", "30"], ["AMD", "30"]]), [ok("TSLA", 30), ok("AMD", 30)], vaultFacts(500, 45));
    expect(r.legs.map((l) => l.code ?? "ok")).toEqual(["ok", "BASKET_NO_USDG"]);
  });

  it("\"buy the rest\": the same basket without the failing leg passes whole", () => {
    const quotes = [ok("TSLA", 10), refused("AMD", 10, "StalePrice", "stale"), ok("NFLX", 10)];
    const first = combineLegs(req([["TSLA", "10"], ["AMD", "10"], ["NFLX", "10"]]), quotes, vaultFacts(100, 500));
    const rest = req(first.legs.filter((l) => l.ok).map((l) => [l.symbol, l.amount]));
    expect(rest.legs.map((l) => l.symbol)).toEqual(["TSLA", "NFLX"]);
    const again = combineLegs(rest, [quotes[0]!, quotes[2]!], vaultFacts(100, 500));
    expect(again.passing).toBe(again.legs.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const linked = privateKeyToAccount(generatePrivateKey());
const auth = () =>
  createTradeAuth({
    sessions: { status: (_v, key) => (key.toLowerCase() === linked.address.toLowerCase() ? { linked: true, expiresAt: NOW + 86_400, linkedAt: NOW } : { linked: false, reason: "unknown" }) },
    chainId: 46_630,
    openDemoVaults: [],
    demoTradesPerHour: 10,
    now: () => NOW,
    log: () => {},
  });

type Legs = Array<{ symbol: string; amount: string }>;
async function signedBasket(key: PrivateKeyAccount, legs: Legs, o: { nonce?: bigint; signedLegs?: Legs } = {}) {
  const body = { vault: VAULT, legs };
  const raw = JSON.stringify(body);
  const nonce = o.nonce ?? 0xbeefn;
  const deadline = NOW + 30;
  const signature = await key.signTypedData(
    basketTypedData({ vault: VAULT, legs: (o.signedLegs ?? legs).map((l) => ({ token: l.symbol, amount: l.amount, side: "buy" })), maxSlippageBps: 0, deadline: BigInt(deadline), requestNonce: nonce, bodyHash: bodyHash(raw) }),
  );
  const headers: Record<string, string> = {
    [SESSION_HEADERS.session]: key.address,
    [SESSION_HEADERS.signature]: signature,
    [SESSION_HEADERS.deadline]: String(deadline),
    [SESSION_HEADERS.nonce]: `0x${nonce.toString(16)}`,
  };
  return { raw, fields: { vault: VAULT, legs: legs.map((l) => ({ ...l, side: "buy" as const })) }, headers, header: (n: string) => headers[n], ip: "203.0.113.7" };
}
async function code(p: Promise<unknown>) {
  try {
    await p;
    return "passed";
  } catch (err) {
    return (err as { code: string }).code;
  }
}
const legs: Legs = [
  { symbol: "TSLA", amount: "15.00" },
  { symbol: "AMD", amount: "15.00" },
];

describe("one signature over every leg", () => {
  it("a basket signed by the linked session passes", async () => {
    expect(await auth().checkBasket(await signedBasket(linked, legs))).toEqual({ via: "session", session: linked.address });
  });

  it("a leg changed after signing (the signed legs differ from the body): BAD_SIGNATURE", async () => {
    const r = await signedBasket(linked, legs, { signedLegs: [legs[0]!, { symbol: "AMD", amount: "1.00" }] });
    expect(await code(auth().checkBasket(r))).toBe("BAD_SIGNATURE");
    const tampered = await signedBasket(linked, legs);
    expect(await code(auth().checkBasket({ ...tampered, raw: tampered.raw.replace("15.00", "95.00") }))).toBe("BAD_SIGNATURE");
  });

  it("the same basket request twice: REPLAYED", async () => {
    const a = auth();
    const r = await signedBasket(linked, legs);
    await a.checkBasket(r);
    expect(await code(a.checkBasket(r))).toBe("REPLAYED");
  });

  it("a single-trade signature can't be passed off as a basket (different type): BAD_SIGNATURE", async () => {
    const r = await signedBasket(linked, legs);
    const asTrade = { raw: r.raw, fields: { vault: VAULT, symbol: "TSLA", side: "buy" as const, amount: "15.00" }, header: r.header, ip: r.ip };
    expect(await code(auth().check(asTrade))).toBe("BAD_SIGNATURE");
  });

  it("POST /trade/basket without a session: SESSION_REQUIRED, nothing sent", async () => {
    const app = createApp(ctx);
    const res = await app.request("/trade/basket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault: VAULT, legs }) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("SESSION_REQUIRED");
  });

  it("polling a basket's progress doesn't count against the trade limit; sending still does", async () => {
    const app = createApp(createContext(loadConfig({ NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "", TRADE_RATE_LIMIT_PER_MINUTE: "2" }), () => {}));
    for (let i = 0; i < 15; i++) expect((await app.request("/trade/basket/0123456789abcdef0123456789abcdef")).status).toBe(404);
    const post = () => app.request("/trade/basket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault: VAULT, legs }) });
    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(429);
  });

  it("GET /trade/basket/:jobId for an unknown job: 404", async () => {
    expect((await createApp(ctx).request("/trade/basket/0123456789abcdef0123456789abcdef")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** A fake chain: records each send with its nonce; scripted errors and reverts. */
function fakeChain(o: { pending?: number[]; sendErrors?: Record<number, string[]>; revertAt?: number; refuseAt?: number } = {}) {
  const sent: Array<{ leg: number; nonce: number }> = [];
  const pending = [...(o.pending ?? [7])];
  let reads = 0;
  const x: LegExecutor = {
    pendingNonce: async () => {
      reads++;
      return pending.length > 1 ? pending.shift()! : pending[0]!;
    },
    prepare: async (i) => {
      if (i === o.refuseAt) throw new Error("refused");
      return i;
    },
    send: async (prepared, nonce) => {
      const i = prepared as number;
      const err = o.sendErrors?.[i]?.shift();
      if (err) throw new Error(err);
      sent.push({ leg: i, nonce });
      return `0x${String(i).padStart(64, "0")}` as Hex;
    },
    receipt: async (i) => (i === o.revertAt ? { status: "reverted", reason: "The price moved past your slippage limit." } : { status: "success", got: `0.1 LEG${i}` }),
    explain: () => "The vault refused it.",
    explorerUrl: (h) => `https://explorer.example/tx/${h}`,
  };
  return { x, sent, reads: () => reads };
}
const three = [
  { symbol: "TSLA", amount: "10.00" },
  { symbol: "AMD", amount: "10.00" },
  { symbol: "NFLX", amount: "10.00" },
];

describe("sequential execution", () => {
  it("reads the pending nonce once and numbers the legs +1 each, in order, with progress as each lands", async () => {
    const c = fakeChain({ pending: [7] });
    const seen: LegResult[][] = [];
    const r = await executeLegs(three, c.x, (p) => seen.push(p));
    expect(r.complete).toBe(true);
    expect(c.sent).toEqual([
      { leg: 0, nonce: 7 },
      { leg: 1, nonce: 8 },
      { leg: 2, nonce: 9 },
    ]);
    expect(c.reads()).toBe(1);
    expect(r.results.map((l) => [l.status, l.got])).toEqual([
      ["done", "0.1 LEG0"],
      ["done", "0.1 LEG1"],
      ["done", "0.1 LEG2"],
    ]);
    // Leg 1 was "sending" while leg 0 was already done.
    expect(seen.some((p) => p[0]!.status === "done" && p[1]!.status === "sending" && p[2]!.status === "waiting")).toBe(true);
  });

  it("a nonce error re-reads the pending nonce and retries that leg once; the numbering continues from there", async () => {
    const c = fakeChain({ pending: [7, 12], sendErrors: { 1: ["nonce too low: next nonce 12, tx nonce 8"] } });
    const r = await executeLegs(three, c.x, () => {});
    expect(r.complete).toBe(true);
    expect(c.sent).toEqual([
      { leg: 0, nonce: 7 },
      { leg: 1, nonce: 12 },
      { leg: 2, nonce: 13 },
    ]);
    expect(c.reads()).toBe(2);
  });

  it("a second nonce error on the same leg stops the basket (retried once only)", async () => {
    const c = fakeChain({ sendErrors: { 0: ["nonce too low", "nonce too low"] } });
    const r = await executeLegs(three, c.x, () => {});
    expect(r.complete).toBe(false);
    expect(c.sent).toEqual([]);
    expect(r.results.map((l) => l.status)).toEqual(["not-sent", "not-sent", "not-sent"]);
  });

  it("a revert stops the basket, is never retried, and the report says which legs went through", async () => {
    const c = fakeChain({ revertAt: 1 });
    const r = await executeLegs(three, c.x, () => {});
    expect(r.complete).toBe(false);
    expect(c.sent.map((s) => s.leg)).toEqual([0, 1]); // leg 1 sent once, leg 2 never
    expect(r.results.map((l) => l.status)).toEqual(["done", "reverted", "not-sent"]);
    expect(r.results[0]!.explorerUrl).toMatch(/^https:\/\/explorer\.example\/tx\/0x/);
    expect(r.results[1]).toMatchObject({ reason: "The price moved past your slippage limit." });
    expect(r.results[1]!.txHash).toBeDefined();
    expect(r.results[2]!.reason).toBe("Not sent: the basket stopped at an earlier leg.");
  });

  it("a leg the vault would refuse now is not sent, and the basket stops there", async () => {
    const c = fakeChain({ refuseAt: 0 });
    const r = await executeLegs(three, c.x, () => {});
    expect(c.sent).toEqual([]);
    expect(r.results.map((l) => l.status)).toEqual(["not-sent", "not-sent", "not-sent"]);
    expect(r.results[0]!.reason).toBe("The vault refused it.");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("voice: baskets, rules first", () => {
  const intentOf = (said: string) => validateIntent(rulesIntent(said, catalog), said, catalog);

  it.each([
    ["buy $30 of the tech basket", "basket-buy", "30"],
    ["please buy thirty dollars of the Tech basket", "basket-buy", "30"],
    ["make a basket called EV with Tesla and AMD, 50/50", "basket-make", null],
    ["create a basket called chips with AMD and Nvidia", "basket-make", null],
    ["show my baskets", "baskets", null],
    ["my baskets", "baskets", null],
  ])("%s -> %s", (said, intent, amount) => {
    const got = intentOf(said);
    expect(got.intent).toBe(intent);
    expect(got.amount).toBe(amount);
    expect(got.symbol).toBeNull();
  });

  it("selling a basket as one isn't offered: the reply asks for the stock by name", async () => {
    const got = intentOf("sell my tech basket");
    expect(got.intent).toBe("sell");
    const { replyFor } = await import("../../src/voice/routes.js");
    expect((await replyFor(ctx, got, {})).reply).toBe("I can't sell a basket as one. Name the stock instead, like “sell all my Tesla”.");
  });

  it("never a basket buy from a negation or a question", () => {
    expect(intentOf("don't buy the tech basket").intent).not.toBe("basket-buy");
    expect(intentOf("should I buy the tech basket?").intent).not.toBe("basket-buy");
  });

  it("the rules decide baskets with no Claude call", async () => {
    let called = false;
    const model = {
      model: "fake",
      classify: async () => {
        called = true;
        return { intent: "unknown" as const, symbol: null, amount: null, source: "claude" as const };
      },
    };
    expect((await understand("show my baskets", {}, catalog, model)).intent).toBe("baskets");
    expect(called).toBe(false);
  });
});
