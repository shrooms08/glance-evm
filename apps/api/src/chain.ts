/**
 * viem public client for the chain named in the deployment file.
 */
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";

import type { Config } from "./config.js";
import type { Deployment } from "./deployment.js";

export function chainFor(deployment: Deployment, config: Config): Chain {
  return defineChain({
    id: deployment.chainId,
    name: deployment.chainId === 46_630 ? "Robinhood Chain Testnet" : `Chain ${deployment.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.RPC_URL] } },
    blockExplorers: { default: { name: "Blockscout", url: config.EXPLORER_URL } },
  });
}

export function createChainClient(chain: Chain, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
    batch: { multicall: false },
  });
}
