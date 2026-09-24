"use client";
/**
 * The console <-> extension handshake, the console's side (the extension's is apps/extension/lib/handshake.ts).
 * window.postMessage on this page only: messages go to this page's own origin, and only messages from this very window
 * at this page's origin, from the extension, are read. The extension's console-marker content script only runs on the
 * console origins it was built with (WXT_CONSOLE_ORIGINS), and checks the origin again on its side.
 *
 *   extension -> page  GLANCE_HELLO     { installed, version, sessionAddress, vault, linkedUntil, mode }
 *   page -> extension  GLANCE_PING      (asks for a HELLO)
 *                      GLANCE_SET_VAULT { vault }   only once the connected wallet is verified as that vault's owner
 *                      GLANCE_LINKED    { vault, sessionAddress, expiresAt }   after the API accepted the owner's link
 *                      GLANCE_UNLINKED  { vault }
 *
 * A page can't make the extension trade: it can only tell it which vault to use, and that linking happened (which the
 * extension checks with the API before believing it). No key ever travels here: HELLO carries the session's address.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, type Address } from "viem";

export const FROM_EXTENSION = "glance-extension";
export const FROM_CONSOLE = "glance-console";

export interface GlanceHello {
  installed: true;
  version: string;
  sessionAddress: Address;
  vault: Address | null;
  linkedUntil: number | null;
  /** "demo": Glance is on the open demo vault; "own": a vault the console set (or one typed by hand). */
  mode?: "demo" | "own";
  /** The keyboard shortcuts as this browser has them ("⌥G"). */
  shortcuts?: { glance: string; talk: string };
}

export type ExtensionState =
  | { status: "checking" }
  /** Not in this browser (or not reloaded since it was installed). The page keeps checking on its own. */
  | { status: "absent" }
  /** Installed, but a build from before the handshake: it marks the page, and says nothing. */
  | { status: "outdated" }
  | { status: "present"; hello: GlanceHello };

/** A HELLO from the extension, checked field by field (anything else is null and ignored). */
export function parseHello(data: unknown): GlanceHello | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== FROM_EXTENSION || m.type !== "GLANCE_HELLO" || m.installed !== true) return null;
  if (typeof m.sessionAddress !== "string" || !isAddress(m.sessionAddress)) return null;
  const vault = typeof m.vault === "string" && isAddress(m.vault) ? (m.vault as Address) : null;
  const linkedUntil = typeof m.linkedUntil === "number" ? m.linkedUntil : null;
  const mode = m.mode === "demo" || m.mode === "own" ? m.mode : undefined;
  const sc = m.shortcuts as { glance?: unknown; talk?: unknown } | undefined;
  const shortcuts = sc && typeof sc.glance === "string" && typeof sc.talk === "string" ? { glance: sc.glance.slice(0, 20), talk: sc.talk.slice(0, 20) } : undefined;
  return { installed: true, version: typeof m.version === "string" ? m.version : "", sessionAddress: m.sessionAddress as Address, vault, linkedUntil, mode, shortcuts };
}

/** Whether a window message may be read: this very window, this page's origin. */
export function fromThisPage(event: { source: unknown; origin: string }, win: { location: { origin: string } } & object): boolean {
  return event.source === win && event.origin === win.location.origin;
}

/** How long without a HELLO before the card says Glance isn't here (it keeps listening after that). */
export const HELLO_WAIT_MS = 1_500;
const PING_EVERY_MS = 3_000;

export function useGlanceExtension() {
  const [state, setState] = useState<ExtensionState>({ status: "checking" });
  const present = useRef(false);

  const post = useCallback((message: Record<string, unknown>) => {
    window.postMessage({ source: FROM_CONSOLE, ...message }, window.location.origin);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!fromThisPage(event, window)) return;
      const hello = parseHello(event.data);
      if (!hello) return;
      present.current = true;
      setState({ status: "present", hello });
    };
    window.addEventListener("message", onMessage);
    const ping = () => post({ type: "GLANCE_PING" });
    ping();
    // Keep asking: Glance may be installed (or reloaded) while this page is open.
    const every = setInterval(() => !present.current && ping(), PING_EVERY_MS);
    const wait = setTimeout(() => {
      if (present.current) return;
      setState({ status: document.documentElement.dataset.glanceExtension === "installed" ? "outdated" : "absent" });
    }, HELLO_WAIT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(every);
      clearTimeout(wait);
    };
  }, [post]);

  return {
    state,
    /** Only after the connected wallet is verified as this vault's owner. */
    setVault: (vault: Address) => post({ type: "GLANCE_SET_VAULT", vault }),
    linked: (vault: Address, sessionAddress: Address, expiresAt: number) => post({ type: "GLANCE_LINKED", vault, sessionAddress, expiresAt }),
    unlinked: (vault: Address) => post({ type: "GLANCE_UNLINKED", vault }),
  };
}

export type GlanceExtension = ReturnType<typeof useGlanceExtension>;
