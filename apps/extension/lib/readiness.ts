/**
 * Glance needs your own vault. It's "ready" only when all three hold:
 *   - a vault is set (by the console's handshake: nothing to paste),
 *   - its owner linked this browser (a session the API says is valid),
 *   - the vault holds USDG.
 * Until the first time all three hold, Glance shows only its setup card: no underlines, hover cards, prices, charts,
 * voice, Show me or trades. Once set up, losing one later shows a small banner with the one thing to do (Relink, Add
 * USDG) and leaves everything else as it was.
 */
import { storage } from "wxt/utils/storage";

/** Set once, the first time Glance is ready; the gate never comes back after that (only the banners). */
export const setupComplete = storage.defineItem<boolean>("local:setupComplete", { fallback: false });

/** What the console last reported about the owner's setup (display only: readiness is checked here, with the API). */
export interface SetupProgress {
  wallet: boolean;
  vault: boolean;
  funded: boolean;
  linked: boolean;
}
export const setupProgress = storage.defineItem<SetupProgress | null>("local:setupProgress", { fallback: null });

export interface ReadinessInput {
  /** The vault Glance uses ("" when none is set yet). */
  vault: string;
  /** This browser's link: its vault and end (from the handshake, confirmed with the API). */
  link: { vault: string; expiresAt: number } | null;
  /** GET /session/status's word for this vault and session: true, false, or null while unknown. */
  linkConfirmed: boolean | null;
  /** The vault's USDG, in its smallest unit (null while unknown). */
  usdgRaw: string | null;
  now: number;
}

export interface Readiness {
  ready: boolean;
  steps: { vault: boolean; linked: boolean; funded: boolean };
}

const isVault = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

export function readiness(i: ReadinessInput): Readiness {
  const vault = isVault(i.vault);
  const linked = vault && Boolean(i.link && i.link.vault.toLowerCase() === i.vault.toLowerCase() && i.link.expiresAt > i.now) && i.linkConfirmed !== false;
  const funded = vault && i.usdgRaw !== null && BigInt(i.usdgRaw) > 0n;
  return { ready: vault && linked && funded, steps: { vault, linked, funded } };
}

/** After setup: the one thing to do when readiness is lost (none while ready). */
export function lostAction(r: Readiness): "set-up" | "relink" | "add-usdg" | null {
  if (r.ready) return null;
  if (!r.steps.vault) return "set-up";
  if (!r.steps.linked) return "relink";
  return "add-usdg";
}

/** The setup card's four rows: the console's report for the wallet, and the extension's own checks for the rest. */
export function setupRows(r: Readiness, progress: SetupProgress | null): Array<{ key: string; label: string; done: boolean }> {
  return [
    { key: "wallet", label: "Wallet connected", done: Boolean(progress?.wallet) || r.steps.vault },
    { key: "vault", label: "Vault created", done: r.steps.vault || Boolean(progress?.vault) },
    { key: "funded", label: "Vault funded", done: r.steps.funded },
    { key: "linked", label: "This browser linked", done: r.steps.linked },
  ];
}
