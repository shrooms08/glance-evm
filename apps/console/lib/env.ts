/**
 * The console's settings, from NEXT_PUBLIC_* variables (inlined at build time, so each is referenced literally).
 * See .env.example.
 */
import { orderedRpcUrls } from "@glance/core/rpc";

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export const env = {
  apiUrl: trimSlash(process.env.NEXT_PUBLIC_GLANCE_API_URL || "http://localhost:8790"),
  /** RPC_URL first, then each fallback: the API's own primary-plus-fallback behaviour. */
  rpcUrls: orderedRpcUrls(process.env.NEXT_PUBLIC_RPC_URL, process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS),
  explorerUrl: trimSlash(process.env.NEXT_PUBLIC_EXPLORER_URL || "https://explorer.testnet.chain.robinhood.com"),
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "",
  /** Where the built extension's zip is downloaded from (the install page). Empty: the page says how to build it. */
  extensionDownloadUrl: process.env.NEXT_PUBLIC_EXTENSION_DOWNLOAD_URL || "",
} as const;
