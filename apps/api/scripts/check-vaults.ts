/**
 * Read-only demo check: every demo vault must be able to quote a $10 TSLA buy, and the on-chain preflight (a
 * simulated vault.buy as the agent, every guard included) must pass. Sends no transactions and needs no key.
 *
 *   pnpm --filter api check-vaults          (or `make check-vaults` from the repository root)
 *   RPC_URL=http://127.0.0.1:8545 ...       (against a fork)
 * Exits 1 if any vault fails, with the vault's own reason.
 */
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { demoVaults } from "../src/deployment.js";
import { quoteView } from "../src/services.js";

const SYMBOL = process.env.CHECK_SYMBOL ?? "TSLA";
const AMOUNT = process.env.CHECK_AMOUNT ?? "10";

// No trades are sent, so the agent key is not needed; don't even load it.
const ctx = createContext(loadConfig({ ...process.env, AGENT_PRIVATE_KEY: "" }));
console.log(`Checking a $${AMOUNT} ${SYMBOL} buy on every demo vault (read-only) via ${ctx.config.RPC_URL}\n`);

let failures = 0;
for (const { key, vault, primary } of demoVaults(ctx.deployment)) {
  const label = `${key === "paxosUSDG" ? "Paxos USDG vault" : "TestUSDG vault"}${primary ? " (primary)" : " (fallback)"}`;
  try {
    const q = await quoteView(ctx, { vault: vault.address, symbol: SYMBOL, side: "buy", amount: AMOUNT });
    const ok = q.preflight.ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${vault.address}`);
    console.log(`      desk ${q.desk}: ${q.amountIn.formatted} buys ${q.deskQuote?.formatted ?? "nothing"} at $${Number(q.price.value).toFixed(2)} (market ${q.marketState.toLowerCase()}, price ${Math.round(q.priceAgeSeconds / 60)} min old)`);
    if (q.preflight.ok) console.log(`      preflight passed, simulated as agent ${q.preflight.simulatedAs}`);
    else console.log(`      preflight: ${q.preflight.guard.code}: ${q.preflight.guard.message}`);
    if (!ok) failures++;
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}  ${vault.address}\n      ${(err as Error).message}`);
  }
}
console.log(failures ? `\n${failures} vault(s) cannot trade right now.` : "\nBoth vaults can quote and would pass every guard.");
process.exit(failures ? 1 : 0);
