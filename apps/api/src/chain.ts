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

/**
 * Reads made in the same tick are sent as one JSON-RPC batch. A round trip to the public testnet RPC costs ~0.6s, and a
 * batch of 30 calls costs about the same, so batching is what keeps a quote to a few round trips instead of dozens.
 */
export function createChainClient(chain: Chain, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2, batch: { batchSize: 40, wait: 8 } }),
    batch: { multicall: false },
  });
}
