/**
 * Robinhood Chain testnet for wagmi and viem, with the RPC endpoints in order (primary, then fallbacks), exactly as
 * the API reads the chain.
 */
import { chainTransport } from "@glance/core/rpc";
import { createPublicClient, defineChain } from "viem";

import { CHAIN_ID } from "./deployment";
import { env } from "./env";

export const robinhoodTestnet = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: env.rpcUrls } },
  blockExplorers: { default: { name: "Robinhood Chain Explorer", url: env.explorerUrl } },
  // Standard infrastructure, not a Glance contract (those all come from deployments/46630.json): the canonical
  // Multicall3, deployed on this chain, lets a page's reads go out as one call.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const transport = chainTransport(env.rpcUrls);

/** Reads the console makes itself: owner checks, your own vault, balances, and waiting for your transactions. */
export const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });

export const txUrl = (hash: string) => `${env.explorerUrl}/tx/${hash}`;
export const addressUrl = (address: string) => `${env.explorerUrl}/address/${address}`;
