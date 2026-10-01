/**
 * Telling "the chain is unreachable" apart from "the chain answered no", shared by the API and the console.
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
  UnknownRpcError,
  WebSocketRequestError,
  fallback,
  http,
  type Transport,
} from "viem";

export const RPC_TROUBLE_MESSAGE = "The Robinhood Chain testnet isn't responding right now. Trying again…";

/** The public Robinhood Chain testnet RPC: the default primary, and the default fallback behind a dedicated one. */
export const PUBLIC_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

/** The primary endpoint first, then the comma-separated fallbacks, without duplicates or blanks. */
export function orderedRpcUrls(primary: string | undefined, fallbacks: string | undefined): string[] {
  const all = [primary || PUBLIC_TESTNET_RPC, ...(fallbacks ?? PUBLIC_TESTNET_RPC).split(",")].map((u) => u.trim()).filter(Boolean);
  return [...new Set(all)];
}

/**
 * Every endpoint in order: when one fails or times out, the same request goes to the next. Each endpoint gets an 8s
 * timeout and one retry, so a dead primary costs seconds, not a minute.
 */
export function chainTransport(urls: string[], opts: { batch?: boolean; timeout?: number; maxCallsPerSecond?: number } = {}): Transport {
  const perSecond = opts.maxCallsPerSecond ?? RPC_MAX_CALLS_PER_SECOND;
  const transports = urls.map((u) =>
    http(u, {
      timeout: opts.timeout ?? 8_000,
      retryCount: 1,
      retryDelay: 250,
      // Under the provider's per-second limit (each call in a batch counts): over it, it rejects whole batches.
      fetchFn: callsPerSecondLimiter(u, perSecond),
      ...(opts.batch ? { batch: { batchSize: Math.min(20, perSecond), wait: 8 } } : {}),
    }),
  );
  return transports.length === 1 ? transports[0]! : fallback(transports, { retryCount: 1, retryDelay: 400 });
}

/**
 * Calls a second sent to one endpoint, at most. QuickNode's testnet plan allows 50 (every call in a batch counts);
 * past it, it answers a batch with one 429 object instead of an array, and the reads fail. Kept a little under it.
 */
export const RPC_MAX_CALLS_PER_SECOND = 40;

/** How many JSON-RPC calls a request body carries (a batch is an array). */
export function callsIn(body: unknown): number {
  if (typeof body !== "string") return 1;
  const t = body.trimStart();
  if (!t.startsWith("[")) return 1;
  try {
    const parsed = JSON.parse(t) as unknown[];
    return Math.max(1, parsed.length);
  } catch {
    return 1;
  }
}

const limiters = new Map<string, typeof fetch>();

/**
 * A fetch that waits before sending, so that no more than `perSecond` calls go to `url` in any second (shared by
 * every client in this process that uses the same endpoint).
 */
export function callsPerSecondLimiter(
  url: string,
  perSecond: number,
  deps: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): typeof fetch {
  const key = `${url}\n${perSecond}`;
  const shared = !deps.fetch && !deps.now && !deps.sleep ? limiters.get(key) : undefined;
  if (shared) return shared;
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sent: Array<{ at: number; n: number }> = [];
  let queue = Promise.resolve();
  const limited = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const n = Math.min(perSecond, callsIn(init?.body));
    // One at a time through the gate, in order: each waits until its calls fit in the last second.
    const gate = queue.then(async () => {
      for (;;) {
        const t = now();
        while (sent.length && t - sent[0]!.at >= 1_000) sent.shift();
        const used = sent.reduce((s, x) => s + x.n, 0);
        if (used + n <= perSecond) {
          sent.push({ at: t, n });
          return;
        }
        await sleep(Math.max(5, 1_000 - (t - sent[0]!.at)));
      }
    });
    queue = gate.catch(() => {});
    return gate.then(() => doFetch(input, init));
  }) as typeof fetch;
  if (!deps.fetch && !deps.now && !deps.sleep) limiters.set(key, limited);
  return limited;
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

const RATE_LIMITED = /request limit reached|rate limit|too many requests|reduce calls per second/i;
const NETWORK_CODES = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|socket hang up|fetch failed|network|aborted/i;

/** True when the failure is the RPC (or the network to it), not an answer from the chain. */
export function isRpcTrouble(err: unknown): boolean {
  if (!(err instanceof BaseError)) {
    const e = err as { name?: string; message?: string; code?: string } | null;
    return Boolean(e && (e.name === "AbortError" || e.name === "TimeoutError" || NETWORK_CODES.test(`${e.code ?? ""} ${e.message ?? ""}`) || RATE_LIMITED.test(e.message ?? "")));
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
      // Rate limits and gateway errors that arrive as JSON-RPC errors (-32007: QuickNode's per-second limit).
      (e instanceof RpcRequestError && [-32005, -32007, -32603, 429, 502, 503, 504].includes(e.code)) ||
      // A batch the provider rejected whole (a 429 object where an array was due): viem can't map it to its calls.
      e instanceof UnknownRpcError,
  );
  if (trouble) return true;
  // A rate limit, however it's worded.
  if (err.walk((e) => RATE_LIMITED.test((e as Error).message ?? ""))) return true;
  // A plain network failure wrapped by viem.
  return Boolean(err.walk((e) => NETWORK_CODES.test((e as Error).message ?? "")) && !err.walk((e) => (e as { data?: unknown }).data !== undefined));
}
