"use client";
import { ConnectButton } from "@rainbow-me/rainbowkit";

import { CHAIN_ID } from "@/lib/deployment";
import { shortAddress } from "@/lib/format";

import { useGate } from "./useGate";

/** The wallet button: connect, the wrong network (one click to switch), or the connected address. */
export function Connect() {
  const gate = useGate(undefined);
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        if (!mounted) return <span className="btn btn-small is-placeholder" aria-hidden>Connect</span>;
        if (!account) {
          return (
            <button className="btn btn-primary btn-small" onClick={openConnectModal}>
              Connect wallet
            </button>
          );
        }
        if (!chain || chain.id !== CHAIN_ID || chain.unsupported) {
          return (
            <button className="btn btn-guard btn-small" onClick={gate.onSwitchNetwork} disabled={gate.switching}>
              {gate.switching ? "Check your wallet…" : "Switch network"}
            </button>
          );
        }
        return (
          <button className="btn btn-small" onClick={openAccountModal}>
            <span className="live-dot" aria-hidden />
            <span className="mono">{shortAddress(account.address)}</span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
