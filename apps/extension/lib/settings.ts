/**
 * User settings, in chrome.storage.sync so they follow the user across their browsers.
 */
import { storage } from "wxt/utils/storage";

import { sound } from "./tokens";

export type Mode = "floating" | "docked";

/**
 * The Glance API and console: localhost for development; a production build bakes in the hosted ones
 * (API_URL=... CONSOLE_URL=... pnpm --filter extension build:prod sets WXT_API_URL and WXT_CONSOLE_URL). A user can
 * still point Glance elsewhere under Settings > Advanced (that choice is kept in storage and wins).
 */
export const DEFAULT_API_URL: string = import.meta.env.WXT_API_URL || "http://localhost:8790";
export const DEFAULT_CONSOLE_URL: string = import.meta.env.WXT_CONSOLE_URL || "http://localhost:3000";

export const apiBaseUrl = storage.defineItem<string>("sync:apiBaseUrl", { fallback: DEFAULT_API_URL });
/**
 * The vault Glance uses: set by the console's handshake once the owner connects Glance (or typed by hand under
 * Settings > Advanced, for developers). Empty until then: Glance shows only its setup card.
 */
export const vaultAddress = storage.defineItem<string>("sync:vaultAddress", { fallback: "" });

/** Where the vault came from: the console's handshake (the owner connected Glance), or typed under Settings > Advanced. */
export type VaultSource = "console" | "manual";
export const vaultSource = storage.defineItem<VaultSource | null>("sync:vaultSource", { fallback: null });

/** Letter tapped with Option/Alt to glance at the page (scan and show what was found). Kept under its old storage key. */
export const hotkeyLetter = storage.defineItem<string>("sync:hotkeyLetter", { fallback: "G" });
/** Letter held with Option/Alt to talk. V by default; remappable because Option+V is taken in some macOS apps. */
export const voiceKeyLetter = storage.defineItem<string>("sync:voiceKeyLetter", { fallback: "V" });
export const defaultMode = storage.defineItem<Mode>("sync:defaultMode", { fallback: "floating" });
export const consoleUrl = storage.defineItem<string>("sync:consoleUrl", { fallback: DEFAULT_CONSOLE_URL });
export const voiceReplies = storage.defineItem<boolean>("sync:voiceReplies", { fallback: true });
/**
 * Conversation mode: tap Option+V once, then just talk. Speech recognition's end of turn sends what was said (no key
 * to hold), and listening stops after the reply: the microphone is never left on. Off by default: hold-to-talk.
 */
export const conversationMode = storage.defineItem<boolean>("sync:conversationMode", { fallback: false });
/** Developer tools (on in dev builds anyway): "glance test drawing" in the panel draws every Show me shape. */
export const devTools = storage.defineItem<boolean>("local:devTools", { fallback: false });
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
