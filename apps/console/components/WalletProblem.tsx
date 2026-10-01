"use client";
/**
 * When the chosen wallet can't reach Robinhood Chain testnet (Phantom), or a network switch failed: the reason, the
 * wallets that work (their official install pages), and "Try a different wallet", which reopens the wallet picker.
 */
import { WALLET_INSTALL } from "@/lib/walletSupport";

import { Notice } from "./Notice";

export function WalletProblem({ message, onTryDifferentWallet }: { message: string; onTryDifferentWallet(): void }) {
  return (
    <div data-testid="wallet-problem">
      <Notice tone="guard" role="alert" title={message}>
        <div className="row wrap">
          <a className="btn btn-primary btn-small" href={WALLET_INSTALL.metamask} target="_blank" rel="noopener noreferrer">
            Get MetaMask
          </a>
          <a className="btn btn-small" href={WALLET_INSTALL.rabby} target="_blank" rel="noopener noreferrer">
            Get Rabby
          </a>
          <button className="btn btn-small" onClick={onTryDifferentWallet}>
            Try a different wallet
          </button>
        </div>
      </Notice>
    </div>
  );
}
