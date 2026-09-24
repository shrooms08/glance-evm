/**
 * "Get gas": a little test ETH for a new wallet, so nobody has to find a faucet before their first transaction.
 *
 *   GET  /faucet       { enabled, amountEth }: the console hides "Get gas" (and links the public faucet) when off
 *   POST /faucet/gas   { address } -> { txHash, amountEth }
 *
 * Sent from a dedicated faucet wallet (FAUCET_PRIVATE_KEY; unset: off). The rules, in order:
 *   - the address holds under 0.0002 ETH (it needs gas, not more of it);
 *   - once per address, ever (kept in .cache/faucet.json, so a restart doesn't reset it);
 *   - 5 an hour per IP;
 *   - a daily total (FAUCET_DAILY_ETH, default 0.01 ETH: twenty sends).
 * Sends go one at a time with nonces assigned locally from the pending nonce (re-read and retried on a nonce error),
 * like the feed keeper. Addresses and IPs appear in the log only as short hashes. Glance never holds a user's key.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { formatEther, getAddress, parseEther, type Address, type Hex } from "viem";

import { ApiError } from "./services.js";

export const FAUCET_AMOUNT = parseEther("0.0005");
/** Below this the address gets gas; at or above it, it already has enough for a few transactions. */
export const FAUCET_THRESHOLD = parseEther("0.0002");
export const FAUCET_PER_IP_PER_HOUR = 5;

export interface FaucetStore {
  /** Whether this address was ever sent gas. */
  sent(address: Address): boolean;
  record(address: Address, day: string, amount: bigint): void;
  /** Total sent on this UTC day. */
  sentOn(day: string): bigint;
}

/** Addresses sent to (for good) and each day's total, as JSON (memory only when `file` is null). */
export class JsonFaucetStore implements FaucetStore {
  private addresses = new Set<string>();
  private days: Record<string, string> = {};

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { addresses?: string[]; days?: Record<string, string> };
        for (const a of data.addresses ?? []) this.addresses.add(a);
        this.days = data.days ?? {};
      } catch {
        // unreadable: start empty (the daily cap and per-IP limit still hold)
      }
    }
  }

  sent(address: Address) {
    return this.addresses.has(address.toLowerCase());
  }

  record(address: Address, day: string, amount: bigint) {
    this.addresses.add(address.toLowerCase());
    this.days[day] = (this.sentOn(day) + amount).toString();
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ addresses: [...this.addresses], days: this.days }));
    renameSync(`${this.file}.tmp`, this.file);
  }

  sentOn(day: string) {
    return BigInt(this.days[day] ?? "0");
  }
}

/** The faucet wallet's side: its pending nonce, and a transfer with a given nonce. */
export interface FaucetChain {
  balanceOf(address: Address): Promise<bigint>;
  pendingNonce(): Promise<number>;
  transfer(to: Address, value: bigint, nonce: number): Promise<Hex>;
}

const NONCE_ERRORS = /nonce too low|lower than the current nonce|already known|replacement transaction underpriced/i;
const shortHash = (v: string) => createHash("sha256").update(v.toLowerCase()).digest("hex").slice(0, 8);

export function createFaucet(d: { chain: FaucetChain; store: FaucetStore; dailyCap: bigint; now?: () => number; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> }) {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((l: string) => console.log(l));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const perIp = new Map<string, { count: number; resetAt: number }>();
  const inFlight = new Set<string>();
  let nonce: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /** One transfer at a time, nonces assigned here; a nonce error re-reads the pending nonce and retries (twice). */
  function send(to: Address, value: bigint): Promise<Hex> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (nonce === null) nonce = await d.chain.pendingNonce();
          const hash = await d.chain.transfer(to, value, nonce);
          nonce++;
          return hash;
        } catch (err) {
          nonce = null; // re-read before the next send, whatever went wrong
          if (!NONCE_ERRORS.test(String((err as Error)?.message)) || attempt >= 2) throw err;
          await sleep(1_000);
        }
      }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  return {
    amount: FAUCET_AMOUNT,

    async gas(input: { address: string; ip: string }): Promise<{ txHash: Hex; amountEth: string }> {
      const address = getAddress(input.address);
      const key = address.toLowerCase();
      const day = new Date(now()).toISOString().slice(0, 10);
      if (d.store.sent(address) || inFlight.has(key)) {
        throw new ApiError(409, "FAUCET_ALREADY_SENT", "This wallet already got gas from Glance. Use the public faucet for more.");
      }
      const t = now();
      let ip = perIp.get(input.ip);
      if (!ip || ip.resetAt <= t) perIp.set(input.ip, (ip = { count: 0, resetAt: t + 3_600_000 }));
      if (ip.count >= FAUCET_PER_IP_PER_HOUR) throw new ApiError(429, "FAUCET_BUSY", "Too many gas requests from here this hour. Try the public faucet.");
      if ((await d.chain.balanceOf(address)) >= FAUCET_THRESHOLD) throw new ApiError(409, "FAUCET_HAS_GAS", "This wallet already has enough gas to get started.");
      if (d.store.sentOn(day) + FAUCET_AMOUNT > d.dailyCap) throw new ApiError(429, "FAUCET_EMPTY_TODAY", "Glance's gas faucet is used up for today. Try the public faucet.");
      ip.count++;
      inFlight.add(key);
      try {
        const txHash = await send(address, FAUCET_AMOUNT);
        d.store.record(address, day, FAUCET_AMOUNT);
        log(`[faucet] sent ${formatEther(FAUCET_AMOUNT)} ETH to wallet ${shortHash(address)} from visitor ${shortHash(input.ip)} (${formatEther(d.store.sentOn(day))} ETH today)`);
        return { txHash, amountEth: formatEther(FAUCET_AMOUNT) };
      } catch (err) {
        log(`[faucet] send to wallet ${shortHash(address)} failed: ${String((err as Error)?.message).split("\n")[0]}`);
        throw new ApiError(502, "FAUCET_FAILED", "The gas didn't go out. Try again in a moment, or use the public faucet.");
      } finally {
        inFlight.delete(key);
      }
    },
  };
}

export type Faucet = ReturnType<typeof createFaucet>;
