/**
 * Whether the Robinhood Chain testnet is answering the Glance API. Public testnet RPCs time out and rate-limit; when
 * they do, the API says RPC_UNAVAILABLE (never "isn't a Glance vault"), the panel says the testnet isn't responding and
 * that it's trying again, reads retry with backoff, and everything recovers on its own the moment a call succeeds.
 */
export type ChainStatus = "ok" | "trouble";

let status: ChainStatus = "ok";
const listeners = new Set<(s: ChainStatus) => void>();

export const chainStatus = () => status;

export function setChainStatus(next: ChainStatus) {
  if (next === status) return;
  status = next;
  for (const l of [...listeners]) l(next);
}

export function onChainStatus(cb: (s: ChainStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Calls `cb` once, the next time the chain goes from trouble back to ok. */
export function onChainRecovered(cb: () => void): () => void {
  const off = onChainStatus((s) => {
    if (s !== "ok") return;
    off();
    cb();
  });
  return off;
}

/** For tests only. */
export function resetChainStatusForTests() {
  status = "ok";
  listeners.clear();
}
