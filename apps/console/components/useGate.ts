"use client";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useCallback, useEffect, useState } from "react";
import { useDisconnect } from "wagmi";
import type { Address } from "viem";
import { useAccount, useSwitchChain } from "wagmi";

import { robinhoodTestnet } from "@/lib/chain";
import { CHAIN_ID } from "@/lib/deployment";
import { reportError } from "@/lib/report";
import { describeTxError } from "@/lib/txMessages";
import { isPhantom, PHANTOM_MESSAGE, switchToRobinhood, type WalletInfo, type WalletWindow } from "@/lib/walletSupport";

import { gateReason } from "./WriteGate";

/** The connected wallet, as lib/walletSupport.ts reads it: the connector's id, name, EIP-6963 rdns and provider. */
async function walletInfo(connector: { id?: string; name?: string; rdns?: string | readonly string[]; getProvider?: () => Promise<unknown> } | undefined): Promise<WalletInfo> {
  if (!connector) return {};
  const provider = await connector.getProvider?.().catch(() => undefined);
  return { id: connector.id, name: connector.name, rdns: connector.rdns, provider };
}

const pageWindow = (): WalletWindow => (typeof window === "undefined" ? {} : (window as unknown as WalletWindow));

/**
 * The gate for a vault's owner, with one-click connect and network switch (adding the network when it's missing). A
 * wallet that can't reach Robinhood Chain testnet (Phantom) is recognised before any switch is asked for, and a switch
 * that fails or never answers says so (`walletProblem`), with the wallets that work.
 */
export function useGate(owner: Address | undefined) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChainAsync, error: switchErr } = useSwitchChain();
  const { disconnectAsync } = useDisconnect();
  const [switching, setSwitching] = useState(false);
  const [problem, setProblem] = useState<{ kind: "phantom" | "switch"; message: string } | null>(null);
  const reason = gateReason({ isConnected, walletChainId: chainId, expectedChainId: CHAIN_ID, account: address, owner });

  // The moment a wallet connects: Phantom shows its card before any switch is asked for.
  useEffect(() => {
    let live = true;
    setProblem(null);
    if (!connector) return;
    void walletInfo(connector).then((w) => {
      if (live && isPhantom(w, pageWindow())) setProblem({ kind: "phantom", message: PHANTOM_MESSAGE });
    });
    return () => {
      live = false;
    };
  }, [connector]);

  const onSwitchNetwork = useCallback(async () => {
    if (switching) return;
    setSwitching(true);
    try {
      const outcome = await switchToRobinhood({
        wallet: await walletInfo(connector),
        win: pageWindow(),
        switchChain: () =>
          switchChainAsync({
            chainId: CHAIN_ID,
            addEthereumChainParameter: {
              chainName: robinhoodTestnet.name,
              nativeCurrency: robinhoodTestnet.nativeCurrency,
              rpcUrls: robinhoodTestnet.rpcUrls.default.http,
              blockExplorerUrls: [robinhoodTestnet.blockExplorers.default.url],
            },
          }),
      });
      if (outcome.kind === "phantom") setProblem({ kind: "phantom", message: outcome.message });
      else if (outcome.kind === "failed") {
        setProblem({ kind: "switch", message: outcome.message });
        reportError("Switch to Robinhood Chain testnet", switchErr ?? new Error(`wallet ${connector?.name ?? "?"}: code ${outcome.code ?? "none"}`));
      } else setProblem(null);
    } finally {
      setSwitching(false);
    }
  }, [connector, switchChainAsync, switching, switchErr]);

  return {
    reason,
    account: address,
    onConnect: openConnectModal,
    /** Why the last network switch failed, in plain words (null if it didn't). */
    switchError: problem ? problem.message : switchErr ? describeTxError(switchErr, { usdgDecimals: 6, account: address }) : null,
    /** A wallet that can't reach Robinhood Chain testnet (Phantom), or a switch that failed: what to show instead. */
    walletProblem: problem,
    /** "Try a different wallet": disconnects, then reopens the wallet picker. */
    onTryDifferentWallet: async () => {
      setProblem(null);
      try {
        await disconnectAsync();
      } finally {
        openConnectModal?.();
      }
    },
    onSwitchNetwork,
    switching,
  };
}

/**
 * Reconnect: for when the wallet shows an account the site isn't authorised for (e.g. a new MetaMask account).
 * Disconnects, then opens the wallet picker so the wallet asks which accounts to connect.
 */
export function useReconnect() {
  const { disconnectAsync } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  return async () => {
    try {
      await disconnectAsync();
    } finally {
      openConnectModal?.();
    }
  };
}
