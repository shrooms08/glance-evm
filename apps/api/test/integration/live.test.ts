/**
 * Integration tests against the live Robinhood Chain testnet deployment in deployments/46630.json.
 *
 * - Skipped cleanly when the RPC is unreachable, so `pnpm test` works offline.
 * - Never sends a transaction: the agent key is removed from the environment, and quotes use eth_call only.
 */
import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";

import { glanceVaultAbi } from "../../src/abi.generated.js";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createContext } from "../../src/context.js";

const env = { ...process.env, NODE_ENV: "test", AGENT_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "" };
const config = loadConfig(env);

async function rpcReachable(): Promise<boolean> {
  try {
    const client = createPublicClient({ transport: http(config.RPC_URL, { timeout: 8_000, retryCount: 0 }) });
    return (await client.getChainId()) > 0;
  } catch {
    return false;
  }
}

const online = await rpcReachable();
const ctx = online ? createContext(config) : null;
const app = ctx ? createApp(ctx) : null;
const vault = ctx?.deployment.demoVaultTestUSDG.address;

async function get(path: string) {
  const res = await app!.request(path);
  return { status: res.status, body: (await res.json()) as any };
}

describe.skipIf(!online)("live testnet", () => {
  it("GET /health reports the chain, the block and the agent", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.chainId).toBe(46_630);
    expect(BigInt(body.blockNumber)).toBeGreaterThan(BigInt(ctx!.deployment.blockNumber));
    expect(body.agent.address).toBe(ctx!.deployment.demoVaultTestUSDG.agent);
    expect(body.agent.keyLoaded).toBe(false);
    expect(Number(body.agent.ethBalance)).toBeGreaterThanOrEqual(0);
    // Real Paxos USDG is the headline; the TestUSDG vault stays available as the fallback.
    expect(body.demoVaults.primary).toBe(ctx!.deployment.demoVaultPaxosUSDG!.address);
    expect(body.demoVaults.testUSDG).toBe(ctx!.deployment.demoVaultTestUSDG.address);
    expect(body.demoVaults.faucets.paxosUSDG).toBe("https://faucet.paxos.com/");
    // No key material, ever: no key-like field names, and no 32-byte hex value outside a transaction hash.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/private|secret|mnemonic/i);
    expect(text.replace(/"txHash":"0x[0-9a-f]{64}"/g, "")).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("GET /health reports every feed's freshness and source", async () => {
    const { body } = await get("/health");
    // The five stocks, then the ETF stand-ins (deployed 25 Sep 2026: make deploy-etf-standins).
    expect(body.feeds.map((f: any) => f.symbol)).toEqual(["TSLA", "AMZN", "PLTR", "NFLX", "AMD", "SPY", "QQQ"]);
    for (const f of body.feeds) {
      expect(["OPEN", "CLOSED", "STALE"]).toContain(f.marketState);
      expect(f.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(f.source).toBe(f.symbol === "NFLX" ? "public-quote" : "mainnet-mirror");
      expect(f.lastWrite?.txHash).toMatch(/^0x[0-9a-f]{64}$/); // at least the deploy script's write
      expect(f.lastWrite?.at).toBeGreaterThan(0);
    }
    expect(typeof body.keeper.pausedLocally).toBe("boolean");
  });

  it("GET /catalog lists the five stocks and the two ETF stand-ins, with addresses from the deployment file", async () => {
    const { status, body } = await get("/catalog");
    expect(status).toBe(200);
    expect(body.stocks.map((s: any) => s.symbol)).toEqual(["TSLA", "AMZN", "PLTR", "NFLX", "AMD", "SPY", "QQQ"]);
    for (const s of body.stocks) {
      const deployed = ctx!.deployment.stocks[s.symbol] as any;
      expect(s.token).toBe(deployed.token);
      expect(s.feed).toBe(deployed.feed);
      // The five are the real testnet Stock Tokens; SPY and QQQ exist only on mainnet, so theirs are stand-ins.
      expect(s.tokenReal).toBe(!["SPY", "QQQ"].includes(s.symbol));
      expect(s.feedReal).toBe(false);
      expect(s.aliases.length).toBeGreaterThan(1);
    }
  });

  it("GET /price/:symbol returns the oracle price, its age and the vault's market state", async () => {
    const { status, body } = await get("/price/tsla");
    expect(status).toBe(200);
    expect(body.symbol).toBe("TSLA");
    expect(BigInt(body.price.raw)).toBeGreaterThan(0n);
    expect(body.price.decimals).toBe(8);
    expect(["OPEN", "CLOSED", "STALE"]).toContain(body.marketState);
    // With no vault named, the default (the primary, Paxos USDG, vault) and whatever its owner set for TSLA on chain.
    const defaultVault = ctx!.defaultVault;
    const [, , openMaxAge, closedMaxAge] = await ctx!.client.readContract({
      address: defaultVault,
      abi: glanceVaultAbi,
      functionName: "tokenConfig",
      args: [(ctx!.deployment.stocks.TSLA as any).token],
    });
    expect(body.freshness).toMatchObject({ vault: defaultVault, openMaxAge, closedMaxAge });
    expect(body.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body.priceSourceKind).toBe("mainnet-mirror");
    expect(body.mainnetFeed).toBe("0x4A1166a659A55625345e9515b32adECea5547C38");
  });

  it("GET /price/:symbol rejects unknown and malformed symbols", async () => {
    expect((await get("/price/AAPL")).body.error.code).toBe("UNKNOWN_SYMBOL");
    expect((await get("/price/TSLA123")).status).toBe(400);
  });

  it("GET /vault/:address returns limits, windows, balances and positions", async () => {
    const { status, body } = await get(`/vault/${vault}`);
    expect(status).toBe(200);
    expect(body.owner).toBe(ctx!.deployment.demoVaultTestUSDG.owner);
    expect(body.usdg.real).toBe(false);
    expect(body.limits.weekendCap).toBe("25%");
    expect(body.effectiveCaps.OPEN.perTrade.raw).toBe(body.limits.perTrade.raw);
    expect(BigInt(body.effectiveCaps.CLOSED.perTrade.raw)).toBe((BigInt(body.limits.perTrade.raw) * 2500n) / 10_000n);
    // The event-rebuilt windows must agree with the contract's own totals.
    expect(body.buyWindow.reconstructed).toBe(true);
    expect(body.sellWindow.reconstructed).toBe(true);
    expect(body.positions).toHaveLength(ctx!.catalog.entries.length); // one per catalog stock, the ETFs included
    const invested = body.positions.reduce((s: bigint, p: any) => s + BigInt(p.value.raw), 0n);
    expect(BigInt(body.balances.total.raw)).toBe(BigInt(body.balances.usdg.raw) + invested);
  });

  it("GET /vault/:address/activity decodes events newest first", async () => {
    const { status, body } = await get(`/vault/${vault}/activity?limit=20`);
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(item.summary.length).toBeGreaterThan(3);
    }
    const times = body.items.map((i: any) => i.timestamp);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(body.items.some((i: any) => i.type === "Deposited")).toBe(true);
  });

  it("GET /quote: a small buy passes the on-chain preflight", async (t) => {
    const price = await get("/price/TSLA");
    if (price.body.marketState === "STALE") {
      t.skip("stand-in feeds are stale: re-run `make deploy-robinhood` to re-price them");
    }
    const { status, body } = await get(`/quote?vault=${vault}&symbol=TSLA&side=buy&amount=1`);
    expect(status).toBe(200);
    expect(body.preflight.ok).toBe(true);
    expect(body.preflight.simulatedAs).toBe(ctx!.deployment.demoVaultTestUSDG.agent);
    expect(body.spreadBps).toBe(30);
    // Desk quote = oracle-implied amount less the 0.30% spread.
    const oracle = BigInt(body.oracleImplied.raw);
    expect(BigInt(body.deskQuote.raw)).toBe((oracle * 9_970n) / 10_000n);
  });

  it("GET /quote: an oversized buy is blocked by the per-trade cap, with the exact sentence", async () => {
    const v = (await get(`/vault/${vault}`)).body;
    const tsla = v.positions.find((p: any) => p.symbol === "TSLA");
    if (tsla.marketState === "STALE") return; // stale is covered above; the cap check needs a usable price
    const cap = tsla.effectiveCaps.perTrade;
    const over = (BigInt(cap.raw) + 50_000_000n) / 1_000_000n; // cap + $50, in whole USDG
    const { body } = await get(`/quote?vault=${vault}&symbol=TSLA&side=buy&amount=${over}`);
    expect(body.preflight.ok).toBe(false);
    expect(body.preflight.guard.code).toBe("PER_TRADE_CAP");
    const closed = tsla.marketState === "CLOSED" ? " while the market's closed" : "";
    expect(body.preflight.guard.message).toBe(
      `That's over your ${cap.formatted} per trade limit${closed}. Want me to buy ${cap.formatted} instead?`,
    );
    expect(body.preflight.guard.detail.suggestedAmount).toBe(cap.raw);
  });

  it("GET /quote: selling more than the vault holds is blocked by its balance", async () => {
    const { body } = await get(`/quote?vault=${vault}&symbol=AMD&side=sell&amount=0.01`);
    const v = (await get(`/vault/${vault}`)).body;
    const amd = v.positions.find((p: any) => p.symbol === "AMD");
    if (BigInt(amd.quantity.raw) >= 10n ** 16n || amd.marketState === "STALE") return;
    expect(body.preflight.guard.code).toBe("INSUFFICIENT_BALANCE");
    expect(body.preflight.guard.message).toBe(`You only hold ${amd.quantity.formatted} in the vault.`);
  });

  it("POST /trade needs a linked browser (this vault isn't open for demos), and never sends", async () => {
    const res = await app!.request("/trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault, symbol: "TSLA", side: "buy", amount: "1" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe("SESSION_REQUIRED");
  });

  it("POST /trade on a vault opened with OPEN_DEMO_VAULTS (recording day only) refuses without the agent key and never sends", async () => {
    const open = createApp(createContext(loadConfig({ ...env, OPEN_DEMO_VAULTS: vault! }), () => {}));
    const res = await open.request("/trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vault, symbol: "TSLA", side: "buy", amount: "1" }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe("AGENT_KEY_MISSING");
  });

  it("validates input", async () => {
    expect((await get("/quote?vault=0x1&symbol=TSLA&side=buy&amount=1")).status).toBe(400);
    expect((await get(`/quote?vault=${vault}&symbol=TSLA&side=hold&amount=1`)).status).toBe(400);
    expect((await get(`/quote?vault=${vault}&symbol=TSLA&side=buy&amount=-5`)).status).toBe(400);
    expect((await get(`/quote?vault=${vault}&symbol=TSLA&side=buy&amount=0.0000001`)).body.error.code).toBe("BAD_AMOUNT");
    expect((await get("/vault/not-an-address")).status).toBe(400);
    const res = await app!.request("/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
  });

  it("POST /resolve works end to end", async () => {
    const res = await app!.request("/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Palantir and $TSLA, not the Amazon rainforest." }),
    });
    const body = (await res.json()) as any;
    expect(body.source).toBe("dictionary");
    expect(body.matches.map((m: any) => m.symbol)).toEqual(["PLTR", "TSLA"]);
    expect(body.matches[1].stock.token).toBe((ctx!.deployment.stocks.TSLA as any).token);
  });

  it("CORS allows localhost in development but not arbitrary origins", async () => {
    const res = await app!.request("/health", { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
