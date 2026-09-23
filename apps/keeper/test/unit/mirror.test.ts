import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config.js";
import { runOnce, type KeeperDeps } from "../../src/keeper.js";
import { planMirror, type Round } from "../../src/mirror.js";
import { pauseState } from "../../src/pause.js";
import { fetchYahooQuote, toPrice8 } from "../../src/quote.js";

const NOW = 1_790_170_000n;
const TSLA_MAINNET = "0x4A1166a659A55625345e9515b32adECea5547C38" as const;
const TSLA_TESTNET = "0xb856AB851b58B3d0436d62b465A9e92c481E9e9f" as const;
const NFLX_TESTNET = "0x8B02279a7844698bD20119DF60A2a55981eAc8a5" as const;

describe("planMirror", () => {
  const source: Round = { answer: 38_025_740_000n, updatedAt: NOW - 3n * 3600n };

  it("copies the source's updatedAt, never the testnet clock", () => {
    const plan = planMirror(source, { answer: 1n, updatedAt: NOW - 90_000n }, NOW);
    expect(plan).toEqual({ action: "write", round: { answer: 38_025_740_000n, updatedAt: NOW - 3n * 3600n }, reason: "source changed" });
    if (plan.action === "write") expect(plan.round.updatedAt).not.toBe(NOW);
  });

  it("writes when only the timestamp changed (a fresh round at the same price)", () => {
    const plan = planMirror(source, { answer: source.answer, updatedAt: source.updatedAt - 60n }, NOW);
    expect(plan.action).toBe("write");
  });

  it("restores the real timestamp even if the testnet feed was set newer by hand", () => {
    const plan = planMirror(source, { answer: source.answer, updatedAt: NOW }, NOW);
    expect(plan).toMatchObject({ action: "write", round: { updatedAt: source.updatedAt } });
  });

  it("skips when the testnet feed already mirrors the source", () => {
    expect(planMirror(source, { ...source }, NOW)).toEqual({ action: "skip", reason: "unchanged" });
  });

  it("holds rather than mirror a bad or future reading", () => {
    expect(planMirror({ answer: 0n, updatedAt: NOW }, source, NOW).action).toBe("hold");
    expect(planMirror({ answer: -5n, updatedAt: NOW }, source, NOW).action).toBe("hold");
    expect(planMirror({ answer: 1n, updatedAt: 0n }, source, NOW).action).toBe("hold");
    const ahead = planMirror({ answer: 1n, updatedAt: NOW + 5n }, source, NOW);
    expect(ahead).toEqual({ action: "hold", reason: "source updatedAt is 5s ahead of the testnet clock" });
  });
});

describe("pause switch", () => {
  it("pauses on the file or the env var", () => {
    expect(pauseState({}, false, "/repo/keeper.paused")).toEqual({ paused: false, reason: "" });
    expect(pauseState({}, true, "/repo/keeper.paused")).toEqual({ paused: true, reason: "/repo/keeper.paused exists" });
    expect(pauseState({ KEEPER_PAUSED: "1" }, false, "x").paused).toBe(true);
    expect(pauseState({ KEEPER_PAUSED: "true" }, false, "x").paused).toBe(true);
    expect(pauseState({ KEEPER_PAUSED: "0" }, false, "x").paused).toBe(false);
    expect(pauseState({ KEEPER_PAUSED: "" }, false, "x").paused).toBe(false);
  });
});

describe("runOnce", () => {
  function deps(overrides: Partial<KeeperDeps> = {}) {
    const writes: Array<{ feed: string; round: Round }> = [];
    const lines: string[] = [];
    const testnet = new Map<string, Round>([
      [TSLA_TESTNET, { answer: 1n, updatedAt: NOW - 100_000n }],
      [NFLX_TESTNET, { answer: 7_216_000_000n, updatedAt: NOW - 50_000n }],
    ]);
    const d: KeeperDeps = {
      symbols: [
        { symbol: "TSLA", testnetFeed: TSLA_TESTNET, source: { kind: "mainnet-mirror", feed: TSLA_MAINNET, description: "RHTSLA / USD" } },
        { symbol: "NFLX", testnetFeed: NFLX_TESTNET, source: { kind: "public-quote", provider: "yahoo-finance", description: "Yahoo" } },
      ],
      readMainnet: async () => ({ answer: 38_025_740_000n, updatedAt: NOW - 10_000n }),
      readPublicQuote: async () => ({ answer: 7_216_000_000n, updatedAt: NOW - 50_000n, provider: "Yahoo Finance" }),
      readTestnet: async (feed) => testnet.get(feed)!,
      testnetNow: async () => NOW,
      write: async (feed, round) => {
        writes.push({ feed, round });
        return "0xabc";
      },
      log: (line) => lines.push(line),
      ...overrides,
    };
    return { d, writes, lines };
  }

  it("writes the mainnet price and updatedAt, and skips an unchanged public quote", async () => {
    const { d, writes, lines } = deps();
    const results = await runOnce(d);
    expect(results).toEqual([
      { symbol: "TSLA", plan: "write", txHash: "0xabc" },
      { symbol: "NFLX", plan: "skip" },
    ]);
    expect(writes).toEqual([{ feed: TSLA_TESTNET, round: { answer: 38_025_740_000n, updatedAt: NOW - 10_000n } }]);
    expect(lines[0]).toMatch(/^TSLA  mainnet-mirror: wrote \$380\.2574 updated .* \(2\.8h ago\) from mainnet feed 0x4A11.*, tx 0xabc$/);
    expect(lines[1]).toMatch(/^NFLX  public-quote \(yahoo-finance\): unchanged, skipped/);
  });

  it("labels the public quote path and holds when no quote is available", async () => {
    const { d, writes, lines } = deps({ readPublicQuote: async () => null });
    await runOnce(d);
    expect(writes.map((w) => w.feed)).toEqual([TSLA_TESTNET]);
    expect(lines[1]).toBe("NFLX  public-quote (yahoo-finance): no quote available, feed left as is");
  });

  it("keeps going when one symbol fails, and reports it", async () => {
    const { d, lines } = deps({
      readMainnet: async () => {
        throw new Error("Too Many Requests\nwith a long body");
      },
    });
    const results = await runOnce(d);
    expect(results[0]).toEqual({ symbol: "TSLA", plan: "error" });
    expect(results[1]!.plan).toBe("skip");
    expect(lines[0]).toBe("TSLA  mainnet-mirror: ERROR Too Many Requests");
  });

  it("never writes a timestamp equal to the testnet clock unless the source said so", async () => {
    const { d, writes } = deps();
    await runOnce(d);
    for (const w of writes) expect(w.round.updatedAt).not.toBe(NOW);
  });
});

describe("public quote", () => {
  it("converts decimal prices to 8 decimals without floating point", () => {
    expect(toPrice8(72.16)).toBe(7_216_000_000n);
    expect(toPrice8("380.2574")).toBe(38_025_740_000n);
    expect(toPrice8("0.000000019")).toBe(1n);
    expect(toPrice8(0)).toBeNull();
    expect(toPrice8("abc")).toBeNull();
    expect(toPrice8(undefined)).toBeNull();
  });

  it("uses the quote's own market time as updatedAt", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 72.16, regularMarketTime: 1_790_107_200 } }] } }))) as typeof fetch;
    expect(await fetchYahooQuote("NFLX", fakeFetch)).toEqual({
      answer: 7_216_000_000n,
      updatedAt: 1_790_107_200n,
      provider: "Yahoo Finance",
      display: "72.16",
    });
  });

  it("returns null on a bad response", async () => {
    const bad = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    expect(await fetchYahooQuote("NFLX", bad)).toBeNull();
    const empty = (async () => new Response(JSON.stringify({ chart: { result: [] } }))) as typeof fetch;
    expect(await fetchYahooQuote("NFLX", empty)).toBeNull();
  });
});

describe("configuration", () => {
  it("fails loudly on missing variables without echoing any value", () => {
    const secret = `0x${"ab".repeat(32)}`;
    expect(() => loadEnv({})).toThrow(/KEEPER_PRIVATE_KEY: missing[\s\S]*TESTNET_RPC_URL: missing[\s\S]*MAINNET_RPC_URL: missing/);
    try {
      loadEnv({ KEEPER_PRIVATE_KEY: `${secret}zz`, TESTNET_RPC_URL: "https://t", MAINNET_RPC_URL: "https://m" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/KEEPER_PRIVATE_KEY: must be 0x followed by 64 hex characters/);
      expect((err as Error).message).not.toContain("abab");
    }
    expect(loadEnv({ KEEPER_PRIVATE_KEY: secret, TESTNET_RPC_URL: "https://t", MAINNET_RPC_URL: "https://m" }).KEEPER_INTERVAL_SECONDS).toBe(120);
  });
});
