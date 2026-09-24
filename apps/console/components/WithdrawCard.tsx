"use client";
/**
 * Withdraw USDG from the vault to its owner. The vault's withdraw(token, amount) is owner-only and always pays the
 * owner (GlanceVault.withdraw: safeTransfer(owner, amount)), so the connected owner wallet receives it. The agent can
 * never do this.
 */
import { glanceVaultAbi } from "@glance/core/abi";
import { useState } from "react";
import { erc20Abi, type Abi, type Address } from "viem";
import { useReadContract } from "wagmi";

import { CHAIN_ID } from "@/lib/deployment";
import { formatUsd, shortAddress, toDecimalString } from "@/lib/format";
import { useOwnerTx, type TxState } from "@/lib/useOwnerTx";
import { parseWithdraw } from "@/lib/withdraw";

import { TxStatus } from "./TxStatus";
import { useGate, useReconnect } from "./useGate";
import type { GateReason } from "./WriteGate";

export const NOT_OWNER_WITHDRAW = "Only the vault owner can withdraw";

const reasonText: Record<Exclude<GateReason, null>, string> = {
  "no-wallet": "Connect the owner's wallet to withdraw.",
  "wrong-network": "Switch your wallet to Robinhood Chain testnet to withdraw.",
  "not-owner": NOT_OWNER_WITHDRAW,
  loading: "Checking who owns this vault…",
};

export interface WithdrawFormProps {
  reason: GateReason;
  /** The vault's USDG balance, raw. */
  balance: bigint;
  decimals: number;
  usdgLabel: string;
  owner?: Address;
  walletUsdg?: bigint;
  tx: TxState;
  busy: boolean;
  onWithdraw(amount: bigint): void;
  onSwitchNetwork?(): void;
  onConnect?(): void;
  /** Shown when the wallet hasn't authorised this account for the site. */
  onReconnect?(): void;
  /** Why the last network switch failed, if it did. */
  switchError?: string | null;
}

/** The card itself, without any wallet wiring (so its states can be tested directly). */
export function WithdrawForm({ reason, balance, decimals, usdgLabel, owner, walletUsdg, tx, busy, onWithdraw, onSwitchNetwork, onConnect, onReconnect, switchError }: WithdrawFormProps) {
  const [input, setInput] = useState("");
  const parsed = parseWithdraw(input, balance, decimals);
  const locked = reason !== null;
  return (
    <section className="card" aria-labelledby="withdraw-h" data-locked={locked || undefined}>
      <div className="between">
        <div>
          <h2 className="heading" id="withdraw-h">
            Withdraw
          </h2>
          <p className="meta">
            From the vault to the owner{owner ? ` (${shortAddress(owner)})` : ""}. Only the owner can do this; the agent never can.
          </p>
        </div>
        <p className="figure-sm" aria-label="In the vault">
          {formatUsd(balance, decimals)}
        </p>
      </div>
      {locked && (
        <div className="row wrap">
          <p className={reason === "not-owner" ? "ui text-guard" : "ui"} role="note">
            {reasonText[reason]}
          </p>
          {reason === "wrong-network" && onSwitchNetwork && (
            <button className="btn btn-small" onClick={onSwitchNetwork}>
              Switch network
            </button>
          )}
          {reason === "wrong-network" && switchError && <p className="meta text-fail">{switchError}</p>}
          {reason === "no-wallet" && onConnect && (
            <button className="btn btn-small" onClick={onConnect}>
              Connect wallet
            </button>
          )}
        </div>
      )}
      <form
        className="withdraw"
        onSubmit={(e) => {
          e.preventDefault();
          if (!locked && !busy && parsed.ok) onWithdraw(parsed.amount);
        }}
      >
        <div className="field">
          <label htmlFor="withdraw-amount" className="ui">
            Amount ({usdgLabel})
          </label>
          <div className="row">
            <div className="input-unit grow" data-unit="$">
              <span aria-hidden>$</span>
              <input
                id="withdraw-amount"
                className="input mono"
                inputMode="decimal"
                placeholder="0.00"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={locked || busy}
                aria-invalid={!parsed.ok && parsed.error !== null}
                aria-describedby="withdraw-help"
              />
            </div>
            <button type="button" className="btn btn-small" onClick={() => setInput(toDecimalString(balance, decimals))} disabled={locked || busy || balance === 0n}>
              Max
            </button>
          </div>
          <p id="withdraw-help" className={!parsed.ok && parsed.error ? "meta text-fail" : "meta"}>
            {!parsed.ok && parsed.error
              ? parsed.error
              : walletUsdg !== undefined
                ? `Your wallet holds ${formatUsd(walletUsdg, decimals)} ${usdgLabel}.`
                : `Up to ${formatUsd(balance, decimals)}.`}
          </p>
        </div>
        <button type="submit" className="btn btn-primary" disabled={locked || busy || !parsed.ok}>
          {busy ? "Withdrawing…" : "Withdraw"}
        </button>
      </form>
      <TxStatus state={tx} onReconnect={onReconnect} />
    </section>
  );
}

/** The card wired to the owner's wallet. */
export function WithdrawCard({ vault, owner, usdg, decimals, balance, usdgLabel }: { vault: Address; owner: Address; usdg: Address; decimals: number; balance: bigint; usdgLabel: string }) {
  const gate = useGate(owner);
  const reconnect = useReconnect();
  const tx = useOwnerTx(decimals);
  const wallet = useReadContract({
    address: usdg,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: gate.account ? [gate.account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(gate.account) && gate.reason === null },
  });
  return (
    <WithdrawForm
      // A confirmed withdrawal starts the form over (empty amount), keeping its transaction status.
      key={tx.state.status === "confirmed" ? tx.state.hash : "form"}
      reason={gate.reason}
      balance={balance}
      decimals={decimals}
      usdgLabel={usdgLabel}
      owner={owner}
      walletUsdg={gate.reason === null ? (wallet.data as bigint | undefined) : undefined}
      tx={tx.state}
      busy={tx.busy}
      onConnect={gate.onConnect}
      onSwitchNetwork={gate.onSwitchNetwork}
      onReconnect={() => void reconnect()}
      switchError={gate.switchError}
      onWithdraw={(amount) =>
        void tx.send({
          label: `Withdraw ${formatUsd(amount, decimals)} ${usdgLabel}`,
          address: vault,
          abi: glanceVaultAbi as Abi,
          functionName: "withdraw",
          args: [usdg, amount],
        })
      }
    />
  );
}
