/**
 * The limits form: what the owner types, turned into setLimits arguments exactly (bigints in the vault's USDG decimals,
 * percentages in whole basis points), checked against the same rules the vault enforces so a bad value is caught
 * before the wallet opens. The vault's own check stays the authority: its InvalidLimits sentence is shown if it refuses.
 */
import { parseDecimal, toDecimalString } from "@glance/core/format";

import type { VaultView } from "./api";

/** The vault's bounds (GlanceVault.MAX_SLIPPAGE_BPS, BPS). */
export const MAX_SLIPPAGE_BPS = 1_000;
export const MAX_WEEKEND_BPS = 10_000;

export interface LimitsForm {
  perTrade: string;
  dailyBuy: string;
  dailySell: string;
  /** Percent, e.g. "1" or "0.5". */
  slippage: string;
  weekend: string;
}

export type LimitsArgs = readonly [perBuyCap: bigint, dailyCap: bigint, dailySellCap: bigint, maxSlippageBps: number, weekendCapBps: number];

export type LimitsResult = { ok: true; args: LimitsArgs } | { ok: false; errors: Partial<Record<keyof LimitsForm, string>> };

export function formFromVault(v: Pick<VaultView, "limits" | "usdg">): LimitsForm {
  const d = v.usdg.decimals;
  return {
    perTrade: toDecimalString(BigInt(v.limits.perTrade.raw), d),
    dailyBuy: toDecimalString(BigInt(v.limits.dailyBuy.raw), d),
    dailySell: toDecimalString(BigInt(v.limits.dailySell.raw), d),
    slippage: toDecimalString(BigInt(v.limits.maxSlippageBps), 2),
    weekend: toDecimalString(BigInt(v.limits.weekendCapBps), 2),
  };
}

/** "1.25" percent -> 125 bps. Two decimal places at most (a basis point is 0.01%). */
export function percentToBps(value: string): number {
  return Number(parseDecimal(value.replace(/%\s*$/, ""), 2));
}

function dollars(value: string, decimals: number): bigint {
  return parseDecimal(value.replace(/^\$/, "").replace(/,/g, ""), decimals);
}

export function parseLimits(form: LimitsForm, usdgDecimals: number): LimitsResult {
  const errors: Partial<Record<keyof LimitsForm, string>> = {};
  const money = (key: "perTrade" | "dailyBuy" | "dailySell") => {
    try {
      return dollars(form[key], usdgDecimals);
    } catch {
      errors[key] = `Enter an amount in dollars, up to ${usdgDecimals} decimal places.`;
      return null;
    }
  };
  const pct = (key: "slippage" | "weekend", max: number, name: string) => {
    try {
      const bps = percentToBps(form[key]);
      if (bps > max) {
        errors[key] = `${name} can be at most ${toDecimalString(BigInt(max), 2)}%.`;
        return null;
      }
      return bps;
    } catch {
      errors[key] = "Enter a percentage, up to two decimal places.";
      return null;
    }
  };
  const perTrade = money("perTrade");
  const dailyBuy = money("dailyBuy");
  const dailySell = money("dailySell");
  const slippage = pct("slippage", MAX_SLIPPAGE_BPS, "Slippage");
  const weekend = pct("weekend", MAX_WEEKEND_BPS, "The market-closed share");

  if (perTrade !== null && perTrade === 0n) errors.perTrade = "The per-trade limit has to be above zero.";
  if (perTrade !== null && dailyBuy !== null && perTrade > dailyBuy) errors.dailyBuy = "The daily buy limit can't be smaller than the per-trade limit.";
  if (perTrade !== null && dailySell !== null && perTrade > dailySell) errors.dailySell = "The daily sell limit can't be smaller than the per-trade limit.";

  if (Object.keys(errors).length || perTrade === null || dailyBuy === null || dailySell === null || slippage === null || weekend === null) {
    return { ok: false, errors };
  }
  return { ok: true, args: [perTrade, dailyBuy, dailySell, slippage, weekend] };
}

export function sameLimits(a: LimitsArgs, v: Pick<VaultView, "limits">): boolean {
  return (
    a[0] === BigInt(v.limits.perTrade.raw) &&
    a[1] === BigInt(v.limits.dailyBuy.raw) &&
    a[2] === BigInt(v.limits.dailySell.raw) &&
    a[3] === v.limits.maxSlippageBps &&
    a[4] === v.limits.weekendCapBps
  );
}
