/**
 * viem public client for the chain named in the deployment file.
 */
import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient, type Transport } from "viem";

import type { Config } from "./config.js";
import type { Deployment } from "./deployment.js";
import { rpcUrls } from "./rpc.js";

export function chainFor(deployment: Deployment, config: Config): Chain {
  return defineChain({
    id: deployment.chainId,
    name: deployment.chainId === 46_630 ? "Robinhood Chain Testnet" : `Chain ${deployment.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls(config) } },
    blockExplorers: { default: { name: "Blockscout", url: config.EXPLORER_URL } },
  });
}

/**
 * Reads made in the same tick are sent as one JSON-RPC batch. A round trip to the public testnet RPC costs ~0.6s, and a
 * batch of 30 calls costs about the same, so batching is what keeps a quote to a few round trips instead of dozens.
 */
export function createChainClient(chain: Chain, urls: string[]): PublicClient {
  return createPublicClient({ chain, transport: chainTransport(urls, { batch: true }), batch: { multicall: false } });
}

/**
 * Every endpoint in order: when one fails or times out, the same request goes to the next. Each endpoint gets a
 * shorter timeout than before (8s) and one retry, so a dead primary costs seconds, not the old 60.
 */
export function chainTransport(urls: string[], opts: { batch?: boolean; timeout?: number } = {}): Transport {
  const transports = urls.map((u) =>
    http(u, { timeout: opts.timeout ?? 8_000, retryCount: 1, retryDelay: 250, ...(opts.batch ? { batch: { batchSize: 40, wait: 8 } } : {}) }),
  );
  return transports.length === 1 ? transports[0]! : fallback(transports, { retryCount: 1, retryDelay: 400 });
}
