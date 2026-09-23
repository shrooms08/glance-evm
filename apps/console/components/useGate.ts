"use client";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { Address } from "viem";
import { useAccount, useSwitchChain } from "wagmi";

import { robinhoodTestnet } from "@/lib/chain";
import { CHAIN_ID } from "@/lib/deployment";

import { gateReason } from "./WriteGate";

/** The gate for a vault's owner, with one-click connect and network switch (adding the network when it's missing). */
export function useGate(owner: Address | undefined) {
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending } = useSwitchChain();
  const reason = gateReason({ isConnected, walletChainId: chainId, expectedChainId: CHAIN_ID, account: address, owner });
  return {
    reason,
    account: address,
    onConnect: openConnectModal,
    onSwitchNetwork: () =>
      switchChain({
        chainId: CHAIN_ID,
        addEthereumChainParameter: {
          chainName: robinhoodTestnet.name,
          nativeCurrency: robinhoodTestnet.nativeCurrency,
          rpcUrls: robinhoodTestnet.rpcUrls.default.http,
          blockExplorerUrls: [robinhoodTestnet.blockExplorers.default.url],
        },
      }),
    switching: isPending,
  };
}
