/**
 * User settings, in chrome.storage.sync so they follow the user across their browsers.
 */
import { storage } from "wxt/utils/storage";

export type Mode = "floating" | "docked";

export const DEFAULT_API_URL = "http://localhost:8790";
export const DEFAULT_CONSOLE_URL = "http://localhost:3000";

export const apiBaseUrl = storage.defineItem<string>("sync:apiBaseUrl", { fallback: DEFAULT_API_URL });
/** The vault the agent trades for. Empty until the user sets it. */
export const vaultAddress = storage.defineItem<string>("sync:vaultAddress", { fallback: "" });
/** Letter tapped with Option/Alt to glance at the page (scan and show what was found). Kept under its old storage key. */
export const hotkeyLetter = storage.defineItem<string>("sync:hotkeyLetter", { fallback: "G" });
/** Letter held with Option/Alt to talk. V by default; remappable because Option+V is taken in some macOS apps. */
export const voiceKeyLetter = storage.defineItem<string>("sync:voiceKeyLetter", { fallback: "V" });
export const defaultMode = storage.defineItem<Mode>("sync:defaultMode", { fallback: "floating" });
export const consoleUrl = storage.defineItem<string>("sync:consoleUrl", { fallback: DEFAULT_CONSOLE_URL });
export const voiceReplies = storage.defineItem<boolean>("sync:voiceReplies", { fallback: true });

/** Orb position as distances from the viewport's right and bottom edges, so it survives window resizes. */
export interface OrbPosition {
  right: number;
  bottom: number;
}
export const orbPosition = storage.defineItem<OrbPosition>("sync:orbPosition", { fallback: { right: 24, bottom: 24 } });

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}
