"use client";
/**
 * Every control that changes a vault sits behind this gate. Only the vault's owner, connected on Robinhood Chain
 * testnet, can use them; anyone else sees the controls disabled and exactly why. The vault enforces the same rule on
 * chain (NotOwner), so this is courtesy, not security.
 */
import type { ReactNode } from "react";
import { isAddressEqual, type Address } from "viem";

import { shortAddress } from "@/lib/format";

import { Notice } from "./Notice";

export type GateReason = "no-wallet" | "wrong-network" | "not-owner" | "loading" | null;

export function gateReason(p: { isConnected: boolean; walletChainId: number | undefined; expectedChainId: number; account?: Address; owner?: Address }): GateReason {
  if (!p.isConnected || !p.account) return "no-wallet";
  if (p.walletChainId !== p.expectedChainId) return "wrong-network";
  if (!p.owner) return "loading";
  return isAddressEqual(p.account, p.owner) ? null : "not-owner";
}

export function GateNotice({
  reason,
  owner,
  account,
  onConnect,
  onSwitchNetwork,
  switching,
  switchError,
}: {
  reason: GateReason;
  owner?: Address;
  account?: Address;
  onConnect?(): void;
  onSwitchNetwork?(): void;
  switching?: boolean;
  /** Why the last network switch failed, if it did. */
  switchError?: string | null;
}) {
  if (reason === "no-wallet") {
    return (
      <Notice
        tone="info"
        title="Connect the owner's wallet to change anything"
        action={onConnect && <button className="btn btn-primary" onClick={onConnect}>Connect wallet</button>}
      >
        You can read everything without a wallet. Changes are signed by the vault owner's own wallet, never by Glance.
      </Notice>
    );
  }
  if (reason === "wrong-network") {
    return (
      <Notice
        tone="guard"
        title="Your wallet is on another network"
        action={
          onSwitchNetwork && (
            <button className="btn btn-primary" onClick={onSwitchNetwork} disabled={switching}>
              {switching ? "Check your wallet…" : "Switch to Robinhood Chain testnet"}
            </button>
          )
        }
      >
        This vault lives on Robinhood Chain testnet (chain 46630). One click switches, and adds the network to your wallet if
        it isn&apos;t there yet.
        {switchError && <span className="text-fail"> {switchError}</span>}
      </Notice>
    );
  }
  if (reason === "not-owner") {
    return (
      <Notice tone="guard" title="You're not this vault's owner, so the controls are off">
        This vault belongs to <span className="mono">{owner ? shortAddress(owner) : "someone else"}</span>, and you're connected as{" "}
        <span className="mono">{account ? shortAddress(account) : "another wallet"}</span>. Only the owner can change limits, pause, or
        revoke the agent: the vault itself refuses anyone else. The controls stay visible so you can see what an owner can do.
      </Notice>
    );
  }
  return null;
}

/** Disables every input and button inside while the gate is closed (a disabled fieldset does that natively). */
export function WriteGate({ reason, children }: { reason: GateReason; children: ReactNode }) {
  return (
    <fieldset className="gate" disabled={reason !== null} data-gate={reason ?? "open"}>
      {children}
    </fieldset>
  );
}
