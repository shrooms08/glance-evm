/**
 * Wallets: browser wallets always (MetaMask, Rabby, Brave Wallet, Coinbase Wallet, or any injected one); phone wallets
 * by QR code only when a WalletConnect project id is set. One chain: Robinhood Chain testnet.
 */
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { braveWallet, coinbaseWallet, injectedWallet, metaMaskWallet, phantomWallet, rabbyWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";

import { robinhoodTestnet, transport } from "./chain";
import { env } from "./env";

const withWalletConnect = Boolean(env.walletConnectProjectId);

/** Phantom, as the picker shows it: last, and "(not supported)" (its EIP-6963 announcement is folded into this entry). */
const phantomNotSupported: typeof phantomWallet = () => ({ ...phantomWallet(), name: "Phantom (not supported)" });

const connectors = connectorsForWallets(
  [
    {
      groupName: "Browser wallets",
      wallets: withWalletConnect ? [metaMaskWallet, rabbyWallet, braveWallet, coinbaseWallet, injectedWallet] : [injectedWallet, rabbyWallet, braveWallet, coinbaseWallet],
    },
    ...(withWalletConnect ? [{ groupName: "Phone wallets", wallets: [walletConnectWallet] }] : []),
    // Phantom can't add Robinhood Chain testnet: listed last, and said plainly (lib/walletSupport.ts shows why if picked).
    { groupName: "Can't reach Robinhood Chain", wallets: [phantomNotSupported] },
  ],
  // Only WalletConnect uses the project id; without one it's never asked for.
  { appName: "Glance", projectId: env.walletConnectProjectId || "unused-without-walletconnect" },
);

export const wagmiConfig = createConfig({
  chains: [robinhoodTestnet],
  connectors,
  transports: { [robinhoodTestnet.id]: transport },
  ssr: true,
});
