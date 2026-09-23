/**
 * Reads a real Robinhood Chain mainnet Chainlink feed and checks that what the keeper would write to our testnet feed
 * is exactly that feed's price and updatedAt. Skipped when the mainnet RPC is unreachable. Writes nothing.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { paths } from "../../src/config.js";
import { runOnce } from "../../src/keeper.js";
import type { Round } from "../../src/mirror.js";
import { loadPriceSources, loadTestnetFeeds } from "../../src/sources.js";

const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const abi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const client = createPublicClient({ transport: http(MAINNET_RPC, { retryCount: 3, retryDelay: 1_500, timeout: 10_000 }) });

async function reachable() {
  try {
    return (await client.getChainId()) === 4663;
  } catch {
    return false;
  }
}
const online = await reachable();

describe.skipIf(!online)("mirror against the real mainnet feed", () => {
  it("would write TSLA's real mainnet price and updatedAt, unchanged", async () => {
    const sources = loadPriceSources(paths.priceSources);
    const tsla = sources.sources.TSLA!;
    if (tsla.kind !== "mainnet-mirror") throw new Error("TSLA should be a mainnet mirror");
    const { feeds } = loadTestnetFeeds(paths.deployment);

    const [, answer, , updatedAt] = await client.readContract({ address: tsla.feed, abi, functionName: "latestRoundData" });
    expect(answer).toBeGreaterThan(0n);

    const writes: Round[] = [];
    const now = BigInt(Math.floor(Date.now() / 1000)) + 60n; // allow for clock skew
    await runOnce({
      symbols: [{ symbol: "TSLA", testnetFeed: feeds.TSLA!, source: tsla }],
      readMainnet: async (feed) => {
        const [, a, , u] = await client.readContract({ address: feed, abi, functionName: "latestRoundData" });
        return { answer: a, updatedAt: u };
      },
      readPublicQuote: async () => null,
      readTestnet: async () => ({ answer: 1n, updatedAt: 1n }), // force a write plan
      testnetNow: async () => now,
      write: async (_feed, round) => {
        writes.push(round);
        return "0x0";
      },
      log: () => {},
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.answer).toBe(answer);
    expect(writes[0]!.updatedAt).toBe(updatedAt);
    expect(writes[0]!.updatedAt).not.toBe(now);
  });
});
