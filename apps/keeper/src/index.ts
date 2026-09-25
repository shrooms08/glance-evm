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

import { loadEnv, paths } from "./config.ts";
import { exitCodeFor } from "./keeper.ts";
import { pauseState } from "./pause.ts";
import { createKeeper } from "./service.ts";

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
  // Connects, and fails loudly on anything that would make a write wrong or impossible (src/service.ts).
  const keeper = await createKeeper({
    privateKey: env.KEEPER_PRIVATE_KEY as `0x${string}`,
    testnetRpcUrl: env.TESTNET_RPC_URL,
    testnetFallbackRpcUrl: env.TESTNET_FALLBACK_RPC_URL,
    mainnetRpcUrl: env.MAINNET_RPC_URL,
    deploymentFile: paths.deployment,
    priceSourcesFile: paths.priceSources,
    log,
  });

  log(`keeper ${watch ? `watching every ${env.KEEPER_INTERVAL_SECONDS}s` : "single pass"} as ${keeper.address}, ${keeper.symbols.length} feeds on chain ${keeper.chainId}`);

  if (!watch) {
    // Exit 1 only when a feed still failed after its retries; the others were written regardless.
    process.exitCode = exitCodeFor(await keeper.runOnce());
    return;
  }

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    log("stopping after this pass");
  });
  while (!stopping) {
    if (!paused()) await keeper.runOnce();
    await new Promise((r) => setTimeout(r, env.KEEPER_INTERVAL_SECONDS * 1000));
  }
}

main().catch((err: Error) => {
  console.error(`keeper: ${err.message.split("\n").slice(0, 6).join("\n")}`);
  process.exit(1);
});
