/**
 * Linking this browser to a vault, from any surface (settings, a trade card): open the console's /link page, where the
 * vault's owner signs, then wait for the API to say it's linked. The session key itself stays in the background worker.
 */
import { DEMO_VAULT_LABEL } from "@glance/core/session";

import { api } from "./api";
import { send } from "./lifecycle";
import type { SessionInfo, SessionLinkStarted } from "./messages";
import { sessionLink } from "./session";
import { DEMO_VAULTS } from "./settings";

/** A trade refused for want of a linked browser: the card offers to link it. */
export const LINK_CODES = new Set(["SESSION_REQUIRED", "SESSION_EXPIRED"]);

/** The vault anyone may trade without linking (the API's OPEN_DEMO_VAULTS default), and how it's labelled. */
export function isOpenDemoVault(vault: string): boolean {
  return vault.toLowerCase() === DEMO_VAULTS.paxosUSDG.toLowerCase();
}
export { DEMO_VAULT_LABEL };

/** This browser's session address (never the key). */
export async function sessionInfo(): Promise<string | null> {
  const info = await send<SessionInfo | undefined>({ kind: "session:info" }).catch(() => undefined);
  return info?.address ?? null;
}

/** Opens the console's /link page for the vault. */
export async function startLinking(vault: string): Promise<SessionLinkStarted | null> {
  return (await send<SessionLinkStarted | null | undefined>({ kind: "session:link", vault }).catch(() => null)) ?? null;
}

/** "Unlink this browser": forgets its key (the next link makes a new one). */
export async function forgetThisBrowser(): Promise<void> {
  await send({ kind: "session:forget" }).catch(() => {});
}

export type LinkStatus = { linked: true; expiresAt: number } | { linked: false; reason: string };

/** The API's word on whether this browser is linked to the vault. */
export async function linkStatus(vault: string, session: string): Promise<LinkStatus> {
  const res = await api.sessionStatus(vault, session);
  if (!res.ok) return { linked: false, reason: "unreachable" };
  if (res.data.linked) {
    await sessionLink.setValue({ vault, expiresAt: res.data.expiresAt });
    return { linked: true, expiresAt: res.data.expiresAt };
  }
  return { linked: false, reason: res.data.reason };
}

/**
 * Polls until the owner has linked this browser (every 2 seconds, up to 10 minutes), or the signal aborts. The owner
 * signs in the console tab; Glance notices here.
 */
export async function waitForLink(
  vault: string,
  session: string,
  o: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LinkStatus> {
  const interval = o.intervalMs ?? 2_000;
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    if (o.signal?.aborted) return { linked: false, reason: "cancelled" };
    const status = await linkStatus(vault, session);
    if (status.linked) return status;
    if (Date.now() >= deadline) return { linked: false, reason: "timeout" };
    await sleep(interval);
  }
}

/** "Linked until 24 October 2026". */
export function linkedUntil(expiresAt: number): string {
  return `Linked until ${new Date(expiresAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
}
