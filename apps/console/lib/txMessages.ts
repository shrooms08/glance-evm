/**
 * What to say when an owner's transaction doesn't go through, kept short and true:
 *   - "You cancelled in your wallet" ONLY for an explicit rejection: EIP-1193 code 4001, or viem's
 *     UserRejectedRequestError anywhere in the cause chain. Nothing else is ever called a cancellation.
 *   - A revert: its reason. The vault's own errors get the API's sentence (explainRevert); a plain require message
 *     is shown as is.
 *   - No gas, or the testnet not responding: said plainly.
 *   - Anything else: "Transaction failed." The explorer link is shown alongside whenever there's a hash.
 */
import { decodeRevert, explainRevert, revertDataFromError } from "@glance/core/errors";
import { isRpcTrouble, RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";
import { ContractFunctionRevertedError, InsufficientFundsError, UserRejectedRequestError } from "viem";

export const TX_MESSAGES = {
  rejected: "You cancelled in your wallet, so nothing changed.",
  noGas: "Not enough test ETH for gas. Get some at faucet.testnet.chain.robinhood.com, then try again.",
  failed: "Transaction failed.",
  pending: "Waiting for Robinhood Chain testnet to include it.",
  confirmed: "Done. It's on chain.",
  unconfirmed: (hash: string) =>
    `It was sent (transaction ${hash}), but the testnet isn't responding to confirm it. Check the explorer before trying again.`,
} as const;

/** Every error in the cause chain, outermost first (viem's `.cause`, and any wallet error's). */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let e: unknown = err;
  while (e && typeof e === "object" && out.length < 20 && !out.includes(e)) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

export function isUserRejection(err: unknown): boolean {
  return chain(err).some((e) => e instanceof UserRejectedRequestError || (e as { code?: unknown }).code === 4001);
}

export interface TxErrorContext {
  usdgDecimals: number;
  now?: number;
}

export function describeTxError(err: unknown, ctx: TxErrorContext): string {
  if (isUserRejection(err)) return TX_MESSAGES.rejected;
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const raw = revertDataFromError(err);
  if (raw) {
    const guard = explainRevert(decodeRevert(raw), { usdgDecimals: ctx.usdgDecimals, now });
    if (guard.code !== "UNKNOWN") return guard.message;
  }
  const reverted = chain(err).find((e): e is ContractFunctionRevertedError => e instanceof ContractFunctionRevertedError);
  const reason = reverted?.reason?.replace(/^execution reverted:?\s*/i, "").trim();
  if (reason) return reason;
  if (chain(err).some((e) => e instanceof InsufficientFundsError)) return TX_MESSAGES.noGas;
  if (isRpcTrouble(err)) return RPC_TROUBLE_MESSAGE;
  return TX_MESSAGES.failed;
}
