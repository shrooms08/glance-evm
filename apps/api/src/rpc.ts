// The classifier, the message and the transport live in @glance/core (packages/core), shared with the console.
import { orderedRpcUrls } from "@glance/core/rpc";

import type { Config } from "./config.js";

export { chainTransport, isRpcTrouble, redactUrl, RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";

/** RPC_URL first, then RPC_FALLBACK_URLS (comma separated), without duplicates. */
export function rpcUrls(config: Pick<Config, "RPC_URL" | "RPC_FALLBACK_URLS">): string[] {
  return orderedRpcUrls(config.RPC_URL, config.RPC_FALLBACK_URLS);
}
