/**
 * User settings, in chrome.storage.sync so they follow the user across their browsers.
 */
import { storage } from "wxt/utils/storage";

import { sound } from "./tokens";

export type Mode = "floating" | "docked";

export const DEFAULT_API_URL = "http://localhost:8790";
export const DEFAULT_CONSOLE_URL = "http://localhost:3000";

export const apiBaseUrl = storage.defineItem<string>("sync:apiBaseUrl", { fallback: DEFAULT_API_URL });
/**
 * The demo vaults on Robinhood Chain testnet (deployments/46630.json). The default is the one on the real Paxos USDG
 * (claimable at https://faucet.paxos.com/). The TestUSDG vault is the documented alternative for anyone without Paxos
 * USDG: its stand-in token has an on-chain faucet.
 */
export const DEMO_VAULTS = {
  paxosUSDG: "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113",
  testUSDG: "0xacfE90d34Bb56222Af06904A7547b6a9aC9AEe2D",
} as const;
export const DEFAULT_VAULT = DEMO_VAULTS.paxosUSDG;

/** The vault the agent trades for. Defaults to the Paxos USDG demo vault; set your own in settings. */
export const vaultAddress = storage.defineItem<string>("sync:vaultAddress", { fallback: DEFAULT_VAULT });
/** Letter tapped with Option/Alt to glance at the page (scan and show what was found). Kept under its old storage key. */
export const hotkeyLetter = storage.defineItem<string>("sync:hotkeyLetter", { fallback: "G" });
/** Letter held with Option/Alt to talk. V by default; remappable because Option+V is taken in some macOS apps. */
export const voiceKeyLetter = storage.defineItem<string>("sync:voiceKeyLetter", { fallback: "V" });
export const defaultMode = storage.defineItem<Mode>("sync:defaultMode", { fallback: "floating" });
export const consoleUrl = storage.defineItem<string>("sync:consoleUrl", { fallback: DEFAULT_CONSOLE_URL });
export const voiceReplies = storage.defineItem<boolean>("sync:voiceReplies", { fallback: true });
/** The water-drop sound as the panel opens and closes (Settings → "Sounds"). */
export const soundsEnabled = storage.defineItem<boolean>("sync:soundsEnabled", { fallback: sound.enabledByDefault });

/** Orb position as distances from the viewport's right and bottom edges, so it survives window resizes. */
export interface OrbPosition {
  right: number;
  bottom: number;
}
export const orbPosition = storage.defineItem<OrbPosition>("sync:orbPosition", { fallback: { right: 24, bottom: 24 } });

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}
