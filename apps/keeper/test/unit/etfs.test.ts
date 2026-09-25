/**
 * The ETF stand-ins (SPY, QQQ): config/price-sources.json names their Chainlink mainnet feeds; once they're in the
 * deployment record, the keeper mirrors each one (price AND updatedAt) onto its testnet feed; before that, they're
 * simply not mirrored. Fakes only: no network.
 */
import { resolve } from "node:path";

import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { runOnce } from "../../src/keeper.js";
import { keeperSymbols, loadPriceSources } from "../../src/sources.js";

const sources = loadPriceSources(resolve(import.meta.dirname, "../../../../config/price-sources.json"));
const NOW = 1_790_315_000n;
const SPY_TESTNET = "0x5d7bEAe66da99B88Aa1ACE7C49F72e5AFBd59c02" as Address;
const QQQ_TESTNET = "0x1f2676a6f87c516e48f32DD73bE44E910E66350c" as Address;
const TSLA_TESTNET = "0xb856AB851b58B3d0436d62b465A9e92c481E9e9f" as Address;

describe("ETF price sources", () => {
  it("SPY and QQQ mirror their verified Robinhood Chain mainnet Chainlink feeds", () => {
    expect(sources.sources.SPY).toEqual({ kind: "mainnet-mirror", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", description: "RHSPY / USD" });
    expect(sources.sources.QQQ).toEqual({ kind: "mainnet-mirror", feed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae", description: "Robinhood QQQ / USD" });
  });

  it("not deployed yet: not mirrored (and not an error)", () => {
    expect(keeperSymbols({ TSLA: TSLA_TESTNET }, sources).map((s) => s.symbol)).toEqual(["TSLA"]);
  });

  it("deployed: each testnet feed is paired with its own mainnet feed", () => {
    const paired = keeperSymbols({ TSLA: TSLA_TESTNET, SPY: SPY_TESTNET, QQQ: QQQ_TESTNET }, sources);
    expect(paired.map((s) => [s.symbol, s.testnetFeed, s.source.kind === "mainnet-mirror" ? s.source.feed : null])).toEqual([
      ["TSLA", TSLA_TESTNET, "0x4A1166a659A55625345e9515b32adECea5547C38"],
      ["SPY", SPY_TESTNET, "0x319724394D3A0e3669269846abE664Cd621f9f6A"],
      ["QQQ", QQQ_TESTNET, "0x80901d846d5D7B030F26B480776EE3b29374C2ae"],
    ]);
  });

  it("a deployed feed with no source is refused loudly", () => {
    expect(() => keeperSymbols({ DIA: TSLA_TESTNET }, sources)).toThrow("DIA is deployed but has no entry");
  });

  it("the keeper copies each ETF's mainnet round, price and time, onto its stand-in feed", async () => {
    const mainnet: Record<string, { answer: bigint; updatedAt: bigint }> = {
      "0x319724394D3A0e3669269846abE664Cd621f9f6A": { answer: 76_843_289_680n, updatedAt: 1_790_309_069n },
      "0x80901d846d5D7B030F26B480776EE3b29374C2ae": { answer: 74_178_447_201n, updatedAt: 1_790_268_066n },
    };
    const writes: Array<{ feed: string; answer: bigint; updatedAt: bigint }> = [];
    const results = await runOnce({
      symbols: keeperSymbols({ SPY: SPY_TESTNET, QQQ: QQQ_TESTNET }, sources),
      readMainnet: async (feed) => mainnet[feed]!,
      readPublicQuote: async () => null,
      readTestnet: async () => ({ answer: 1n, updatedAt: NOW - 200_000n }),
      testnetNow: async () => NOW,
      write: async (feed, round) => {
        writes.push({ feed, ...round });
        return "0xabc";
      },
      log: () => {},
    });
    expect(results.map((r) => [r.symbol, r.plan])).toEqual([
      ["SPY", "write"],
      ["QQQ", "write"],
    ]);
    expect(writes).toEqual([
      { feed: SPY_TESTNET, answer: 76_843_289_680n, updatedAt: 1_790_309_069n },
      { feed: QQQ_TESTNET, answer: 74_178_447_201n, updatedAt: 1_790_268_066n },
    ]);
  });
});
