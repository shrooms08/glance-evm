"use client";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";
import type { Address } from "viem";
import { useAccount, useSwitchChain } from "wagmi";

import { robinhoodTestnet } from "@/lib/chain";
import { CHAIN_ID } from "@/lib/deployment";
import { reportError } from "@/lib/report";
import { describeTxError } from "@/lib/txMessages";

import { gateReason } from "./WriteGate";

/** The gate for a vault's owner, with one-click connect and network switch (adding the network when it's missing). */
export function useGate(owner: Address | undefined) {
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending, error: switchErr } = useSwitchChain();
  const reason = gateReason({ isConnected, walletChainId: chainId, expectedChainId: CHAIN_ID, account: address, owner });
  return {
    reason,
    account: address,
    onConnect: openConnectModal,
    /** Why the last network switch failed, in plain words (null if it didn't). */
    switchError: switchErr ? describeTxError(switchErr, { usdgDecimals: 6, account: address }) : null,
    onSwitchNetwork: () =>
      switchChain(
        {
        chainId: CHAIN_ID,
        addEthereumChainParameter: {
          chainName: robinhoodTestnet.name,
          nativeCurrency: robinhoodTestnet.nativeCurrency,
          rpcUrls: robinhoodTestnet.rpcUrls.default.http,
          blockExplorerUrls: [robinhoodTestnet.blockExplorers.default.url],
        },
        },
        { onError: (err) => reportError("Switch to Robinhood Chain testnet", err) },
      ),
    switching: isPending,
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
