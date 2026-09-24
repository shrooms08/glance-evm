/**
 * Creates the "Get gas" faucet wallet and writes its key straight into apps/api/.env as FAUCET_PRIVATE_KEY. The key is
 * never printed: only the wallet's address is, so you can fund it.
 *
 *   make faucet-wallet
 *
 * If FAUCET_PRIVATE_KEY is already set, nothing changes and the existing wallet's address is shown. An empty
 * FAUCET_PRIVATE_KEY= line (as in a copied .env.example) is filled in place.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const file = resolve(import.meta.dirname, "../.env");
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
const current = /^FAUCET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(text)?.[1];

if (current) {
  console.log(`FAUCET_PRIVATE_KEY is already set in apps/api/.env (wallet ${privateKeyToAccount(current as `0x${string}`).address}). Nothing changed.`);
} else {
  const key = generatePrivateKey();
  const line = `FAUCET_PRIVATE_KEY=${key}`;
  const next = /^FAUCET_PRIVATE_KEY=\s*$/m.test(text) ? text.replace(/^FAUCET_PRIVATE_KEY=\s*$/m, line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(file, next, { mode: 0o600 });
  console.log(`Faucet wallet ${privateKeyToAccount(key).address} created; its key is in apps/api/.env (not shown).`);
  console.log("Fund it with test ETH (0.01 covers a day at the default cap), then restart the API.");
}
