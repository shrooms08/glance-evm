/**
 * Sends the keeper's writes with nonces it assigns itself, one after another.
 *
 * Why: run #7 wrote AMD, AMZN and PLTR, then TSLA failed with "Nonce provided is lower than the current nonce of the
 * account". Asking the RPC for a nonce before every write is fragile when the RPC is load-balanced (a node that hasn't
 * seen the last transaction yet hands out a nonce that is already used). So:
 *  - the deployer's PENDING nonce is fetched once per run, and each write takes the next one locally (+1 per tx);
 *  - writes go strictly one at a time: each waits for its receipt (with a timeout) before the next is sent;
 *  - a nonce error ("nonce too low", "lower than the current nonce", "already known", "replacement transaction
 *    underpriced") re-fetches the pending nonce, waits briefly, and retries that feed, at most MAX_RETRIES times;
 *  - one RPC serves the whole run for nonce reads, sends and receipts (the primary). Only if the primary is unreachable
 *    does the run move to the fallback RPC, and then it stays there.
 */
import type { Address, Hex } from "viem";

import type { Round } from "./mirror.js";

/** One RPC endpoint's view of the keeper account: its pending nonce, a send with a given nonce, and a receipt. */
export interface ChainIO {
  name: string;
  pendingNonce(): Promise<number>;
  send(feed: Address, round: Round, nonce: number): Promise<Hex>;
  /** Waits for the receipt (with its own timeout); throws on timeout. */
  receipt(hash: Hex): Promise<"success" | "reverted">;
}

export const MAX_RETRIES = 2;
export const RETRY_DELAY_MS = 2_000;

const NONCE_ERRORS = /nonce too low|lower than the current nonce|already known|replacement transaction underpriced/i;
const UNREACHABLE = /fetch failed|failed to fetch|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|HTTP request failed|took too long to respond|status: 5\d\d|\b50[234]\b/i;

/** The whole error text viem gives, including its causes (the node's message is often in a cause). */
function text(err: unknown): string {
  const parts: string[] = [];
  for (let e = err as { message?: string; details?: string; shortMessage?: string; cause?: unknown } | undefined, i = 0; e && i < 6; e = e.cause as typeof e, i++) {
    parts.push(e.shortMessage ?? "", e.message ?? "", e.details ?? "");
  }
  return parts.join(" ");
}

export const isNonceError = (err: unknown) => NONCE_ERRORS.test(text(err));
export const isUnreachable = (err: unknown) => !isNonceError(err) && UNREACHABLE.test(text(err));

export class RevertedError extends Error {}
export class ReceiptTimeoutError extends Error {}

export interface SenderOptions {
  log(line: string): void;
  sleep?(ms: number): Promise<void>;
  retries?: number;
  retryDelayMs?: number;
}

export class NonceSender {
  private io: ChainIO;
  private switched = false;
  private nonce: number | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly primary: ChainIO,
    private readonly fallback: ChainIO | null,
    private readonly o: SenderOptions,
  ) {
    this.io = primary;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retries = o.retries ?? MAX_RETRIES;
    this.retryDelayMs = o.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /** The RPC in use for this run. */
  get rpc(): string {
    return this.io.name;
  }

  /** A new run: back to the primary, and the pending nonce fetched once, now. */
  async startRun(): Promise<void> {
    this.io = this.primary;
    this.switched = false;
    this.nonce = null;
    this.nonce = await this.withFallback(() => this.io.pendingNonce());
  }

  /** Writes one round and waits for its receipt. Retries nonce errors; never retries a revert. */
  async write(feed: Address, round: Round): Promise<Hex> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.nonce === null) this.nonce = await this.withFallback(() => this.io.pendingNonce());
        // Read inside the call: a move to the fallback RPC re-reads the nonce there.
        let used = -1;
        const hash = await this.withFallback(() => this.io.send(feed, round, (used = this.nonce!)));
        this.nonce = used + 1; // accepted by the node: this nonce is used
        let status: "success" | "reverted";
        try {
          status = await this.io.receipt(hash);
        } catch (err) {
          // Unknown whether it was mined: ask the chain for the nonce again before the next write.
          this.nonce = null;
          throw new ReceiptTimeoutError(`no receipt for ${hash}: ${text(err).trim().split("\n")[0]}`);
        }
        if (status !== "success") throw new RevertedError(`setRoundData reverted in ${hash}`);
        return hash;
      } catch (err) {
        if (!isNonceError(err) || attempt >= this.retries) throw err;
        this.o.log(`nonce error on ${this.io.name} (${firstLine(err)}), re-reading the pending nonce, retry ${attempt + 1}/${this.retries}`);
        await this.sleep(this.retryDelayMs);
        this.nonce = await this.withFallback(() => this.io.pendingNonce());
      }
    }
  }

  /** Runs `f` on the RPC in use; if the primary can't be reached, moves to the fallback for the rest of the run. */
  private async withFallback<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (err) {
      if (this.switched || !this.fallback || !isUnreachable(err)) throw err;
      this.o.log(`primary RPC unreachable (${firstLine(err)}), using ${this.fallback.name} for the rest of this run`);
      this.switched = true;
      this.io = this.fallback;
      this.nonce = await this.io.pendingNonce();
      return await f();
    }
  }
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0]!;
}
