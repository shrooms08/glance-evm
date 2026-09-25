/**
 * "Add SPY and QQQ to your vault" (the Limits page): for each ETF the vault doesn't allow yet, setTokenApproval with its
 * feed, then setTokenFreshness (20h open, 96h closed), exactly as a new vault gets them. Only what's missing is sent,
 * so the number of wallet prompts is known before the first one opens.
 */
import { isAddressEqual } from "viem";

import { VAULT_SETUP, type EtfStock } from "./deployment";

export interface EtfTokenState {
  approved: boolean;
  feed: `0x${string}`;
  openMaxAge: number;
  closedMaxAge: number;
}

export interface EtfStep {
  label: string;
  functionName: "setTokenApproval" | "setTokenFreshness";
  args: readonly unknown[];
}

/** The wallet prompts still needed, in order (empty: the vault already allows every ETF). */
export function etfAddPlan(etfs: readonly EtfStock[], states: readonly EtfTokenState[]): EtfStep[] {
  const steps: EtfStep[] = [];
  etfs.forEach((etf, i) => {
    const s = states[i];
    if (!s || !s.approved || !isAddressEqual(s.feed, etf.feed)) {
      steps.push({ label: `Allow ${etf.symbol} with its price feed`, functionName: "setTokenApproval", args: [etf.token, etf.feed, true] });
    }
    if (!s || s.openMaxAge !== VAULT_SETUP.openMaxAge || s.closedMaxAge !== VAULT_SETUP.closedMaxAge) {
      steps.push({ label: `Set ${etf.symbol}'s price checks (20h open, 96h closed)`, functionName: "setTokenFreshness", args: [etf.token, VAULT_SETUP.openMaxAge, VAULT_SETUP.closedMaxAge] });
    }
  });
  return steps;
}

/** "SPY and QQQ", "SPY, QQQ and DIA". */
export function listNames(symbols: readonly string[]): string {
  return symbols.length <= 1 ? (symbols[0] ?? "") : `${symbols.slice(0, -1).join(", ")} and ${symbols.at(-1)}`;
}

export const promptCount = (n: number) => (n === 1 ? "1 wallet prompt" : `${n} wallet prompts`);
