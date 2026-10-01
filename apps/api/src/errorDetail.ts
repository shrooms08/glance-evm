/**
 * What actually failed, in one short line, for the log and for the extension's console: the contract call (function
 * and address), the RPC method, the HTTP status or JSON-RPC code, and the provider's own message. Never a URL: any
 * URL in a message is cut to its host (QuickNode and others put the key in the path), and no request body is kept.
 */
import { BaseError, ContractFunctionExecutionError, HttpRequestError, RpcRequestError } from "viem";

import { redactUrl } from "./rpc.js";

const URLS = /\bhttps?:\/\/[^\s"'`)]+/gi;
const MAX = 300;

/** Any URL in `text`, cut to its host. */
export const scrubUrls = (text: string) => text.replace(URLS, (u) => redactUrl(u));

const firstLine = (s: string | undefined) => (s ?? "").split("\n")[0]!.trim();

export function errorDetail(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof BaseError) {
    const call = err.walk((e) => e instanceof ContractFunctionExecutionError) as ContractFunctionExecutionError | null;
    if (call) parts.push(`${call.functionName}() on ${call.contractAddress ?? "?"}`);
    const http = err.walk((e) => e instanceof HttpRequestError) as HttpRequestError | null;
    if (http) {
      const body = http.body as { method?: string } | Array<{ method?: string }> | undefined;
      const methods = Array.isArray(body) ? [...new Set(body.map((b) => b.method).filter(Boolean))].join(",") : body?.method;
      parts.push(`${methods ? `${methods} ` : ""}HTTP ${http.status ?? "?"}`);
    }
    const rpc = err.walk((e) => e instanceof RpcRequestError) as RpcRequestError | null;
    if (rpc) parts.push(`RPC error ${rpc.code}`);
    parts.push(`${err.name}: ${firstLine(err.shortMessage)}`);
    const details = firstLine(err.details);
    if (details && !parts.some((p) => p.includes(details))) parts.push(details);
  } else if (err instanceof Error) {
    parts.push(`${err.name}: ${firstLine(err.message)}`);
  } else parts.push(String(err));
  return scrubUrls(parts.join(" · ")).slice(0, MAX);
}

/** What a failed contract call was reading, in the user's words (for the message the card shows). */
const READS: Array<[RegExp, string]> = [
  [/^(latestRoundData|decimals|tokenConfig)$/, "the stock's price"],
  [/^(quoteBuy|quoteSell|spreadBps)$/, "the desk's quote"],
  [/^(balanceOf|allowance)$/, "your vault's balance"],
];

/** What the failed read was, when a contract call failed ("the stock's price"); null when it's not known. */
export function whatFailed(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const call = err.walk((e) => e instanceof ContractFunctionExecutionError) as ContractFunctionExecutionError | null;
  if (!call) return null;
  for (const [re, what] of READS) if (re.test(call.functionName)) return what;
  return "your vault's limits";
}

/** The card's message for a chain read that failed: what couldn't be read (when known), and that trying again is fine. */
export const chainReadMessage = (err: unknown) => {
  const what = whatFailed(err);
  return what ? `I couldn't read ${what} from the chain. Try again in a few seconds.` : "I couldn't read from the chain. Try again in a few seconds.";
};
