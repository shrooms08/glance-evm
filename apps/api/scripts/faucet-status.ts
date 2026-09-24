/**
 * The starter fund's wallet: its ETH and USDG, and what it sent today against the daily caps (the same as /health's
 * admin view). Reads FAUCET_PRIVATE_KEY from apps/api/.env only to know the wallet's address; the key is never printed.
 *
 *   make faucet-status
 */
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";

const ctx = createContext(loadConfig(), () => {});
if (!ctx.faucet) {
  console.log("The starter fund is off: FAUCET_PRIVATE_KEY isn't set in apps/api/.env (make faucet-wallet creates one).");
  process.exit(0);
}
const s = await ctx.faucet.status();
console.log(`Faucet wallet ${s.address}`);
console.log(`  holds       ${s.balances.eth} ETH, ${s.balances.usdg} USDG`);
console.log(`  sent today  ${s.today.eth} of ${s.caps.eth} ETH, ${s.today.usdg} of ${s.caps.usdg} USDG (${s.today.day}, UTC)`);
const stock = await ctx.faucet.stock();
if (!stock.gas) console.log("  low on ETH: Get started will point people to the Robinhood testnet faucet instead.");
if (!stock.usdg) console.log("  low on USDG: Get started will point people to the Paxos faucet instead.");
