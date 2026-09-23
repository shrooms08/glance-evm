/**
 * THE AGENT KEY
 *
 * This module is the only place the agent's private key (AGENT_PRIVATE_KEY) is read. The key is a hot key on a server,
 * so it must be assumed stealable. It is safe to hold here only because GlanceVault bounds it on chain:
 *
 *   What this key CAN do, and only while its vault's owner has authorised it and before its expiry (at most 30 days):
 *     - call buy() and sell() on vaults that list it as their agent,
 *     - for tokens and routers the owner approved,
 *     - within the per-trade cap and the rolling 24h buy and sell caps (cut to the weekend fraction when the market
 *       is closed),
 *     - at a price no worse than the oracle price minus the vault's slippage limit,
 *     - with every swap's output delivered back into the vault.
 *
 *   What this key can NEVER do, whatever code runs here:
 *     - withdraw funds, or send them anywhere but back into the vault,
 *     - change limits, approve tokens or routers, pause or unpause, or set the sequencer feed,
 *     - extend its own expiry or appoint another agent.
 *
 * So the worst case of a stolen key is bounded, approved, oracle-priced trading until the owner revokes it. It is still
 * treated as a secret: it is never logged, never returned by any endpoint, and never included in an error message.
 */
import { createWalletClient, type Account, type Chain, type WalletClient } from "viem";

import { chainTransport } from "./chain.js";
import { privateKeyToAccount } from "viem/accounts";

export interface AgentSigner {
  account: Account;
  wallet: WalletClient;
  /** Runs `fn` with exclusive use of the key, so concurrent trades never race on the nonce. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function loadAgentSigner(privateKey: string | undefined, chain: Chain, rpcUrls: string[]): AgentSigner | null {
  if (!privateKey) return null;
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: chainTransport(rpcUrls, { timeout: 30_000 }) });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    account,
    wallet,
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
