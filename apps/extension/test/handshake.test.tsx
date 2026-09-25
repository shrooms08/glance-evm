/**
 * One-tap setup, the extension's side: the console handshake (a wrong origin, another window, or a page that isn't the
 * console is ignored; no private key in any message; a reported link is stored only once the API confirms it), first
 * run ("Set up Glance" / "Try the demo vault"), no Link anywhere for the demo vault, and when the "Relink" hint shows.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserLink, vaultSourceLine } from "../components/BrowserLink";
import { RelinkNotice } from "../components/Setup";
import { consoleOrigins, consolePageUrl } from "../lib/consoleOrigins";
import { createHandshake, FROM_CONSOLE, relinkHint, type Hello, type HandshakeDeps } from "../lib/handshake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const background = vi.hoisted(() => ({ reply: (_msg: { kind: string; path?: string }): unknown => undefined }));
vi.mock("../lib/lifecycle", () => ({ send: async (msg: { kind: string; path?: string }) => background.reply(msg) }));

const CONSOLE = "http://localhost:3000";
const VAULT = "0x1111111111111111111111111111111111111111";
const OTHER_VAULT = "0x2222222222222222222222222222222222222222";
const privateKey = generatePrivateKey();
const session = privateKeyToAccount(privateKey).address;
const NOW = 1_790_000_000;

function setup(o: { pageOrigin?: string; apiLinked?: boolean } = {}) {
  const posted: Hello[] = [];
  const state = { vault: null as string | null, link: null as { vault: string; expiresAt: number } | null };
  const status = vi.fn(async () => (o.apiLinked === false ? { linked: false as const } : { linked: true as const, expiresAt: NOW + 30 * 86_400 }));
  const deps: HandshakeDeps = {
    allowedOrigins: consoleOrigins("http://localhost:3000,https://console.glance.example"),
    pageOrigin: o.pageOrigin ?? CONSOLE,
    post: (m) => posted.push(m),
    version: "0.1.0",
    sessionAddress: async () => session,
    vault: async () => state.vault,
    ready: async () => true,
    link: async () => state.link,
    setVault: async (v) => void (state.vault = v),
    setLink: async (l) => void (state.link = l),
    status,
    now: () => NOW,
  };
  return { h: createHandshake(deps), posted, state, status };
}
const from = (data: unknown, origin = CONSOLE, fromThisWindow = true) => ({ origin, data, fromThisWindow });

describe("the console handshake", () => {
  it("says hello to the console: installed, version, session address, vault, linked until; never the private key", async () => {
    const t = setup();
    t.state.vault = VAULT;
    t.state.link = { vault: VAULT, expiresAt: NOW + 86_400 };
    expect(await t.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_PING" }))).toBe("hello");
    expect(t.posted[0]).toEqual({ source: "glance-extension", type: "GLANCE_HELLO", installed: true, version: "0.1.0", sessionAddress: session, vault: VAULT, linkedUntil: NOW + 86_400, mode: "ready" });
    for (const m of t.posted) {
      const text = JSON.stringify(m);
      expect(text).not.toContain(privateKey.slice(2));
      expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
    }
  });

  it("ignores a wrong origin, another window, a page that isn't the console, and anything malformed", async () => {
    const t = setup();
    const set = { source: FROM_CONSOLE, type: "GLANCE_SET_VAULT", vault: VAULT };
    expect(await t.h.receive(from(set, "https://evil.example"))).toBe("ignored");
    expect(await t.h.receive(from(set, CONSOLE, false))).toBe("ignored");
    expect(await t.h.receive(from({ ...set, source: "someone-else" }))).toBe("ignored");
    expect(await t.h.receive(from({ ...set, vault: "0xnot-an-address" }))).toBe("ignored");
    expect(t.state.vault).toBeNull();
    // Running on a page outside the allowlist, the handshake does nothing at all.
    const stray = setup({ pageOrigin: "https://evil.example" });
    expect(stray.h.allowed).toBe(false);
    expect(await stray.h.receive(from(set, "https://evil.example"))).toBe("ignored");
    await stray.h.sayHello();
    expect(stray.posted).toEqual([]);
  });

  it("GLANCE_SET_VAULT (sent once the console has verified the owner) sets the vault Glance uses", async () => {
    const t = setup();
    expect(await t.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_SET_VAULT", vault: VAULT }))).toBe("vault set");
    expect(t.state.vault).toBe(VAULT);
    expect(t.posted.at(-1)!.vault).toBe(VAULT);
  });

  it("GLANCE_LINKED is stored only once the API confirms it (with the API's expiry, not the page's)", async () => {
    const t = setup();
    t.state.vault = VAULT;
    expect(await t.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_LINKED", vault: VAULT, sessionAddress: session, expiresAt: NOW + 999 * 86_400 }))).toBe("linked");
    expect(t.status).toHaveBeenCalledWith(VAULT, session);
    expect(t.state.link).toEqual({ vault: VAULT, expiresAt: NOW + 30 * 86_400 });
    const u = setup({ apiLinked: false });
    expect(await u.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_LINKED", vault: VAULT, sessionAddress: session, expiresAt: NOW + 86_400 }))).toBe("not confirmed");
    expect(u.state.link).toBeNull();
    // Another browser's session: not ours, ignored.
    expect(await u.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_LINKED", vault: VAULT, sessionAddress: OTHER_VAULT, expiresAt: NOW + 86_400 }))).toBe("ignored");
  });

  it("GLANCE_UNLINKED clears the link only once the API says it's gone", async () => {
    const still = setup();
    still.state.link = { vault: VAULT, expiresAt: NOW + 86_400 };
    expect(await still.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_UNLINKED", vault: VAULT }))).toBe("not confirmed");
    expect(still.state.link).not.toBeNull();
    const gone = setup({ apiLinked: false });
    gone.state.link = { vault: VAULT, expiresAt: NOW + 86_400 };
    expect(await gone.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_UNLINKED", vault: VAULT }))).toBe("unlinked");
    expect(gone.state.link).toBeNull();
  });

  it("a page can't make the extension trade: those are the only messages it understands", async () => {
    const t = setup();
    expect(await t.h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_TRADE", vault: VAULT, symbol: "TSLA", amount: "10" }))).toBe("ignored");
  });

  it("console pages: Get started, and the Dashboard's link card for a vault", () => {
    expect(consolePageUrl("http://localhost:3000/", "start")).toBe("http://localhost:3000/start");
    expect(consolePageUrl("http://localhost:3000", "link", VAULT)).toBe(`http://localhost:3000/dashboard?glance=link&vault=${VAULT}`);
  });
});

function render(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent);

beforeEach(() => fakeBrowser.reset());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("settings: This browser", () => {
  it("'Link Glance' for the vault the console set; 'Unlink this browser' stays", async () => {
    background.reply = (m) => (m.kind === "session:info" ? { address: session } : { ok: true, status: 200, data: { linked: false, reason: "unknown" } });
    const own = render(createElement(BrowserLink, { vault: VAULT }));
    await act(async () => {});
    expect(buttons(own.host)).toEqual(["Link Glance", "Unlink this browser"]);
    // The title and its status are separate elements: never "This browserNot linked."
    expect(own.host.querySelector('[data-testid="link-status"]')?.textContent).toBe("Not linked");
    expect(own.host.textContent).not.toMatch(/This browserNot/);
    own.unmount();
    expect(vaultSourceLine("console", VAULT)).toMatch(/Set by the console/);
    expect(vaultSourceLine(null, "")).toMatch(/Set me up/);
  });
});

describe("the Relink hint", () => {
  const link = (days: number) => ({ vault: VAULT, expiresAt: NOW + Math.round(days * 86_400) });

  it("appears from 3 days before the link ends, and after it has ended", () => {
    expect(relinkHint(link(3.5), VAULT, NOW)).toEqual({ show: false });
    expect(relinkHint(link(3), VAULT, NOW)).toEqual({ show: true, expired: false, daysLeft: 3 });
    expect(relinkHint(link(0.5), VAULT, NOW)).toEqual({ show: true, expired: false, daysLeft: 1 });
    expect(relinkHint(link(-1), VAULT, NOW)).toMatchObject({ show: true, expired: true });
  });

  it("only for the vault in use, and not when there's no link", () => {
    expect(relinkHint(link(1), OTHER_VAULT, NOW)).toEqual({ show: false });
    expect(relinkHint(null, VAULT, NOW)).toEqual({ show: false });
  });

  it("the panel's Relink opens the console Dashboard", () => {
    const onRelink = vi.fn();
    const { host, unmount } = render(createElement(RelinkNotice, { hint: { show: true, expired: false, daysLeft: 2 }, onRelink }));
    expect(host.textContent).toContain("ends in 2 days");
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(onRelink).toHaveBeenCalledTimes(1);
    unmount();
  });
});
