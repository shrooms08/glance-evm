/**
 * The buy card's reads (GET /price, GET /quote) when the chain's RPC misbehaves, on a fake chain (nothing sent):
 *   - the provider's per-second limit (a 429 batch, or -32007 calls) is RPC trouble: a 503 the extension retries,
 *     with what couldn't be read, never "something went wrong" and never "not a vault";
 *   - an address with no vault is a plain 404;
 *   - the trade history failing never touches the buy card;
 *   - anything unexpected says what it was reading, and the log gets the failed call without a URL;
 *   - the API keeps its own calls under the provider's limit (each call in a batch counts).
 */
import { resolve } from "node:path";

import { BaseError, ContractFunctionExecutionError, ContractFunctionZeroDataError, HttpRequestError, RpcRequestError, UnknownRpcError, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";

import { callsIn, callsPerSecondLimiter, isRpcTrouble } from "@glance/core/rpc";
import { glanceVaultAbi, testPriceFeedAbi } from "../../src/abi.generated.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext, type AppContext } from "../../src/context.js";
import { chainReadMessage, errorDetail } from "../../src/errorDetail.js";
import { stockBySymbol } from "../../src/services.js";

const DEPLOYMENT_FILE = resolve(import.meta.dirname, "../../../../deployments/46630.json");
const env = { NODE_ENV: "test", DEPLOYMENT_FILE, AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const USDG = "0x3333333333333333333333333333333333333333" as Address;
const NOW = Math.floor(Date.now() / 1000);
const usd = (n: number) => BigInt(Math.round(n * 1e6));

/** What the provider answers when its per-second limit is reached, as viem reports it on a read. */
function rateLimited(functionName: string, address: Address, how: "batch" | "call") {
  const cause =
    how === "batch"
      ? new UnknownRpcError(new TypeError("Cannot read properties of undefined (reading 'error')"))
      : new RpcRequestError({ body: { method: "eth_call" }, error: { code: -32007, message: "50/second request limit reached - reduce calls per second" }, url: "https://example.quiknode.pro/SECRETTOKEN/" });
  return new ContractFunctionExecutionError(cause, { abi: functionName === "latestRoundData" ? testPriceFeedAbi : glanceVaultAbi, functionName, args: [], contractAddress: address });
}

/** A context on a fake chain for a TSLA buy: the vault, the desk (0.3% spread), the feed. `fail` breaks one read. */
function setup(fail: { fn?: string; error?: (address: Address, fn: string) => Error; logs?: Error } = {}) {
  const ctx = createContext(loadConfig(env), () => {});
  const tsla = stockBySymbol(ctx, "TSLA");
  const oracle = 350n * 10n ** 8n;
  const vault: Record<string, unknown> = {
    owner: "0x4444444444444444444444444444444444444444",
    agent: "0x1111111111111111111111111111111111111111",
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
    if (fail.fn === functionName) throw fail.error!(address, functionName);
    if (functionName === "latestRoundData") return [1n, oracle, 0n, BigInt(NOW - 3 * 3600), 1n];
    if (functionName === "decimals") return 8;
    if (functionName === "balanceOf") return usd(40);
    if (functionName === "quoteBuy") return (((args![1] as bigint) * 10n ** 8n * 10n ** 18n) / (oracle * 10n ** 6n) * 9970n) / 10_000n;
    if (functionName === "spreadBps") return 30n;
    if (functionName in vault) return vault[functionName];
    throw new Error(`unexpected read ${functionName}`);
  });
  const getLogs = vi.fn(async () => {
    if (fail.logs) throw fail.logs;
    return [];
  });
  (ctx as { client: unknown }).client = {
    readContract,
    simulateContract: vi.fn(async (r: { functionName: string; args: readonly unknown[] }) => ({ request: r })),
    getCode: vi.fn(async () => "0x60"),
    getBlock: vi.fn(async () => ({ number: BigInt(ctx.deployment.blockNumber) + 100n, timestamp: BigInt(NOW) })),
    getBlockNumber: vi.fn(async () => BigInt(ctx.deployment.blockNumber) + 100n),
    getLogs,
  };
  return { app: createApp(ctx as AppContext), getLogs };
}

const get = async (app: ReturnType<typeof createApp>, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string; detail?: string }; preflight?: { ok: boolean } } };
};
const QUOTE = `/quote?vault=${VAULT}&symbol=TSLA&side=buy&amount=10`;

describe("the buy card's reads when the RPC is rate limited", () => {
  it("a whole batch refused (a 429 object, not an array) is RPC trouble: 503, retried by the extension, never INTERNAL", async () => {
    const { app } = setup({ fn: "latestRoundData", error: (a, f) => rateLimited(f, a, "batch") });
    const { status, body } = await get(app, QUOTE);
    expect(status).toBe(503);
    expect(body.error).toMatchObject({ code: "RPC_UNAVAILABLE", message: "I couldn't read the stock's price from the chain. Try again in a few seconds." });
    expect(body.error!.detail).toContain("latestRoundData()");
  });

  it("a call refused with -32007 is RPC trouble too, and a vault read under it is never \"not a vault\"", async () => {
    const { app } = setup({ fn: "perBuyCap", error: (a, f) => rateLimited(f, a, "call") });
    const quote = await get(app, QUOTE);
    expect(quote.status).toBe(503);
    expect(quote.body.error!.code).toBe("RPC_UNAVAILABLE");
    const vault = await get(app, `/vault/${VAULT}`);
    expect(vault.status).toBe(503);
    expect(vault.body.error!.code).not.toBe("NOT_A_VAULT");
    // The provider's URL (and the key in its path) never reaches the answer.
    expect(JSON.stringify(quote.body)).not.toContain("SECRETTOKEN");
  });

  it("isRpcTrouble: -32007, a rejected batch and a rate-limit message are trouble; a call that returned nothing is not", () => {
    expect(isRpcTrouble(rateLimited("decimals", VAULT, "batch"))).toBe(true);
    expect(isRpcTrouble(rateLimited("decimals", VAULT, "call"))).toBe(true);
    expect(isRpcTrouble(new Error("429: 50/second request limit reached"))).toBe(true);
    const zero = new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: "tokenConfig" }), { abi: glanceVaultAbi, functionName: "tokenConfig", args: [], contractAddress: VAULT });
    expect(isRpcTrouble(zero)).toBe(false);
  });
});

describe("other failures", () => {
  it("an address with no vault: the price says so (404), not \"something went wrong\"", async () => {
    const zero = (a: Address, f: string) => new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: f }), { abi: glanceVaultAbi, functionName: f, args: [], contractAddress: a });
    const { app } = setup({ fn: "tokenConfig", error: zero });
    const { status, body } = await get(app, `/price/TSLA?vault=${VAULT}`);
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: "NOT_A_VAULT", message: `There's no Glance vault at ${VAULT}.` });
  });

  it("anything unexpected says what it was reading, and the log names the failed call (no URL)", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l: string) => void lines.push(l));
    const odd = (a: Address, f: string) => new ContractFunctionExecutionError(new BaseError(`bad answer from https://rpc.example.com/KEY123/`), { abi: glanceVaultAbi, functionName: f, args: [], contractAddress: a });
    const { app } = setup({ fn: "spreadBps", error: odd });
    const { status, body } = await get(app, QUOTE);
    spy.mockRestore();
    expect(status).toBe(502);
    expect(body.error).toMatchObject({ code: "INTERNAL", message: "I couldn't read the desk's quote from the chain. Try again in a few seconds." });
    expect(body.error!.detail).toContain("spreadBps()");
    expect(lines.join("\n")).toContain("GET /quote INTERNAL: spreadBps()");
    expect(lines.join("\n") + JSON.stringify(body)).not.toContain("KEY123");
  });

  it("the buy card never depends on trade history: with the log reads failing, the quote still goes through, and the log says so", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l: string) => void lines.push(l));
    const { app, getLogs } = setup({ logs: new HttpRequestError({ url: "https://example.org/x", status: 429 }) });
    const { status, body } = await get(app, QUOTE);
    const vault = await get(app, `/vault/${VAULT}`);
    spy.mockRestore();
    expect(getLogs).toHaveBeenCalled();
    expect(status).toBe(200);
    expect(body.preflight).toMatchObject({ ok: true });
    expect(vault.status).toBe(200);
    expect(lines.some((l) => l.includes("quote: the 24h trade history couldn't be read") && l.includes("HTTP 429"))).toBe(true);
  });

  it("errorDetail keeps a URL's host only, and chainReadMessage names what was being read", () => {
    const e = new HttpRequestError({ url: "https://convincing.quiknode.pro/abc123token/", status: 429, body: { method: "eth_call" } });
    const d = errorDetail(e);
    expect(d).toContain("eth_call HTTP 429");
    expect(d).not.toContain("abc123token");
    expect(chainReadMessage(rateLimited("perBuyCap", VAULT, "call"))).toBe("I couldn't read your vault's limits from the chain. Try again in a few seconds.");
  });
});

describe("the API's own calls stay under the provider's limit", () => {
  it("counts each call in a batch, and waits when the next batch wouldn't fit in the last second", async () => {
    expect(callsIn(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]))).toBe(3);
    expect(callsIn(JSON.stringify({ id: 1 }))).toBe(1);
    let t = 0;
    const sent: number[] = [];
    const limited = callsPerSecondLimiter("https://rpc.example/x", 40, {
      fetch: (async () => {
        sent.push(t);
        return new Response("[]");
      }) as unknown as typeof fetch,
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    const batch = (n: number) => ({ method: "POST", body: JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))) });
    await Promise.all([limited("u", batch(20)), limited("u", batch(20)), limited("u", batch(20))]);
    expect(sent.slice(0, 2)).toEqual([0, 0]);
    expect(sent[2]).toBeGreaterThanOrEqual(1_000); // the third waited for the first second to pass
  });
});
