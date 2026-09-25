/**
 * The keeper as a library: `createKeeper` connects, checks every feed it will write (a TestPriceFeed, owned by this
 * key, matching decimals) and returns `runOnce`, one mirroring pass. The CLI (src/index.ts) runs it once or on a loop;
 * the Glance API runs it in-process with `startKeeperLoop` (KEEPER_IN_PROCESS=1): a single instance at a time (a lock
 * file in DATA_DIR), the same nonce handling and freshness rules, the pause switch honoured, one log line per write.
 */
import { existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, fallback, http, isAddressEqual, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { runOnce, type KeeperSymbol, type PassResult } from "./keeper.ts";
import { pauseState } from "./pause.ts";
import { fetchYahooQuote } from "./quote.ts";
import { NonceSender, type ChainIO } from "./sender.ts";
import { keeperSymbols, loadPriceSources, loadTestnetFeeds } from "./sources.ts";

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

export interface KeeperOptions {
  privateKey: `0x${string}`;
  testnetRpcUrl: string;
  /** Used only when the primary can't be reached, then for the rest of that run. */
  testnetFallbackRpcUrl?: string;
  mainnetRpcUrl: string;
  deploymentFile: string;
  priceSourcesFile: string;
  log(line: string): void;
}

export interface Keeper {
  address: Address;
  chainId: number;
  symbols: KeeperSymbol[];
  runOnce(): Promise<PassResult[]>;
}

export async function createKeeper(o: KeeperOptions): Promise<Keeper> {
  const { chainId, feeds } = loadTestnetFeeds(o.deploymentFile);
  const sources = loadPriceSources(o.priceSourcesFile);
  const account = privateKeyToAccount(o.privateKey);

  // The public mainnet RPC rate-limits and rejects large batches: no batching, gentle retries.
  const mainnet = createPublicClient({ transport: http(o.mainnetRpcUrl, { retryCount: 4, retryDelay: 1_500, timeout: 15_000 }) });
  // Reads may use either testnet RPC. Nonces, sends and receipts stay on one RPC per run (src/sender.ts).
  const rpcs = [o.testnetRpcUrl, ...(o.testnetFallbackRpcUrl && o.testnetFallbackRpcUrl !== o.testnetRpcUrl ? [o.testnetFallbackRpcUrl] : [])];
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
  const sender = new NonceSender(chainIO(o.testnetRpcUrl, "the primary RPC"), rpcs[1] ? chainIO(rpcs[1], "the fallback RPC") : null, { log: o.log });

  const [testnetChainId, mainnetChainId] = await Promise.all([testnet.getChainId(), mainnet.getChainId()]);
  if (testnetChainId !== chainId) throw new Error(`the testnet RPC is chain ${testnetChainId}, deployment is ${chainId}`);
  if (mainnetChainId !== sources.mainnet.chainId) {
    throw new Error(`the mainnet RPC is chain ${mainnetChainId}, expected ${sources.mainnet.name} (${sources.mainnet.chainId})`);
  }

  const symbols: KeeperSymbol[] = keeperSymbols(feeds, sources, o.priceSourcesFile);

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

  const deps = {
    symbols,
    log: o.log,
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
  return { address: account.address, chainId, symbols, runOnce: () => runOnce(deps) };
}

// ---------------------------------------------------------------------------------------------------------------------
// One keeper at a time: a lock file

/**
 * A lock file (in DATA_DIR): created exclusively, its time refreshed on every pass. A lock nobody has refreshed for
 * `staleMs` (its instance died without cleaning up) is taken over. Two keepers on one key would fight over nonces.
 */
export class KeeperLock {
  private readonly file: string;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly token = randomUUID();

  constructor(file: string, staleMs: number, now: () => number = Date.now) {
    this.file = file;
    this.staleMs = staleMs;
    this.now = now;
  }

  private write(flag: "wx" | "w") {
    writeFileSync(this.file, JSON.stringify({ token: this.token, pid: process.pid, host: hostname(), at: new Date(this.now()).toISOString() }), { flag });
    this.refresh(); // its time is this lock's clock, the one staleness is measured with
  }

  private mine(): boolean {
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")) as { token?: string }).token === this.token;
    } catch {
      return false;
    }
  }

  /** True if this instance holds the lock now (it may have just taken it, or taken over a stale one). */
  acquire(): boolean {
    if (this.mine()) {
      this.refresh();
      return true;
    }
    try {
      this.write("wx");
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let age: number;
    try {
      age = this.now() - statSync(this.file).mtimeMs;
    } catch {
      return this.acquire(); // released in between
    }
    if (age < this.staleMs) return false;
    this.write("w");
    return this.mine(); // two takers at once: the last write wins, the other sees it isn't theirs
  }

  refresh() {
    const t = new Date(this.now());
    try {
      utimesSync(this.file, t, t);
    } catch {
      // gone: the next acquire recreates it
    }
  }

  release() {
    if (this.mine()) {
      try {
        unlinkSync(this.file);
      } catch {
        // already gone
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The in-process loop

export interface LoopOptions {
  intervalMs: number;
  lockFile: string;
  pauseFile: string;
  /** Every line (the API filters them to one per write). */
  log(line: string): void;
  /** Builds the keeper (connects and checks the feeds). Retried every `retryMs` if it fails. */
  create(): Promise<Keeper>;
  retryMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Runs `runOnce` every `intervalMs` (never overlapping), while this instance holds the lock. Returns stop(). */
export function startKeeperLoop(o: LoopOptions): { stop(): void; running(): boolean } {
  const lock = new KeeperLock(o.lockFile, Math.max(3 * o.intervalMs, 120_000), o.now);
  let keeper: Keeper | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitingSaid = false;
  let pausedSaid = false;
  const retryMs = o.retryMs ?? 5 * 60_000;
  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };

  async function tick() {
    if (stopped) return;
    if (!lock.acquire()) {
      if (!waitingSaid) o.log("keeper: another instance holds the lock; this one waits (two keepers on one key would fight over nonces)");
      waitingSaid = true;
      return schedule(o.intervalMs);
    }
    waitingSaid = false;
    const pause = pauseState(o.env ?? process.env, existsSync(o.pauseFile), o.pauseFile);
    if (pause.paused) {
      if (!pausedSaid) o.log(`keeper paused (${pause.reason}): nothing written`);
      pausedSaid = true;
      return schedule(o.intervalMs);
    }
    if (pausedSaid) o.log("keeper resumed");
    pausedSaid = false;
    if (!keeper) {
      try {
        keeper = await o.create();
        o.log(`keeper in-process: every ${Math.round(o.intervalMs / 1000)}s as ${keeper.address}, ${keeper.symbols.length} feeds on chain ${keeper.chainId}`);
      } catch (err) {
        o.log(`keeper not started: ${(err as Error).message.split("\n")[0]}; trying again in ${Math.round(retryMs / 60_000)} min`);
        return schedule(retryMs);
      }
    }
    try {
      await keeper.runOnce();
    } catch (err) {
      o.log(`keeper pass failed: ${(err as Error).message.split("\n")[0]}`);
    }
    lock.refresh();
    schedule(o.intervalMs);
  }

  schedule(0);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      lock.release();
    },
    running: () => keeper !== null && !stopped,
  };
}
