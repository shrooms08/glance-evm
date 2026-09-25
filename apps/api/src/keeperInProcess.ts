/**
 * The feed keeper inside the API process (KEEPER_IN_PROCESS=1), for a single hosted service: every KEEPER_INTERVAL_MS
 * it mirrors the mainnet Chainlink feeds onto the testnet stand-ins with the keeper's own code (apps/keeper: nonce
 * handling, freshness rules, the pause switch), from KEEPER_PRIVATE_KEY, the feeds' owner. One instance at a time: a
 * lock file in DATA_DIR (a second instance waits, and takes over only a lock nobody has refreshed for minutes).
 *
 * Logs: one line per write (and per error, retry or RPC switch). The per-feed "unchanged" lines and the per-pass
 * summary are left out: every 30 seconds they would drown everything else.
 */
import { join } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { isAddressEqual } from "viem";
import { createKeeper, startKeeperLoop } from "keeper/service";

import type { Config } from "./config.js";

/** Robinhood Chain testnet's public RPC: the keeper's fallback when RPC_URL can't be reached. */
const PUBLIC_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

/** Whether a keeper line is worth a log line in-process: writes, errors, retries, switches; not the routine skips. */
export const keeperLogLine = (line: string) => !/: unchanged, skipped|: held, |^summary: /.test(line);

export interface InProcessKeeper {
  stop(): void;
  running(): boolean;
  lockFile: string;
}

/** Starts the loop, or says why not (one line). Never throws: a keeper problem never stops the API. */
export function startInProcessKeeper(config: Config, log: (line: string) => void = (l) => console.log(l)): InProcessKeeper | null {
  if (!config.KEEPER_IN_PROCESS) return null;
  if (!config.KEEPER_PRIVATE_KEY) {
    log("[keeper] KEEPER_IN_PROCESS=1 but KEEPER_PRIVATE_KEY is not set: the keeper is not running");
    return null;
  }
  const keeperAddress = privateKeyToAccount(config.KEEPER_PRIVATE_KEY as `0x${string}`).address;
  if (config.AGENT_PRIVATE_KEY && isAddressEqual(privateKeyToAccount(config.AGENT_PRIVATE_KEY as `0x${string}`).address, keeperAddress)) {
    log("[keeper] KEEPER_PRIVATE_KEY is the agent key: refusing to run (trades and feed writes would fight over nonces)");
    return null;
  }
  const lockFile = join(config.DATA_DIR ?? config.LLM_CACHE_DIR, "keeper.lock");
  const stamp = (line: string) => `[keeper] ${line}`;
  const loop = startKeeperLoop({
    intervalMs: config.KEEPER_INTERVAL_MS,
    lockFile,
    pauseFile: config.KEEPER_PAUSE_FILE,
    log: (line) => keeperLogLine(line) && log(stamp(line)),
    create: () =>
      createKeeper({
        privateKey: config.KEEPER_PRIVATE_KEY as `0x${string}`,
        testnetRpcUrl: config.RPC_URL,
        testnetFallbackRpcUrl: PUBLIC_TESTNET_RPC,
        mainnetRpcUrl: config.RPC_MAINNET_URL,
        deploymentFile: config.DEPLOYMENT_FILE,
        priceSourcesFile: config.PRICE_SOURCES_FILE,
        log: (line) => keeperLogLine(line) && log(stamp(line)),
      }),
  });
  return { ...loop, lockFile };
}
