/**
 * Baskets: several stocks bought as one. No contract knows about them: a basket buy is one ordinary vault buy per leg.
 *
 *   POST /quote/basket         { vault, legs: [{ symbol, amount }] }  every leg preflighted before anything is sent
 *   POST /trade/basket         the same, signed (GlanceBasketRequest) -> { jobId }; the legs are sent one by one
 *   GET  /trade/basket/:jobId  each leg's progress, then the receipt
 *
 * Preflight: each leg goes through the same quote and on-chain simulation as a single buy (token allowed, per-trade
 * cap, price freshness and the weekend guard, slippage), and then the legs are checked together, in order, against
 * what's left of the rolling 24h buy cap and the vault's USDG. A leg that fails says why; nothing is sent for it.
 *
 * Execution: strictly one leg after another from the agent key, with nonces assigned here (the pending nonce read once,
 * +1 per transaction), each leg's receipt awaited before the next. A nonce error re-reads the pending nonce and retries
 * that leg once; a revert is never retried. If a leg reverts, the basket stops there, and the report says which legs
 * went through (with their transactions) and which didn't. The vault's own caps remain the final authority.
 */
import { randomBytes } from "node:crypto";

import { decodeEventLog, isAddressEqual, type Address, type Hex } from "viem";

import { glanceVaultAbi } from "./abi.generated.js";
import type { AppContext } from "./context.js";
import { decodeRevert, explainRevert, revertDataFromError } from "./errors.js";
import { formatQuantity, formatUsd, toDecimalString } from "./format.js";
import { ApiError, quoteView, stockBySymbol, vaultView } from "./services.js";

export interface BasketLegRequest {
  symbol: string;
  amount: string;
}

export interface BasketRequest {
  vault: Address;
  legs: BasketLegRequest[];
  slippageBps?: number;
}

export interface LegCheck {
  symbol: string;
  amount: string;
  /** The oracle price used (decimal string), when the quote ran. */
  price: string | null;
  ok: boolean;
  code?: string;
  reason?: string;
}

export interface BasketPreflight {
  legs: LegCheck[];
  total: string;
  passing: number;
  /** What's left of the rolling 24h buy cap now, and after the passing legs. */
  capLeft: string;
  capLeftAfter: string;
}

type Quote = Awaited<ReturnType<typeof quoteView>>;
type QuoteCall = Quote["_call"];
/** The parts of a quote and of the vault that the basket checks read. */
export type LegQuote = { error: ApiError } | (Pick<Quote, "symbol" | "amountIn" | "preflight"> & { price: { value: string }; _call: QuoteCall });
export interface BasketVaultFacts {
  usdg: { decimals: number };
  buyWindow: { remaining: { raw: string } };
  balances: { usdg: { raw: string } };
}

/** Each leg's own preflight, then the legs together (in order) against the cap left and the vault's USDG. */
export async function basketPreflight(ctx: AppContext, req: BasketRequest): Promise<BasketPreflight & { calls: Array<QuoteCall | null> }> {
  const [quotes, vault] = await Promise.all([
    Promise.all(
      req.legs.map((l) =>
        quoteView(ctx, { vault: req.vault, symbol: l.symbol, side: "buy", amount: l.amount, slippageBps: req.slippageBps }, ctx.signer?.account.address).catch((err: unknown) => {
          if (err instanceof ApiError) return { error: err };
          throw err;
        }),
      ),
    ),
    vaultView(ctx, req.vault),
  ]);
  return combineLegs(req, quotes, vault);
}

/** The legs together: each one's own verdict, then in order against the cap left and the USDG in the vault. */
export function combineLegs(req: BasketRequest, quotes: readonly LegQuote[], vault: BasketVaultFacts): BasketPreflight & { calls: Array<QuoteCall | null> } {
  const d = vault.usdg.decimals;
  const remaining = BigInt(vault.buyWindow.remaining.raw);
  const usdg = BigInt(vault.balances.usdg.raw);
  let used = 0n;
  let total = 0n;
  const legs: LegCheck[] = [];
  const calls: Array<QuoteCall | null> = [];
  for (const [i, q] of quotes.entries()) {
    const leg = req.legs[i]!;
    if ("error" in q) {
      legs.push({ symbol: leg.symbol, amount: leg.amount, price: null, ok: false, code: q.error.code, reason: q.error.message });
      calls.push(null);
      continue;
    }
    const amount = BigInt(q.amountIn.raw);
    total += amount;
    const base = { symbol: q.symbol, amount: leg.amount, price: q.price.value };
    if (!q.preflight.ok) {
      legs.push({ ...base, ok: false, code: q.preflight.guard.code, reason: q.preflight.guard.message });
      calls.push(null);
    } else if (used + amount > remaining) {
      legs.push({ ...base, ok: false, code: "BASKET_DAILY_CAP", reason: `With the legs before it, this would go past what's left of today's buy limit (${formatUsd(remaining, d)}).` });
      calls.push(null);
    } else if (used + amount > usdg) {
      legs.push({ ...base, ok: false, code: "BASKET_NO_USDG", reason: `With the legs before it, the vault doesn't have enough USDG (${formatUsd(usdg, d)}).` });
      calls.push(null);
    } else {
      used += amount;
      legs.push({ ...base, ok: true });
      calls.push(q._call);
    }
  }
  return {
    legs,
    total: toDecimalString(total, d),
    passing: legs.filter((l) => l.ok).length,
    capLeft: formatUsd(remaining, d),
    capLeftAfter: formatUsd(remaining - used, d),
    calls,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Execution: one leg at a time, local nonces
// ---------------------------------------------------------------------------------------------------------------

export type LegStatus = "waiting" | "sending" | "done" | "reverted" | "not-sent";

export interface LegResult {
  symbol: string;
  amount: string;
  status: LegStatus;
  txHash?: Hex;
  explorerUrl?: string;
  /** What the leg bought ("0.0263 TSLA"). */
  got?: string;
  reason?: string;
}

export interface LegExecutor {
  pendingNonce(): Promise<number>;
  /** Simulates the leg against the chain as it is now (after the legs before it); throws the vault's refusal. */
  prepare(index: number): Promise<unknown>;
  send(prepared: unknown, nonce: number): Promise<Hex>;
  /** Waits for the receipt: "success" with what it bought, or "reverted". */
  receipt(index: number, hash: Hex): Promise<{ status: "success"; got: string | null } | { status: "reverted"; reason: string }>;
  /** A refusal (or a send error) in plain words. */
  explain(index: number, err: unknown): string;
  explorerUrl(hash: Hex): string;
}

const NONCE_ERRORS = /nonce too low|lower than the current nonce|already known|replacement transaction underpriced|nonce has already been used/i;

/**
 * Sends each leg in order, waiting for its receipt. Stops at the first leg that can't be sent or reverts: the legs
 * after it are "not-sent", and nothing is ever retried after a revert.
 */
export async function executeLegs(legs: readonly BasketLegRequest[], x: LegExecutor, onProgress: (results: LegResult[]) => void): Promise<{ results: LegResult[]; complete: boolean }> {
  const results: LegResult[] = legs.map((l) => ({ symbol: l.symbol, amount: l.amount, status: "waiting" }));
  const update = (i: number, r: Partial<LegResult>) => {
    results[i] = { ...results[i]!, ...r };
    onProgress(results.map((leg) => ({ ...leg })));
  };
  const stopAfter = (i: number) => {
    for (let j = i + 1; j < results.length; j++) results[j] = { ...results[j]!, status: "not-sent", reason: "Not sent: the basket stopped at an earlier leg." };
    onProgress(results.map((leg) => ({ ...leg })));
    return { results, complete: false };
  };

  let nonce = await x.pendingNonce();
  for (let i = 0; i < legs.length; i++) {
    update(i, { status: "sending" });
    let prepared: unknown;
    try {
      prepared = await x.prepare(i);
    } catch (err) {
      update(i, { status: "not-sent", reason: x.explain(i, err) });
      return stopAfter(i);
    }
    let hash: Hex | null = null;
    for (let attempt = 0; attempt < 2 && hash === null; attempt++) {
      try {
        hash = await x.send(prepared, nonce);
      } catch (err) {
        if (attempt === 0 && NONCE_ERRORS.test(String((err as Error)?.message))) {
          nonce = await x.pendingNonce(); // another transaction took this nonce: read it again, once
          continue;
        }
        update(i, { status: "not-sent", reason: x.explain(i, err) });
        return stopAfter(i);
      }
    }
    if (hash === null) {
      update(i, { status: "not-sent", reason: "The chain kept refusing the transaction's number. Nothing was sent for this leg." });
      return stopAfter(i);
    }
    nonce++;
    const r = await x.receipt(i, hash);
    if (r.status === "reverted") {
      update(i, { status: "reverted", txHash: hash, explorerUrl: x.explorerUrl(hash), reason: r.reason });
      return stopAfter(i);
    }
    update(i, { status: "done", txHash: hash, explorerUrl: x.explorerUrl(hash), got: r.got ?? undefined });
  }
  return { results, complete: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs: POST /trade/basket starts one; GET /trade/basket/:jobId reads it (the id is a random 128-bit token)
// ---------------------------------------------------------------------------------------------------------------

export interface BasketJob {
  id: string;
  vault: Address;
  state: "running" | "done" | "stopped" | "failed";
  legs: LegResult[];
  message?: string;
  startedAt: number;
}

const JOB_TTL_MS = 60 * 60_000;

export class BasketJobs {
  private jobs = new Map<string, BasketJob>();

  create(vault: Address, legs: readonly BasketLegRequest[]): BasketJob {
    const now = Date.now();
    for (const [k, j] of this.jobs) if (now - j.startedAt > JOB_TTL_MS) this.jobs.delete(k);
    const job: BasketJob = { id: randomBytes(16).toString("hex"), vault, state: "running", legs: legs.map((l) => ({ symbol: l.symbol, amount: l.amount, status: "waiting" })), startedAt: now };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): BasketJob | null {
    return this.jobs.get(id) ?? null;
  }
}

/** The real chain behind executeLegs: the agent key, one RPC client, the vault's own refusals explained. */
export function agentExecutor(ctx: AppContext, req: BasketRequest, calls: ReadonlyArray<QuoteCall>): LegExecutor {
  const signer = ctx.signer!;
  return {
    pendingNonce: () => ctx.client.getTransactionCount({ address: signer.account.address, blockTag: "pending" }),
    prepare: async (i) => {
      const { request } = await ctx.client.simulateContract({ address: req.vault, abi: glanceVaultAbi, functionName: "buy", args: calls[i]!.args, account: signer.account });
      return request;
    },
    send: (prepared, nonce) => signer.wallet.writeContract({ ...(prepared as Parameters<typeof signer.wallet.writeContract>[0]), nonce }),
    receipt: async (i, hash) => {
      const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") {
        let reason = explainRevert(null, calls[i]!.exCtx).message;
        try {
          await ctx.client.simulateContract({ address: req.vault, abi: glanceVaultAbi, functionName: "buy", args: calls[i]!.args, account: signer.account.address, blockNumber: receipt.blockNumber - 1n });
        } catch (err) {
          reason = explainRevert(decodeRevert(revertDataFromError(err)), calls[i]!.exCtx).message;
        }
        return { status: "reverted", reason };
      }
      const stock = stockBySymbol(ctx, req.legs[i]!.symbol);
      for (const log of receipt.logs) {
        if (!isAddressEqual(log.address, req.vault)) continue;
        try {
          const ev = decodeEventLog({ abi: glanceVaultAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "Bought") return { status: "success", got: formatQuantity(ev.args.tokensOut, stock.tokenDecimals, stock.symbol) };
        } catch {
          // not a vault event
        }
      }
      return { status: "success", got: null };
    },
    explain: (i, err) => explainRevert(decodeRevert(revertDataFromError(err)), calls[i]!.exCtx).message,
    explorerUrl: (hash) => `${ctx.config.EXPLORER_URL}/tx/${hash}`,
  };
}
