/**
 * One mirror pass over every listed symbol. Chain access is injected so the pass is testable without a network.
 */
import type { Address, Hex } from "viem";

import { planMirror, type Plan, type Round } from "./mirror.ts";
import type { PriceSource } from "./sources.ts";

export interface KeeperSymbol {
  symbol: string;
  testnetFeed: Address;
  source: PriceSource;
}

export interface KeeperDeps {
  symbols: KeeperSymbol[];
  readMainnet(feed: Address): Promise<Round>;
  readPublicQuote(symbol: string): Promise<(Round & { provider: string }) | null>;
  readTestnet(feed: Address): Promise<Round>;
  testnetNow(): Promise<bigint>;
  write(feed: Address, round: Round): Promise<Hex>;
  /** Called once at the start of every pass, before any write (fetches the pending nonce). */
  startRun?(): Promise<void>;
  log(line: string): void;
  /** Feed decimals, for display only. */
  decimals?: number;
}

export interface PassResult {
  symbol: string;
  plan: Plan["action"] | "error";
  txHash?: Hex;
}

const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");

function describe(round: Round, now: bigint, decimals: number): string {
  const whole = round.answer / 10n ** BigInt(decimals);
  const fraction = (round.answer % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  const ageHours = Number(now - round.updatedAt) / 3600;
  return `$${whole}${fraction ? `.${fraction}` : ""} updated ${iso(round.updatedAt)} (${ageHours.toFixed(1)}h ago)`;
}

export async function runOnce(deps: KeeperDeps): Promise<PassResult[]> {
  const decimals = deps.decimals ?? 8;
  const now = await deps.testnetNow();
  const results: PassResult[] = [];
  try {
    await deps.startRun?.();
  } catch (err) {
    // Not fatal: feeds that need no write still get checked, and a write reads the nonce again itself.
    deps.log(`could not read the keeper's pending nonce (${(err as Error).message.split("\n")[0]}); each write will try again`);
  }

  for (const { symbol, testnetFeed, source } of deps.symbols) {
    const label = source.kind === "mainnet-mirror" ? "mainnet-mirror" : `public-quote (${source.provider})`;
    try {
      let reading: Round | null;
      let from: string;
      if (source.kind === "mainnet-mirror") {
        reading = await deps.readMainnet(source.feed);
        from = `mainnet feed ${source.feed}`;
      } else {
        const quote = await deps.readPublicQuote(symbol);
        reading = quote;
        from = quote ? `${quote.provider} quote` : "public quote";
      }
      if (!reading) {
        deps.log(`${symbol.padEnd(5)} ${label}: no quote available, feed left as is`);
        results.push({ symbol, plan: "hold" });
        continue;
      }

      const current = await deps.readTestnet(testnetFeed);
      const plan = planMirror(reading, current, now);
      if (plan.action === "write") {
        const txHash = await deps.write(testnetFeed, plan.round);
        deps.log(`${symbol.padEnd(5)} ${label}: wrote ${describe(plan.round, now, decimals)} from ${from}, tx ${txHash}`);
        results.push({ symbol, plan: "write", txHash });
      } else if (plan.action === "skip") {
        deps.log(`${symbol.padEnd(5)} ${label}: unchanged, skipped (${describe(current, now, decimals)})`);
        results.push({ symbol, plan: "skip" });
      } else {
        deps.log(`${symbol.padEnd(5)} ${label}: held, ${plan.reason}`);
        results.push({ symbol, plan: "hold" });
      }
    } catch (err) {
      // One symbol failing must not stop the others. The message is the error's first line only: no call data dumps.
      deps.log(`${symbol.padEnd(5)} ${label}: ERROR ${(err as Error).message.split("\n")[0]}`);
      results.push({ symbol, plan: "error" });
    }
  }
  deps.log(summaryLine(results));
  return results;
}

/** One line for the end of a pass: which symbols were written, left unchanged (or held) and failed. */
export function summaryLine(results: readonly PassResult[]): string {
  const group = (label: string, plans: ReadonlyArray<PassResult["plan"]>) => {
    const symbols = results.filter((r) => plans.includes(r.plan)).map((r) => r.symbol);
    return `${symbols.length} ${label}${symbols.length ? ` (${symbols.join(", ")})` : ""}`;
  };
  return `summary: ${group("written", ["write"])}, ${group("unchanged", ["skip", "hold"])}, ${group("failed", ["error"])}`;
}

/** Non-zero only when a feed still failed after its retries. */
export function exitCodeFor(results: readonly PassResult[]): 0 | 1 {
  return results.some((r) => r.plan === "error") ? 1 : 0;
}
