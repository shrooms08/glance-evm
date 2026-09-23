/**
 * What to say when an owner's transaction doesn't go through. A contract refusal gets the API's own sentence (the same
 * explainRevert the API and the extension use); everything else is said plainly, and always says whether anything
 * changed.
 */
import { decodeRevert, explainRevert, revertDataFromError } from "@glance/core/errors";
import { isRpcTrouble, RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";
import { BaseError, InsufficientFundsError, UserRejectedRequestError } from "viem";

export const TX_MESSAGES = {
  rejected: "You cancelled in your wallet, so nothing changed.",
  noGas: "Your wallet needs a little test ETH on Robinhood Chain testnet to pay for gas. Get some from the faucet, then try again.",
  wrongChain: "Your wallet is on another network. Switch to Robinhood Chain testnet and try again.",
  unknown: "The wallet couldn't send that, so nothing changed.",
  pending: "Waiting for Robinhood Chain testnet to include it.",
  confirmed: "Done. It's on chain.",
  unconfirmed: (hash: string) =>
    `It was sent (transaction ${hash}), but the testnet isn't responding to confirm it. Check the explorer before trying again.`,
} as const;

export interface TxErrorContext {
  usdgDecimals: number;
  now?: number;
}

export function describeTxError(err: unknown, ctx: TxErrorContext): string {
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError || (e as { code?: number }).code === 4001)) return TX_MESSAGES.rejected;
    if (err.walk((e) => e instanceof InsufficientFundsError)) return TX_MESSAGES.noGas;
    if (err.walk((e) => (e as { name?: string }).name === "ChainMismatchError")) return TX_MESSAGES.wrongChain;
  }
  const code = (err as { code?: number } | null)?.code;
  if (code === 4001) return TX_MESSAGES.rejected;
  const raw = revertDataFromError(err);
  if (raw) return explainRevert(decodeRevert(raw), { usdgDecimals: ctx.usdgDecimals, now }).message;
  if (isRpcTrouble(err)) return RPC_TROUBLE_MESSAGE;
  if (/user (rejected|denied)/i.test((err as Error)?.message ?? "")) return TX_MESSAGES.rejected;
  if (/insufficient funds/i.test((err as Error)?.message ?? "")) return TX_MESSAGES.noGas;
  return TX_MESSAGES.unknown;
}
