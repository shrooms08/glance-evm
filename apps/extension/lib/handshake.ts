/**
 * The console <-> extension handshake, over window.postMessage on the console's own pages only (the console-marker
 * content script runs on WXT_CONSOLE_ORIGINS alone, and checks the origin again here).
 *
 *   extension -> page  GLANCE_HELLO     { installed, version, sessionAddress, vault, linkedUntil, mode }
 *   page -> extension  GLANCE_PING      (asks for a HELLO: the page may load before or after the content script)
 *                      GLANCE_SET_VAULT { vault }   sent by the console only once the connected wallet is verified as
 *                                                   that vault's owner
 *                      GLANCE_LINKED    { vault, sessionAddress, expiresAt }
 *                      GLANCE_UNLINKED  { vault }
 *
 * Nothing a page says can make the extension trade: it can only choose which vault Glance uses, and report a link.
 * A reported link or unlink is believed only once GET /session/status confirms it. The session's private key is never
 * in any message: HELLO carries its address only.
 */
export const FROM_EXTENSION = "glance-extension";
export const FROM_CONSOLE = "glance-console";

export interface Hello {
  source: typeof FROM_EXTENSION;
  type: "GLANCE_HELLO";
  installed: true;
  version: string;
  sessionAddress: string;
  vault: string | null;
  /** Unix seconds, when this browser's link to `vault` ends (null: not linked). */
  linkedUntil: number | null;
  /** "demo": Glance is on the open demo vault (the default); "own": a vault the console set (or typed by hand). */
  mode: "demo" | "own";
  /** The keyboard shortcuts as the browser has them ("⌥G"), for the install page. */
  shortcuts?: { glance: string; talk: string };
}

export type ConsoleMessage =
  | { source: typeof FROM_CONSOLE; type: "GLANCE_PING" }
  | { source: typeof FROM_CONSOLE; type: "GLANCE_SET_VAULT"; vault: string }
  | { source: typeof FROM_CONSOLE; type: "GLANCE_LINKED"; vault: string; sessionAddress: string; expiresAt: number }
  | { source: typeof FROM_CONSOLE; type: "GLANCE_UNLINKED"; vault: string };

const address = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A message from the console page, checked field by field; anything else is null (and ignored). */
export function parseConsoleMessage(data: unknown): ConsoleMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== FROM_CONSOLE) return null;
  switch (m.type) {
    case "GLANCE_PING":
      return { source: FROM_CONSOLE, type: "GLANCE_PING" };
    case "GLANCE_SET_VAULT":
      return address(m.vault) ? { source: FROM_CONSOLE, type: "GLANCE_SET_VAULT", vault: m.vault } : null;
    case "GLANCE_LINKED":
      return address(m.vault) && address(m.sessionAddress) && typeof m.expiresAt === "number"
        ? { source: FROM_CONSOLE, type: "GLANCE_LINKED", vault: m.vault, sessionAddress: m.sessionAddress, expiresAt: m.expiresAt }
        : null;
    case "GLANCE_UNLINKED":
      return address(m.vault) ? { source: FROM_CONSOLE, type: "GLANCE_UNLINKED", vault: m.vault } : null;
    default:
      return null;
  }
}

export interface HandshakeDeps {
  /** The console origins this build allows (WXT_CONSOLE_ORIGINS). */
  allowedOrigins: readonly string[];
  /** The page's own origin (location.origin). */
  pageOrigin: string;
  /** Posts to the page, to its own origin only. */
  post(message: Hello): void;
  version: string;
  shortcuts?(): Promise<{ glance: string; talk: string } | null>;
  sessionAddress(): Promise<string>;
  vault(): Promise<string | null>;
  /** Whether a vault is the open demo vault. */
  isDemo(vault: string): boolean;
  /** This browser's last confirmed link: { vault, expiresAt } or null. */
  link(): Promise<{ vault: string; expiresAt: number } | null>;
  setVault(vault: string): Promise<void>;
  setLink(link: { vault: string; expiresAt: number } | null): Promise<void>;
  /** GET /session/status through the background: the API's word, not the page's. */
  status(vault: string, session: string): Promise<{ linked: true; expiresAt: number } | { linked: false } | null>;
  now?(): number;
}

export function createHandshake(d: HandshakeDeps) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const allowed = d.allowedOrigins.includes(d.pageOrigin);

  async function hello(): Promise<Hello> {
    const [sessionAddress, vault, link, shortcuts] = await Promise.all([d.sessionAddress(), d.vault(), d.link(), d.shortcuts?.().catch(() => null) ?? null]);
    const linkedUntil = link && vault && same(link.vault, vault) && link.expiresAt > now() ? link.expiresAt : null;
    return { source: FROM_EXTENSION, type: "GLANCE_HELLO", installed: true, version: d.version, sessionAddress, vault, linkedUntil, mode: !vault || d.isDemo(vault) ? "demo" : "own", ...(shortcuts ? { shortcuts } : {}) };
  }

  async function sayHello() {
    if (allowed) d.post(await hello());
  }

  return {
    allowed,
    hello,
    sayHello,
    /**
     * One window message. Only from this very window, at an allowed console origin, from the console; everything else
     * is ignored. Returns what it did (for tests and the debug log).
     */
    async receive(event: { origin: string; data: unknown; fromThisWindow: boolean }): Promise<string> {
      if (!allowed || !event.fromThisWindow || event.origin !== d.pageOrigin || !d.allowedOrigins.includes(event.origin)) return "ignored";
      const m = parseConsoleMessage(event.data);
      if (!m) return "ignored";
      switch (m.type) {
        case "GLANCE_PING":
          await sayHello();
          return "hello";
        case "GLANCE_SET_VAULT":
          // The console sends this only after verifying the connected wallet owns the vault. It chooses the vault
          // Glance uses; trading still needs this browser's own signed, owner-linked session.
          await d.setVault(m.vault);
          await sayHello();
          return "vault set";
        case "GLANCE_LINKED": {
          const me = await d.sessionAddress();
          if (!same(me, m.sessionAddress)) return "ignored";
          const s = await d.status(m.vault, me);
          if (!s?.linked) return "not confirmed";
          await d.setLink({ vault: m.vault, expiresAt: s.expiresAt });
          await sayHello();
          return "linked";
        }
        case "GLANCE_UNLINKED": {
          const link = await d.link();
          if (!link || !same(link.vault, m.vault)) return "ignored";
          const s = await d.status(m.vault, await d.sessionAddress());
          if (s?.linked) return "not confirmed";
          await d.setLink(null);
          await sayHello();
          return "unlinked";
        }
      }
    },
  };
}

/** From 3 days before the link ends (and after it has ended): the "Relink" hint on the orb and in the panel. */
export const RELINK_HINT_SECONDS = 3 * 24 * 60 * 60;

export type RelinkHint = { show: false } | { show: true; expired: boolean; daysLeft: number };

export function relinkHint(link: { vault: string; expiresAt: number } | null, vault: string, now: number): RelinkHint {
  if (!link || !same(link.vault, vault)) return { show: false };
  const left = link.expiresAt - now;
  if (left > RELINK_HINT_SECONDS) return { show: false };
  return { show: true, expired: left <= 0, daysLeft: Math.max(0, Math.ceil(left / 86_400)) };
}
