/**
 * The starter fund: a new wallet's gas and first USDG, so Get started never sends anyone to a faucet site.
 *
 *   GET  /faucet        what's on and stocked: the console runs each step by itself, or links the faucet sites
 *   POST /faucet/gas    { address } -> { txHash, amountEth }   0.0005 test ETH
 *   POST /faucet/usdg   { address } -> { txHash, amountUsdg }  20 Paxos USDG
 *
 * Sent from a dedicated faucet wallet (FAUCET_PRIVATE_KEY; unset: off). The rules, each kept separately for gas and USDG:
 *   - the address needs it (under 0.0002 ETH; under 5 USDG);
 *   - once per address, ever (kept in .cache/faucet.json, so a restart doesn't reset it);
 *   - 5 an hour per IP;
 *   - a daily total (FAUCET_DAILY_ETH, default 0.01 ETH; FAUCET_DAILY_USDG, default 200 USDG).
 * When the faucet wallet itself runs low, the answer is FAUCET_EMPTY, in plain words ("Our starter fund is empty right
 * now. Claim from the Paxos faucet instead."), and the console shows the faucet links instead.
 *
 * Sends go one at a time with nonces assigned locally from the pending nonce (re-read and retried on a nonce error),
 * like the feed keeper. Addresses and IPs appear in the log only as short hashes. Glance never holds a user's key.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { formatEther, formatUnits, getAddress, parseEther, type Address, type Hex } from "viem";

import { ApiError } from "./services.js";

export const FAUCET_AMOUNT = parseEther("0.0005");
/** Below this the address gets gas; at or above it, it already has enough for a few transactions. */
export const FAUCET_THRESHOLD = parseEther("0.0002");
/** What the faucet wallet keeps back for its own gas. */
const FAUCET_GAS_RESERVE = parseEther("0.0002");
export const FAUCET_PER_IP_PER_HOUR = 5;
/** Paxos USDG on Robinhood Chain testnet. */
export const PAXOS_USDG: Address = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
export const STARTER_USDG = "20";
/** Below this (whole USDG) the address gets starter USDG. */
export const STARTER_USDG_BELOW = "5";

export const EMPTY_GAS = "Our starter fund is empty right now. Get test ETH from the Robinhood testnet faucet instead.";
export const EMPTY_USDG = "Our starter fund is empty right now. Claim from the Paxos faucet instead.";

export type FaucetKind = "gas" | "usdg";

export interface FaucetStore {
  /** Whether this address was ever sent this kind. */
  sent(kind: FaucetKind, address: Address): boolean;
  record(kind: FaucetKind, address: Address, day: string, amount: bigint): void;
  /** Total of this kind sent on this UTC day (wei for gas, USDG's smallest unit for USDG). */
  sentOn(kind: FaucetKind, day: string): bigint;
}

interface StoreData {
  /** Gas: kept under the names they had before USDG existed. */
  addresses: string[];
  days: Record<string, string>;
  usdgAddresses: string[];
  usdgDays: Record<string, string>;
}

/** Addresses sent to (for good) and each day's totals, as JSON (memory only when `file` is null). */
export class JsonFaucetStore implements FaucetStore {
  private data: { gas: { addresses: Set<string>; days: Record<string, string> }; usdg: { addresses: Set<string>; days: Record<string, string> } } = {
    gas: { addresses: new Set(), days: {} },
    usdg: { addresses: new Set(), days: {} },
  };

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        const d = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreData>;
        this.data.gas = { addresses: new Set(d.addresses ?? []), days: d.days ?? {} };
        this.data.usdg = { addresses: new Set(d.usdgAddresses ?? []), days: d.usdgDays ?? {} };
      } catch {
        // unreadable: start empty (the daily caps and per-IP limits still hold)
      }
    }
  }

  sent(kind: FaucetKind, address: Address) {
    return this.data[kind].addresses.has(address.toLowerCase());
  }

  record(kind: FaucetKind, address: Address, day: string, amount: bigint) {
    this.data[kind].addresses.add(address.toLowerCase());
    this.data[kind].days[day] = (this.sentOn(kind, day) + amount).toString();
    if (!this.file) return;
    const out: StoreData = { addresses: [...this.data.gas.addresses], days: this.data.gas.days, usdgAddresses: [...this.data.usdg.addresses], usdgDays: this.data.usdg.days };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(out));
    renameSync(`${this.file}.tmp`, this.file);
  }

  sentOn(kind: FaucetKind, day: string) {
    return BigInt(this.data[kind].days[day] ?? "0");
  }
}

/** The faucet wallet's side of the chain: balances (anyone's, and its own), its pending nonce, and the two transfers. */
export interface FaucetChain {
  address: Address;
  balanceOf(address: Address): Promise<bigint>;
  usdgBalanceOf(address: Address): Promise<bigint>;
  usdgDecimals(): Promise<number>;
  pendingNonce(): Promise<number>;
  transfer(to: Address, value: bigint, nonce: number): Promise<Hex>;
  transferUsdg(to: Address, amount: bigint, nonce: number): Promise<Hex>;
}

const NONCE_ERRORS = /nonce too low|lower than the current nonce|already known|replacement transaction underpriced/i;
const shortHash = (v: string) => createHash("sha256").update(v.toLowerCase()).digest("hex").slice(0, 8);
const units = (whole: string, decimals: number) => BigInt(whole) * 10n ** BigInt(decimals);

export function createFaucet(d: {
  chain: FaucetChain;
  store: FaucetStore;
  dailyCap: bigint;
  /** Whole USDG per UTC day (default 200). */
  dailyUsdg?: string;
  now?: () => number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((l: string) => console.log(l));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const perIp: Record<FaucetKind, Map<string, { count: number; resetAt: number }>> = { gas: new Map(), usdg: new Map() };
  const inFlight = new Set<string>();
  let nonce: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let decimals: number | null = null;
  const usdgDecimals = async () => (decimals ??= await d.chain.usdgDecimals());

  /** One transfer at a time, nonces assigned here; a nonce error re-reads the pending nonce and retries (twice). */
  function send(transfer: (n: number) => Promise<Hex>): Promise<Hex> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (nonce === null) nonce = await d.chain.pendingNonce();
          const hash = await transfer(nonce);
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

  const day = () => new Date(now()).toISOString().slice(0, 10);

  /** The rules both kinds share, in order: once per address, then the per-IP hour. */
  function admit(kind: FaucetKind, address: Address, ip: string) {
    const key = `${kind}:${address.toLowerCase()}`;
    if (d.store.sent(kind, address) || inFlight.has(key)) {
      throw new ApiError(409, "FAUCET_ALREADY_SENT", kind === "gas" ? "This wallet already got gas from Glance." : "This wallet already got its starter USDG from Glance.");
    }
    const t = now();
    let entry = perIp[kind].get(ip);
    if (!entry || entry.resetAt <= t) perIp[kind].set(ip, (entry = { count: 0, resetAt: t + 3_600_000 }));
    if (entry.count >= FAUCET_PER_IP_PER_HOUR) throw new ApiError(429, "FAUCET_BUSY", "Too many requests from here this hour. Try the faucet sites instead.");
    return { key, entry };
  }

  async function sendAndRecord(kind: FaucetKind, address: Address, ip: string, amount: bigint, key: string, entry: { count: number }, transfer: (n: number) => Promise<Hex>, label: string): Promise<Hex> {
    entry.count++;
    inFlight.add(key);
    try {
      const txHash = await send(transfer);
      d.store.record(kind, address, day(), amount);
      log(`[faucet] sent ${label} to wallet ${shortHash(address)} from visitor ${shortHash(ip)}`);
      return txHash;
    } catch (err) {
      log(`[faucet] ${kind} to wallet ${shortHash(address)} failed: ${String((err as Error)?.message).split("\n")[0]}`);
      throw new ApiError(502, "FAUCET_FAILED", "That didn't go out. Try again in a moment.");
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    amount: FAUCET_AMOUNT,
    address: d.chain.address,

    async gas(input: { address: string; ip: string }): Promise<{ txHash: Hex; amountEth: string }> {
      const address = getAddress(input.address);
      const { key, entry } = admit("gas", address, input.ip);
      if ((await d.chain.balanceOf(address)) >= FAUCET_THRESHOLD) throw new ApiError(409, "FAUCET_HAS_GAS", "This wallet already has enough gas to get started.");
      if (d.store.sentOn("gas", day()) + FAUCET_AMOUNT > d.dailyCap) throw new ApiError(429, "FAUCET_EMPTY_TODAY", "Glance's gas faucet is used up for today. Try the Robinhood testnet faucet.");
      if ((await d.chain.balanceOf(d.chain.address)) < FAUCET_AMOUNT + FAUCET_GAS_RESERVE) throw new ApiError(503, "FAUCET_EMPTY", EMPTY_GAS);
      const txHash = await sendAndRecord("gas", address, input.ip, FAUCET_AMOUNT, key, entry, (n) => d.chain.transfer(address, FAUCET_AMOUNT, n), `${formatEther(FAUCET_AMOUNT)} ETH`);
      return { txHash, amountEth: formatEther(FAUCET_AMOUNT) };
    },

    async usdg(input: { address: string; ip: string }): Promise<{ txHash: Hex; amountUsdg: string }> {
      const address = getAddress(input.address);
      const dec = await usdgDecimals();
      const amount = units(STARTER_USDG, dec);
      const { key, entry } = admit("usdg", address, input.ip);
      if ((await d.chain.usdgBalanceOf(address)) >= units(STARTER_USDG_BELOW, dec)) throw new ApiError(409, "FAUCET_HAS_USDG", "This wallet already has enough USDG to get started.");
      if (d.store.sentOn("usdg", day()) + amount > units(d.dailyUsdg ?? "200", dec)) {
        throw new ApiError(429, "FAUCET_EMPTY_TODAY", "Glance's starter USDG is used up for today. Claim from the Paxos faucet instead.");
      }
      const [own, gas] = await Promise.all([d.chain.usdgBalanceOf(d.chain.address), d.chain.balanceOf(d.chain.address)]);
      if (own < amount || gas < FAUCET_GAS_RESERVE) throw new ApiError(503, "FAUCET_EMPTY", EMPTY_USDG);
      const txHash = await sendAndRecord("usdg", address, input.ip, amount, key, entry, (n) => d.chain.transferUsdg(address, amount, n), `${STARTER_USDG} USDG`);
      return { txHash, amountUsdg: STARTER_USDG };
    },

    /** What the console needs to decide: on, and stocked (enough for one more send of each). */
    async stock(): Promise<{ gas: boolean; usdg: boolean }> {
      const dec = await usdgDecimals().catch(() => 6);
      const [eth, usdg] = await Promise.all([d.chain.balanceOf(d.chain.address), d.chain.usdgBalanceOf(d.chain.address)]);
      return { gas: eth >= FAUCET_AMOUNT + FAUCET_GAS_RESERVE, usdg: usdg >= units(STARTER_USDG, dec) && eth >= FAUCET_GAS_RESERVE };
    },

    /** For /health's admin view and `make faucet-status`: its balances and today's totals. */
    async status() {
      const dec = await usdgDecimals().catch(() => 6);
      const [eth, usdg] = await Promise.all([d.chain.balanceOf(d.chain.address), d.chain.usdgBalanceOf(d.chain.address)]);
      const today = day();
      return {
        address: d.chain.address,
        balances: { eth: formatEther(eth), usdg: formatUnits(usdg, dec) },
        today: { day: today, eth: formatEther(d.store.sentOn("gas", today)), usdg: formatUnits(d.store.sentOn("usdg", today), dec) },
        caps: { eth: formatEther(d.dailyCap), usdg: d.dailyUsdg ?? "200" },
      };
    },
  };
}

export type Faucet = ReturnType<typeof createFaucet>;
