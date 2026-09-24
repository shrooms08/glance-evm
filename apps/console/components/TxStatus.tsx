import { txUrl } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { TX_MESSAGES } from "@/lib/txMessages";
import type { TxState } from "@/lib/useOwnerTx";

/** Where an owner's transaction is: checking, in the wallet, pending with its hash, confirmed, or failed and why. */
export function TxStatus({ state, onDismiss, onReconnect }: { state: TxState; onDismiss?(): void; onReconnect?(): void }) {
  if (state.status === "idle") return null;
  const hash = "hash" in state ? state.hash : undefined;
  const text =
    state.status === "checking"
      ? "Checking it against the vault first…"
      : state.status === "wallet"
        ? "Confirm it in your wallet."
        : state.status === "pending"
          ? TX_MESSAGES.pending
          : state.status === "confirmed"
            ? TX_MESSAGES.confirmed
            : state.message;
  return (
    <div className="tx" data-status={state.status} role={state.status === "failed" ? "alert" : "status"} aria-live="polite">
      <span className="tx-indicator" aria-hidden />
      <div className="tx-body">
        <p className="tx-label">{state.label}</p>
        <p className="tx-text">{text}</p>
        {hash && (
          <a className="tx-link mono" href={txUrl(hash)} target="_blank" rel="noreferrer">
            {shortAddress(hash)} on the explorer ↗
          </a>
        )}
      </div>
      {state.status === "failed" && state.reconnect && onReconnect && (
        <button className="btn btn-primary btn-small" onClick={onReconnect}>
          Reconnect
        </button>
      )}
      {onDismiss && (state.status === "confirmed" || state.status === "failed") && (
        <button className="btn btn-ghost btn-small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
