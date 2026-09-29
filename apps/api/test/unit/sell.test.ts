/**
 * Selling, end to end through the API, against a fake chain (no network, nothing sent: the "wallet" is a stub):
 *   - a sell by dollars (at the vault's oracle price), by half, or all of the holding becomes exact shares;
 *   - the quote carries the live price, the vault's price, the USDG back and what the vault holds;
 *   - every refusal, in the words the user hears: nothing held, the per-trade cap (market open and closed), the daily
 *     sell cap, more than the vault holds, and the drift guard;
 *   - the trade itself sends exactly the quoted shares through the vault's sell(), and reads the fill from Sold.
 */
import { resolve } from "node:path";

import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, ContractFunctionRevertedError, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { glanceVaultAbi } from "../../src/abi.generated.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { LiveQuotes } from "../../src/liveQuotes.js";
import { quoteView, stockBySymbol, tradeView } from "../../src/services.js";
import { FAKE_FINNHUB_KEY } from "../support/fake-keys.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const env = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };

const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const USDG = "0x3333333333333333333333333333333333333333" as Address;
const AGENT = "0x1111111111111111111111111111111111111111" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;
/** The chain's clock, shared by every test (the API caches the latest block for 1.5s). */
const NOW = Math.floor(Date.now() / 1000);
const E18 = 10n ** 18n;
const usd = (n: number) => BigInt(Math.round(n * 1e6));

interface Chain {
  /** TSLA shares the vault holds (raw, 18 decimals). */
  held: bigint;
  /** The oracle price in dollars (default $370). */
  oracle?: number;
  /** How old the oracle price is (default 3h: market open; 30h: closed). */
  ageHours?: number;
  /** A vault custom error the preflight simulation reverts with. */
  revert?: { name: string; args: readonly unknown[] };
  /** The live market price (default: none, so the drift guard can't block). */
  live?: number;
}

/** A context on a fake chain: the vault's fields, the desk's quote (0.3% spread), the feed and the holding. */
async function setup(o: Chain) {
  const ctx = createContext(loadConfig(env), () => {});
  const tsla = stockBySymbol(ctx, "TSLA");
  const oracle = BigInt(Math.round((o.oracle ?? 370) * 1e8));
  if (o.live !== undefined) {
    ctx.liveQuotes = new LiveQuotes({
      symbols: ["TSLA"],
      finnhubKey: FAKE_FINNHUB_KEY,
      fetch: (async () => Response.json({ c: o.live, t: NOW - 5 })) as unknown as typeof fetch,
      yahoo: async () => null,
      now: () => NOW * 1000,
      log: () => {},
    });
    await ctx.liveQuotes.refresh();
  }
  const vaultFields: Record<string, unknown> = {
    owner: "0x4444444444444444444444444444444444444444",
    agent: AGENT,
    agentExpiry: BigInt(NOW + 30 * 86_400),
    paused: false,
    perBuyCap: usd(100),
    dailyCap: usd(500),
    dailySellCap: usd(500),
    maxSlippageBps: 100,
    weekendCapBps: 2500,
    usdg: USDG,
    usdgDecimals: 6,
    spentInWindow: 0n,
    soldInWindow: 0n,
    approvedRouters: true,
    tokenConfig: [true, tsla.feed, 72_000, 345_600],
  };
  const readContract = vi.fn(async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    if (functionName === "latestRoundData") return [1n, oracle, 0n, BigInt(NOW - (o.ageHours ?? 3) * 3600), 1n];
    if (functionName === "decimals") return 8;
    if (functionName === "balanceOf") return address.toLowerCase() === tsla.token.toLowerCase() ? o.held : usd(40);
    // The desk: prices off the feed, 0.3% under it on a sell.
    if (functionName === "quoteSell") return ((args![1] as bigint) * oracle * 10n ** 6n * 9970n) / (10n ** 8n * E18 * 10_000n);
    if (functionName === "spreadBps") return 30n;
    if (functionName === "usdg") return USDG;
    if (functionName in vaultFields) return vaultFields[functionName];
    throw new Error(`unexpected read ${functionName}`);
  });
  const simulateContract = vi.fn(async (_req: { functionName: string; args: readonly unknown[] }) => {
    if (o.revert) {
      const data = encodeErrorResult({ abi: glanceVaultAbi, errorName: o.revert.name as never, args: o.revert.args as never });
      throw new ContractFunctionRevertedError({ abi: glanceVaultAbi, data, functionName: "sell" });
    }
    return { request: { functionName: _req.functionName, args: _req.args } };
  });
  const writeContract = vi.fn(async () => HASH);
  const client = {
    readContract,
    simulateContract,
    getCode: vi.fn(async () => "0x60"),
    // The chain's height, just past the deployment (reads of the vault's events start there).
    getBlock: vi.fn(async () => ({ number: BigInt(ctx.deployment.blockNumber) + 100n, timestamp: BigInt(NOW) })),
    getBlockNumber: vi.fn(async () => BigInt(ctx.deployment.blockNumber) + 100n),
    getLogs: vi.fn(async () => []),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 101n, logs: [soldLog(tsla.token, ctx.desks[0]!, o.held, oracle)] })),
  };
  (ctx as { client: unknown }).client = client;
  (ctx as { signer: unknown }).signer = { account: { address: AGENT }, exclusive: <T>(fn: () => Promise<T>) => fn(), wallet: { writeContract } };
  return { ctx: ctx as AppContext, app: createApp(ctx as AppContext), tsla, simulateContract, writeContract };
}

/** The vault's Sold event, as the receipt carries it (half the holding at the oracle price, less the desk's spread). */
function soldLog(token: Address, router: Address, held: bigint, oracle: bigint) {
  const tokensIn = held / 2n;
  const notional = (tokensIn * oracle * 10n ** 6n) / (10n ** 8n * E18);
  const topics = encodeEventTopics({ abi: glanceVaultAbi, eventName: "Sold", args: { token, router } });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }],
    [tokensIn, (notional * 9970n) / 10_000n, notional, oracle, 0, usd(100), usd(500)],
  );
  return { address: VAULT, topics, data, blockNumber: 101n, logIndex: 0, transactionHash: HASH };
}

async function getQuote(app: ReturnType<typeof createApp>, query: string) {
  const res = await app.request(`/quote?vault=${VAULT}&symbol=TSLA&side=sell&${query}`);
  return { status: res.status, body: (await res.json()) as any };
}

describe("working out the shares", () => {
  it("$10 of Tesla: dollars to shares at the vault's price, rounded down, never worth more than asked", async () => {
    const { app, simulateContract } = await setup({ held: E18 });
    const { status, body } = await getQuote(app, "usd=10");
    expect(status).toBe(200);
    // 10 / 370 = 0.027027027027027027 TSLA (18 decimals, rounded down).
    expect(body.amountIn.value).toBe("0.027027027027027027");
    expect(body.amountIn.formatted).toBe("0.027 TSLA");
    expect(body.sell).toMatchObject({ basis: "usd", usd: "10", held: { formatted: "1 TSLA" }, heldValue: { formatted: "$370" } });
    expect(body.sell.value.raw).toBe("9999999"); // $9.999999: under the $10 asked, shown as "$10.00"
    // What comes back, and the least the vault will accept.
    expect(body.deskQuote.formatted).toBe("$9.97");
    expect(body.price.value).toBe("370");
    expect(body.preflight.ok).toBe(true);
    // The preflight simulated the vault's own sell() with exactly those shares.
    const call = simulateContract.mock.calls[0]![0];
    expect(call.functionName).toBe("sell");
    expect(call.args[2]).toBe(27_027_027_027_027_027n);
  });

  it("half my Tesla, and all of it", async () => {
    const { app } = await setup({ held: 3n * E18 + 1n });
    const half = await getQuote(app, "fraction=0.5");
    expect(half.body.amountIn.value).toBe("1.5"); // (3e18 + 1) / 2, rounded down
    expect(half.body.sell.basis).toBe("fraction");
    const all = await getQuote(app, "fraction=1");
    expect(all.body.amountIn.value).toBe("3.000000000000000001"); // every last unit
  });

  it("a quote names its amount exactly one way, and dollars or a fraction only for a sell", async () => {
    const { app } = await setup({ held: E18 });
    expect((await getQuote(app, "usd=10&fraction=1")).status).toBe(400);
    expect((await getQuote(app, "")).status).toBe(400);
    expect((await getQuote(app, "fraction=0.25")).status).toBe(400);
    const buy = await app.request(`/quote?vault=${VAULT}&symbol=TSLA&side=buy&usd=10`);
    expect(buy.status).toBe(400);
  });

  it("a live price is shown beside the vault's price", async () => {
    const { app } = await setup({ held: E18, live: 371 });
    const { body } = await getQuote(app, "usd=10");
    expect(body.live).toMatchObject({ price: "371.00", source: "finnhub" });
    expect(body.drift).toMatchObject({ checked: true, blocked: false });
  });
});

describe("refusals, in the words the user hears", () => {
  it("nothing held: refused before any quote or simulation", async () => {
    const { app, simulateContract } = await setup({ held: 0n });
    for (const q of ["fraction=1", "usd=10", "amount=0.1"]) {
      const { status, body } = await getQuote(app, q);
      expect(status).toBe(422);
      expect(body.error.code).toBe("NOTHING_HELD");
      expect(body.error.message).toBe("You don't hold any Tesla in your vault, so there's nothing to sell.");
      expect(body.error.guard.code).toBe("NOTHING_HELD");
    }
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("the per-trade cap while the market is closed ($25): the rule, then the offer", async () => {
    const { app } = await setup({ held: E18, ageHours: 30, revert: { name: "ExceedsPerTradeCap", args: [usd(40), usd(25)] } });
    const { body } = await getQuote(app, "usd=40");
    expect(body.marketState).toBe("CLOSED");
    expect(body.preflight.ok).toBe(false);
    expect(body.preflight.guard.code).toBe("PER_TRADE_CAP");
    expect(body.preflight.guard.message).toBe("The market is closed, so each trade is capped at $25. Want me to sell $25 worth instead?");
  });

  it("the per-trade cap while the market is open ($100)", async () => {
    const { app } = await setup({ held: E18, revert: { name: "ExceedsPerTradeCap", args: [usd(370), usd(100)] } });
    const { body } = await getQuote(app, "fraction=1");
    expect(body.preflight.guard.message).toBe("Each trade is capped at $100. Want me to sell $100 worth instead?");
  });

  it("the daily sell cap ($500 open, 25% of it closed)", async () => {
    const open = await setup({ held: E18, revert: { name: "ExceedsDailySellCap", args: [usd(480), usd(50), usd(500)] } });
    expect((await getQuote(open.app, "usd=50")).body.preflight.guard).toMatchObject({
      code: "DAILY_SELL_CAP",
      message: "Sells are capped at $500 a day. You have $20 left. Want me to sell $20 worth instead? The rest frees up within 24 hours.",
    });
    const closed = await setup({ held: E18, ageHours: 30, revert: { name: "ExceedsDailySellCap", args: [usd(125), usd(10), usd(125)] } });
    expect((await getQuote(closed.app, "usd=10")).body.preflight.guard.message).toBe(
      "The market is closed, so sells are capped at $125 a day, and you've sold that much. It frees up within 24 hours.",
    );
  });

  it("more than the vault holds: the vault's own balance check", async () => {
    const { app } = await setup({ held: E18 / 100n, revert: { name: "InsufficientBalance", args: [E18 / 100n, 27_027_027_027_027_027n] } });
    const { body } = await getQuote(app, "usd=10");
    expect(body.preflight.guard).toMatchObject({ code: "INSUFFICIENT_BALANCE", message: "You only hold 0.01 TSLA in the vault." });
  });

  it("the drift guard: the on-chain price more than 2% behind the market", async () => {
    const { app, ctx, writeContract } = await setup({ held: E18, live: 390 });
    const { body } = await getQuote(app, "usd=10");
    expect(body.drift.blocked).toBe(true);
    expect(body.drift.guard.message).toBe("The on-chain price is behind the market right now, so I won't trade Tesla yet.");
    // And /trade refuses it just before sending: nothing reaches the chain.
    const err = await tradeView(ctx, { vault: VAULT, symbol: "TSLA", side: "sell", amount: body.amountIn.value }).catch((e: { code: string }) => e);
    expect((err as { code: string }).code).toBe("PRICE_DRIFT");
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe("the sale", () => {
  it("sends exactly the quoted shares through the vault's sell(), and reports the USDG that came back", async () => {
    const { ctx, simulateContract, writeContract } = await setup({ held: 2n * E18 });
    const quote = await quoteView(ctx, { vault: VAULT, symbol: "TSLA", side: "sell", fraction: "0.5" });
    const trade = await tradeView(ctx, { vault: VAULT, symbol: "TSLA", side: "sell", amount: quote.amountIn.value });
    // The send: the vault's sell() for 1 TSLA through the desk, with the desk's quote as the floor.
    const sent = simulateContract.mock.calls.at(-1)![0];
    expect(sent.functionName).toBe("sell");
    expect(sent.args[2]).toBe(E18);
    expect(sent.args[3]).toBe(BigInt(quote.minOut.raw));
    expect(writeContract).toHaveBeenCalledTimes(1); // the stub wallet: nothing is broadcast
    expect(trade).toMatchObject({ side: "sell", txHash: HASH, filled: { tokensIn: { formatted: "1 TSLA" }, usdgOut: { formatted: "$368.89" } } });
    expect(trade.explorerUrl).toMatch(new RegExp(`/tx/${HASH}$`));
  });

  it("the console's Activity lists the sale as a trade, from the vault's Sold event", async () => {
    const { app, ctx, tsla } = await setup({ held: 2n * E18 });
    const log = { ...soldLog(tsla.token, ctx.desks[0]!, 2n * E18, 37_000_000_000n), blockNumber: BigInt(ctx.deployment.blockNumber) + 50n };
    const client = ctx.client as unknown as { getLogs: ReturnType<typeof vi.fn> };
    client.getLogs.mockImplementation(async () => [log]);
    const res = await app.request(`/vault/${VAULT}/activity?limit=5`);
    const body = (await res.json()) as any;
    const sold = body.items.find((i: any) => i.type === "Sold");
    expect(sold).toMatchObject({ kind: "trade", summary: "Sold 1 TSLA for $368.89", txHash: HASH });
  });

  it("nothing held at the moment of sending: refused, nothing sent", async () => {
    const { ctx, writeContract } = await setup({ held: 0n });
    const err = await tradeView(ctx, { vault: VAULT, symbol: "TSLA", side: "sell", amount: "0.1" }).catch((e: { code: string }) => e);
    expect((err as { code: string }).code).toBe("NOTHING_HELD");
    expect(writeContract).not.toHaveBeenCalled();
  });
});
