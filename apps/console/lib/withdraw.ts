/**
 * Withdraw validation: what the owner types, as raw USDG in the vault's own decimals (6), checked before the wallet
 * opens. The vault checks again (ZeroAmount, and the token transfer fails past the balance).
 */
import { parseDecimal } from "@glance/core/format";

export type WithdrawResult = { ok: true; amount: bigint } | { ok: false; error: string | null };

export function parseWithdraw(input: string, balance: bigint, decimals: number): WithdrawResult {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (text === "") return { ok: false, error: null }; // nothing typed yet: no error, just nothing to send
  let amount: bigint;
  try {
    amount = parseDecimal(text, decimals);
  } catch {
    return { ok: false, error: `Enter an amount in USDG, up to ${decimals} decimal places.` };
  }
  if (amount === 0n) return { ok: false, error: "Enter an amount above zero." };
  if (amount > balance) return { ok: false, error: "That's more than the vault holds." };
  return { ok: true, amount };
}
