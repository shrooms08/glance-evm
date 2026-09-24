/**
 * Links Glance in this browser to a vault: the owner's one EIP-712 signature (GlanceSession, 30 days; never a
 * transaction), accepted by the API only if the signer is the vault's owner on chain. Used by the Dashboard's
 * "Glance in this browser" card, Get started's step 5, the new-vault flow and the /link page.
 */
import type { Address, Hex } from "viem";
import { MAX_SESSION_SECONDS, randomNonce, revokeTypedData, sessionTypedData } from "@glance/core/session";

import { api } from "./api";
import { CHAIN_ID } from "./deployment";

type SignTyped = (typed: ReturnType<typeof sessionTypedData> | ReturnType<typeof revokeTypedData>) => Promise<Hex>;

/** Signs and sends the link; returns when it ends (unix seconds). */
export async function linkGlance(p: { vault: Address; session: Address; sign: SignTyped; now?: number }): Promise<number> {
  const now = p.now ?? Math.floor(Date.now() / 1000);
  const message = { vault: p.vault, sessionKey: p.session, expiresAt: BigInt(now + MAX_SESSION_SECONDS - 60), issuedAt: BigInt(now), nonce: randomNonce(256) };
  const typed = sessionTypedData(message, CHAIN_ID);
  const signature = await p.sign(typed);
  const res = await api.linkBrowser({ typedData: { domain: typed.domain, primaryType: typed.primaryType, message }, signature });
  return res.expiresAt;
}

/** Signs and sends the unlink. */
export async function unlinkGlance(p: { vault: Address; session: Address; sign: SignTyped }): Promise<void> {
  const message = { vault: p.vault, sessionKey: p.session, nonce: randomNonce(256) };
  const typed = revokeTypedData(message, CHAIN_ID);
  const signature = await p.sign(typed);
  await api.unlinkBrowser({ typedData: { domain: typed.domain, primaryType: typed.primaryType, message }, signature });
}

/** From 3 days before a link ends: the card says so, and offers Relink. */
export const RELINK_SOON_SECONDS = 3 * 24 * 60 * 60;

/**
 * Links Glance to the vault and only then tells the extension which vault to use and that it's linked. Nothing is
 * signed, and nothing is said to the extension, unless the connected wallet is verified as the vault's owner (and the
 * API checks the signer against vault.owner() on chain before accepting the link).
 */
export async function linkAndTell(p: {
  vault: Address;
  session: Address;
  sign: SignTyped;
  ownerVerified: boolean;
  tell: { setVault(vault: Address): void; linked(vault: Address, session: Address, expiresAt: number): void };
}): Promise<number> {
  if (!p.ownerVerified) throw new Error("Only the vault owner can link Glance to it.");
  const expiresAt = await linkGlance({ vault: p.vault, session: p.session, sign: p.sign });
  p.tell.setVault(p.vault);
  p.tell.linked(p.vault, p.session, expiresAt);
  return expiresAt;
}
