/**
 * Linking a browser to a vault (the console's /link page): what the extension asked for, checked before anything is
 * signed. The owner signs an EIP-712 GlanceSession (packages/core/src/session.ts): a signature, never a transaction.
 */
import { getAddress, isAddress, type Address } from "viem";
import { MAX_SESSION_SECONDS } from "@glance/core/session";

export type LinkParams = { ok: true; vault: Address; session: Address; expiresAt: number } | { ok: false; problem: string };

/** /link?vault=<vault>&session=<session address>&expires=<unix seconds>, checked. */
export function parseLinkParams(params: { get(name: string): string | null }, now: number): LinkParams {
  const vault = params.get("vault");
  const session = params.get("session");
  const expires = Number(params.get("expires"));
  if (!vault || !isAddress(vault) || !session || !isAddress(session)) {
    return { ok: false, problem: "This link is missing the vault or the browser's session. Start again from Glance's settings." };
  }
  if (!Number.isInteger(expires) || expires <= now) return { ok: false, problem: "This link has expired. Start again from Glance's settings." };
  if (expires > now + MAX_SESSION_SECONDS + 300) return { ok: false, problem: "A browser can be linked for 30 days at most. Start again from Glance's settings." };
  return { ok: true, vault: getAddress(vault), session: getAddress(session), expiresAt: expires };
}
