/**
 * Telling "the chain is unreachable" apart from "the chain answered no".
 *
 * A public testnet RPC times out, rate-limits and drops connections. None of that says anything about a vault, so it
 * must never be reported as one ("isn't a Glance vault", or a guard refusing a trade). RPC trouble becomes
 * RPC_UNAVAILABLE (503): the extension says the testnet isn't responding, retries reads with backoff, and recovers on
 * its own. Only when the chain actually answered (no code at the address, a call that returned nothing or reverted)
 * do we say what the answer means.
 */
import {
  BaseError,
  CallExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
  WebSocketRequestError,
} from "viem";

import type { Config } from "./config.js";

export const RPC_TROUBLE_MESSAGE = "The Robinhood Chain testnet isn't responding right now. Trying again…";

/** RPC_URL first, then RPC_FALLBACK_URLS (comma separated), without duplicates. */
export function rpcUrls(config: Pick<Config, "RPC_URL" | "RPC_FALLBACK_URLS">): string[] {
  const all = [config.RPC_URL, ...config.RPC_FALLBACK_URLS.split(",")].map((u) => u.trim()).filter(Boolean);
  return [...new Set(all)];
}

/** Hides credentials in URLs for logs (QuickNode puts its token in the path). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host;
    return u.pathname.length > 1 || u.search ? `${u.protocol}//${host}/…` : `${u.protocol}//${host}`;
  } catch {
    return "(invalid URL)";
  }
}

const NETWORK_CODES = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|socket hang up|fetch failed|network|aborted/i;

/** True when the failure is the RPC (or the network to it), not an answer from the chain. */
export function isRpcTrouble(err: unknown): boolean {
  if (!(err instanceof BaseError)) {
    const e = err as { name?: string; message?: string; code?: string } | null;
    return Boolean(e && (e.name === "AbortError" || e.name === "TimeoutError" || NETWORK_CODES.test(`${e.code ?? ""} ${e.message ?? ""}`)));
  }
  // The chain answered: a revert, or a call to something that isn't what we expected.
  if (err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError)) return false;
  const trouble = err.walk(
    (e) =>
      e instanceof HttpRequestError ||
      e instanceof TimeoutError ||
      e instanceof WebSocketRequestError ||
      e instanceof LimitExceededRpcError ||
      (e instanceof InternalRpcError && !(err instanceof CallExecutionError)) ||
      // Rate limits and gateway errors that arrive as JSON-RPC errors.
      (e instanceof RpcRequestError && [-32005, -32603, 429, 502, 503, 504].includes(e.code)),
  );
  if (trouble) return true;
  // A plain network failure wrapped by viem.
  return Boolean(err.walk((e) => NETWORK_CODES.test((e as Error).message ?? "")) && !err.walk((e) => (e as { data?: unknown }).data !== undefined));
}
