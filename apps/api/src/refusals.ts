/**
 * Refusals: the trades a vault's guards stopped. They are what proves the guards are real, so the console shows them
 * next to the trades that went through, in the same sentences the extension says.
 *
 * Two sources, both honest about what they are:
 *   preflight  The API simulates every trade exactly as the agent would send it (eth_call against the live chain,
 *              as the agent's address) before signing anything. When a guard would stop it, nothing is sent and the
 *              refusal is recorded here with the block it was checked at. A vault emits no event for a trade it
 *              refuses, so this record is the only place those appear. Kept in a JSON-lines file (REFUSAL_LOG_FILE)
 *              so it survives restarts.
 *   on chain   Transactions that were sent to the vault and reverted (by anyone: a stale agent, a stranger calling
 *              buy()), read from the explorer and decoded with the vault's own errors. These are refusals the chain
 *              itself made.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

import { decodeRevert, explainRevert, type ExplainContext, type GuardError } from "./errors.js";

export interface RefusalRecord {
  vault: Address;
  /** What was attempted, e.g. "Buy $150 of TSLA". */
  attempt: string;
  symbol: string;
  side: "buy" | "sell";
  /** The amount as asked for: USDG for a buy, shares for a sell. */
  amount: string;
  code: string;
  error: string;
  message: string;
  /** Unix seconds (chain time when known). */
  at: number;
  /** The block the preflight simulated against. */
  blockNumber?: string;
  /** "quote": refused when the card was shown; "trade": refused when confirm was tapped. Never sent either way. */
  via: "quote" | "trade";
}

/** The same attempt refused for the same reason within this window is one refusal, not many (quotes repeat). */
const DEDUPE_SECONDS = 600;

export class RefusalLog {
  private records: RefusalRecord[] = [];

  constructor(
    private readonly file: string | null,
    private readonly max = 2_000,
  ) {
    if (!file || !existsSync(file)) return;
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.records.push(JSON.parse(line) as RefusalRecord);
        } catch {
          // a torn last line: skip it
        }
      }
      this.records = this.records.slice(-this.max);
    } catch {
      this.records = [];
    }
  }

  get persisted(): boolean {
    return this.file !== null;
  }

  record(r: RefusalRecord): boolean {
    const dup = this.records.findLast(
      (x) =>
        isAddressEqual(x.vault, r.vault) &&
        x.symbol === r.symbol &&
        x.side === r.side &&
        x.amount === r.amount &&
        x.code === r.code &&
        r.at - x.at < DEDUPE_SECONDS,
    );
    if (dup) {
      // The confirm tap is the stronger fact: keep it.
      if (r.via === "trade") dup.via = "trade";
      return false;
    }
    this.records.push(r);
    if (this.records.length > this.max) this.records.splice(0, this.records.length - this.max);
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(r)}\n`);
      } catch {
        // Recording is best effort: a read-only disk must never break a quote.
      }
    }
    return true;
  }

  forVault(vault: Address): RefusalRecord[] {
    return this.records.filter((r) => isAddressEqual(r.vault, vault));
  }
}

export function attemptLabel(side: "buy" | "sell", symbol: string, amountFormatted: string): string {
  return side === "buy" ? `Buy ${amountFormatted} of ${symbol}` : `Sell ${amountFormatted}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// On chain: reverted transactions to the vault, from the explorer (Blockscout)
// ---------------------------------------------------------------------------------------------------------------------

export interface OnChainRefusal {
  txHash: Hex;
  from: Address;
  method: string;
  blockNumber: string;
  timestamp: number;
  guard: GuardError;
  /** The call's decoded parameters, when the explorer decoded them. */
  params: Record<string, string>;
}

interface BlockscoutTx {
  hash: Hex;
  result?: string;
  status?: string;
  method?: string | null;
  block_number?: number;
  block?: number;
  timestamp?: string;
  from?: { hash: string };
  revert_reason?: { raw?: Hex } | string | null;
  decoded_input?: { method_call?: string; parameters?: Array<{ name: string; value: unknown }> } | null;
}

/**
 * Reverted transactions sent to `vault`, newest first. Throws when the explorer can't be read (the caller reports that
 * the on-chain half is unavailable rather than claiming there were none).
 */
export async function onChainRefusals(
  explorerUrl: string,
  vault: Address,
  explain: Omit<ExplainContext, "side">,
  fetchFn: typeof fetch = fetch,
  pages = 3,
): Promise<OnChainRefusal[]> {
  const out: OnChainRefusal[] = [];
  let next: Record<string, string> | null = null;
  for (let page = 0; page < pages; page++) {
    const qs = new URLSearchParams({ filter: "to", ...(next ?? {}) });
    const res = await fetchFn(`${explorerUrl}/api/v2/addresses/${vault}/transactions?${qs}`, {
      signal: AbortSignal.timeout(6_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`explorer answered ${res.status}`);
    const body = (await res.json()) as { items?: BlockscoutTx[]; next_page_params?: Record<string, unknown> | null };
    for (const tx of body.items ?? []) {
      const failed = tx.status === "error" || (tx.result !== undefined && tx.result !== "success" && tx.result !== "pending");
      if (!failed) continue;
      const raw = typeof tx.revert_reason === "object" && tx.revert_reason ? tx.revert_reason.raw : undefined;
      const method = tx.method ?? tx.decoded_input?.method_call?.split("(")[0] ?? "unknown";
      const side = method === "sell" ? "sell" : method === "buy" ? "buy" : undefined;
      const params = Object.fromEntries((tx.decoded_input?.parameters ?? []).map((p) => [p.name, String(p.value)]));
      out.push({
        txHash: tx.hash,
        from: getAddress(tx.from?.hash ?? "0x0000000000000000000000000000000000000000"),
        method,
        blockNumber: String(tx.block_number ?? tx.block ?? ""),
        timestamp: tx.timestamp ? Math.floor(Date.parse(tx.timestamp) / 1000) : 0,
        guard: explainRevert(decodeRevert(raw ?? null), { ...explain, side }),
        params,
      });
    }
    const np = body.next_page_params;
    if (!np) break;
    next = Object.fromEntries(Object.entries(np).map(([k, v]) => [k, String(v)]));
  }
  return out;
}
