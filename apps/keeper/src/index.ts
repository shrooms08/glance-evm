/**
 * Feed keeper CLI.
 *
 *   pnpm --filter keeper once     one pass, for cron and GitHub Actions
 *   pnpm --filter keeper watch    loop every KEEPER_INTERVAL_SECONDS (default 120), for local use while recording
 *
 * Mirrors each live Chainlink feed on Robinhood Chain mainnet, price AND updatedAt, onto our TestPriceFeed stand-in on
 * the testnet (see src/mirror.ts for why updatedAt is copied and never set to "now"). NFLX has no Chainlink feed and
 * uses a public quote with the quote's own timestamp. Respects the pause switch (src/pause.ts).
 */
import { existsSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  isAddressEqual,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadEnv, paths } from "./config.js";
import { exitCodeFor, runOnce, type KeeperSymbol } from "./keeper.js";
import { pauseState } from "./pause.js";
import { NonceSender, type ChainIO } from "./sender.js";
import { fetchYahooQuote } from "./quote.js";
import { keeperSymbols, loadPriceSources, loadTestnetFeeds } from "./sources.js";

const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const testFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function owner() view returns (address)",
  "function isTestFeed() view returns (bool)",
  "function setRoundData(int256 answer_, uint256 updatedAt_)",
]);

const log = (line: string) => console.log(`${new Date().toISOString().slice(0, 19)}Z ${line}`);

function paused(): boolean {
  const state = pauseState(process.env, existsSync(paths.pauseFile), paths.pauseFile);
  if (state.paused) log(`keeper paused (${state.reason}): nothing written. Run \`make keeper-resume\` to resume.`);
  return state.paused;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const watch = args.has("--watch");
  if (!watch && !args.has("--once")) throw new Error("Usage: keeper --once | --watch");

  if (paused() && !watch) return;

  const env = loadEnv();
  const { chainId, feeds } = loadTestnetFeeds(paths.deployment);
  const sources = loadPriceSources(paths.priceSources);
  const account = privateKeyToAccount(env.KEEPER_PRIVATE_KEY as `0x${string}`);

  // The public mainnet RPC rate-limits and rejects large batches: no batching, gentle retries.
  const mainnet = createPublicClient({ transport: http(env.MAINNET_RPC_URL, { retryCount: 4, retryDelay: 1_500, timeout: 15_000 }) });
  // Reads may use either testnet RPC. Nonces, sends and receipts stay on one RPC per run (src/sender.ts).
  const rpcs = [env.TESTNET_RPC_URL, ...(env.TESTNET_FALLBACK_RPC_URL !== env.TESTNET_RPC_URL ? [env.TESTNET_FALLBACK_RPC_URL] : [])];
  const testnet = createPublicClient({ transport: fallback(rpcs.map((url) => http(url, { retryCount: 3, timeout: 20_000 }))) });
  const chainIO = (url: string, name: string): ChainIO => {
    const reader = createPublicClient({ transport: http(url, { retryCount: 1, timeout: 20_000 }) });
    const wallet = createWalletClient({ account, transport: http(url, { retryCount: 0, timeout: 30_000 }) });
    return {
      name,
      pendingNonce: () => reader.getTransactionCount({ address: account.address, blockTag: "pending" }),
      send: (feed, round, nonce) =>
        wallet.writeContract({ chain: null, address: feed, abi: testFeedAbi, functionName: "setRoundData", args: [round.answer, round.updatedAt], nonce }),
      receipt: async (hash) => (await reader.waitForTransactionReceipt({ hash, timeout: 60_000 })).status,
    };
  };
  const sender = new NonceSender(chainIO(env.TESTNET_RPC_URL, "the primary RPC"), rpcs[1] ? chainIO(rpcs[1], "the fallback RPC") : null, { log });

  const [testnetChainId, mainnetChainId] = await Promise.all([testnet.getChainId(), mainnet.getChainId()]);
  if (testnetChainId !== chainId) throw new Error(`TESTNET_RPC_URL is chain ${testnetChainId}, deployment is ${chainId}`);
  if (mainnetChainId !== sources.mainnet.chainId) {
    throw new Error(`MAINNET_RPC_URL is chain ${mainnetChainId}, expected ${sources.mainnet.name} (${sources.mainnet.chainId})`);
  }

  const symbols: KeeperSymbol[] = keeperSymbols(feeds, sources, paths.priceSources);

  // Fail loudly on anything that would make a write wrong or impossible.
  for (const s of symbols) {
    const [owner, isTest, decimals] = await Promise.all([
      testnet.readContract({ address: s.testnetFeed, abi: testFeedAbi, functionName: "owner" }),
      testnet.readContract({ address: s.testnetFeed, abi: testFeedAbi, functionName: "isTestFeed" }),
      testnet.readContract({ address: s.testnetFeed, abi: testFeedAbi, functionName: "decimals" }),
    ]);
    if (!isTest) throw new Error(`${s.symbol}: ${s.testnetFeed} is not a TestPriceFeed; refusing to write`);
    if (!isAddressEqual(owner, account.address)) {
      throw new Error(`${s.symbol}: feed ${s.testnetFeed} is owned by ${owner}, not by the keeper key ${account.address}`);
    }
    if (s.source.kind === "mainnet-mirror") {
      const mainDecimals = await mainnet.readContract({ address: s.source.feed, abi: aggregatorAbi, functionName: "decimals" });
      if (mainDecimals !== decimals) throw new Error(`${s.symbol}: mainnet feed has ${mainDecimals} decimals, testnet feed ${decimals}`);
    } else if (decimals !== 8) {
      throw new Error(`${s.symbol}: public quotes are written with 8 decimals, testnet feed has ${decimals}`);
    }
  }

  log(`keeper ${watch ? `watching every ${env.KEEPER_INTERVAL_SECONDS}s` : "single pass"} as ${account.address}, ${symbols.length} feeds on chain ${chainId}`);

  const deps = {
    symbols,
    log,
    readMainnet: async (feed: Address) => {
      const [, answer, , updatedAt] = await mainnet.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" });
      return { answer, updatedAt };
    },
    readPublicQuote: (symbol: string) => fetchYahooQuote(symbol),
    readTestnet: async (feed: Address) => {
      const [, answer, , updatedAt] = await testnet.readContract({ address: feed, abi: testFeedAbi, functionName: "latestRoundData" });
      return { answer, updatedAt };
    },
    testnetNow: async () => (await testnet.getBlock({ blockTag: "latest" })).timestamp,
    startRun: () => sender.startRun(),
    write: (feed: Address, round: { answer: bigint; updatedAt: bigint }) => sender.write(feed, round),
  };

  if (!watch) {
    // Exit 1 only when a feed still failed after its retries; the others were written regardless.
    process.exitCode = exitCodeFor(await runOnce(deps));
    return;
  }

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    log("stopping after this pass");
  });
  while (!stopping) {
    if (!paused()) await runOnce(deps);
    await new Promise((r) => setTimeout(r, env.KEEPER_INTERVAL_SECONDS * 1000));
  }
}

main().catch((err: Error) => {
  console.error(`keeper: ${err.message.split("\n").slice(0, 6).join("\n")}`);
  process.exit(1);
});
