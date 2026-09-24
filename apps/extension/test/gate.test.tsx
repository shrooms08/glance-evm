/**
 * Glance requires your own vault: readiness (a vault set, this browser linked, USDG in the vault), the gate (until
 * ready once, the panel shows only "Set up Glance to start" and "Set me up"), readiness flipping by itself as the
 * handshake and the API catch up, and after setup, a banner with the one thing to do when readiness is lost.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlanceContextForTests, type Glance } from "../components/context";
import { Panel } from "../components/Panel";
import { createHandshake, FROM_CONSOLE, type HandshakeDeps } from "../lib/handshake";
import { lostAction, readiness, setupRows } from "../lib/readiness";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../lib/lifecycle", async (orig) => ({ ...(await orig<object>()), send: async () => undefined }));

const VAULT = "0x1111111111111111111111111111111111111111";
const NOW = 1_790_000_000;
const link = { vault: VAULT, expiresAt: NOW + 86_400 };

beforeEach(() => fakeBrowser.reset());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("readiness", () => {
  it("ready only with a vault, this browser linked (the API agreeing), and USDG in the vault", () => {
    expect(readiness({ vault: VAULT, link, linkConfirmed: true, usdgRaw: "20000000", now: NOW }).ready).toBe(true);
    expect(readiness({ vault: "", link: null, linkConfirmed: null, usdgRaw: null, now: NOW })).toEqual({ ready: false, steps: { vault: false, linked: false, funded: false } });
    expect(readiness({ vault: VAULT, link: null, linkConfirmed: null, usdgRaw: "20000000", now: NOW }).steps).toEqual({ vault: true, linked: false, funded: true });
    expect(readiness({ vault: VAULT, link, linkConfirmed: false, usdgRaw: "20000000", now: NOW }).steps.linked).toBe(false); // unlinked in the console
    expect(readiness({ vault: VAULT, link: { vault: VAULT, expiresAt: NOW - 1 }, linkConfirmed: true, usdgRaw: "1", now: NOW }).steps.linked).toBe(false); // expired
    expect(readiness({ vault: VAULT, link, linkConfirmed: true, usdgRaw: "0", now: NOW }).steps.funded).toBe(false);
    // A link for another vault doesn't count.
    expect(readiness({ vault: VAULT, link: { vault: "0x2222222222222222222222222222222222222222", expiresAt: NOW + 1 }, linkConfirmed: true, usdgRaw: "1", now: NOW }).steps.linked).toBe(false);
  });

  it("after setup, the one thing to do when it's lost", () => {
    const r = (o: Partial<Parameters<typeof readiness>[0]>) => readiness({ vault: VAULT, link, linkConfirmed: true, usdgRaw: "1", now: NOW, ...o });
    expect(lostAction(r({}))).toBeNull();
    expect(lostAction(r({ linkConfirmed: false }))).toBe("relink");
    expect(lostAction(r({ usdgRaw: "0" }))).toBe("add-usdg");
    expect(lostAction(r({ vault: "" }))).toBe("set-up");
  });

  it("the setup card's rows: the console's report for the wallet, Glance's own checks for the rest", () => {
    const none = readiness({ vault: "", link: null, linkConfirmed: null, usdgRaw: null, now: NOW });
    expect(setupRows(none, null).map((r) => r.done)).toEqual([false, false, false, false]);
    expect(setupRows(none, { wallet: true, vault: true, funded: false, linked: false }).map((r) => r.done)).toEqual([true, true, false, false]);
    const all = readiness({ vault: VAULT, link, linkConfirmed: true, usdgRaw: "1", now: NOW });
    expect(setupRows(all, null).map((r) => [r.label, r.done])).toEqual([
      ["Wallet connected", true],
      ["Vault created", true],
      ["Vault funded", true],
      ["This browser linked", true],
    ]);
  });
});

function glance(o: Partial<Glance>): Glance {
  const r = readiness({ vault: "", link: null, linkConfirmed: null, usdgRaw: null, now: NOW });
  return {
    apiUrl: "", vaultAddress: "", consoleUrl: "", glanceKey: "G", voiceKey: "V", mode: "floating", voiceReplies: false, sounds: false, catalog: [], health: null, vault: null,
    offline: false, offlineMessage: "", chainTrouble: false, usdgDecimals: 6, markUrl: "", orb: { state: "idle", line: "", meta: "" }, still: false, holdStill: () => () => {},
    setOrb: () => {}, refreshVault: async () => {}, openSettings: () => {}, openConsole: () => {}, vaultSource: null, shortcuts: null, relink: { show: false },
    openSetup: vi.fn(), openRelink: vi.fn(), gated: true, ready: false, readiness: r, setupProgress: null, lost: null, openAddUsdg: vi.fn(),
    ...o,
  } as Glance;
}
const assistant = { card: null, setCard: () => {}, heard: "", listening: false, decision: undefined, run: vi.fn(), startListening: vi.fn(), stopListening: vi.fn(), voiceFailed: false, timing: null, micHint: null, clearMicHint: () => {} };

function renderPanel(g: Glance, companies = [{ symbol: "TSLA", name: "Tesla", mentions: 2 }]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const el = createElement(GlanceContextForTests.Provider, { value: g }, createElement(Panel, { layout: "compact", assistant: assistant as never, host: "news.example", companies: companies as never, onSwitchMode: () => {} }));
  act(() => root.render(el));
  return { host, rerender: (next: Glance) => act(() => root.render(createElement(GlanceContextForTests.Provider, { value: next }, createElement(Panel, { layout: "compact", assistant: assistant as never, host: "news.example", companies: companies as never, onSwitchMode: () => {} })))), unmount: () => act(() => root.unmount()) };
}

describe("the gate", () => {
  it("until set up: only 'Set up Glance to start' and 'Set me up' (no companies, no input, no voice, no portfolio)", () => {
    const g = glance({ gated: true });
    const { host, unmount } = renderPanel(g);
    expect(host.textContent).toContain("Set up Glance to start");
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Set me up"]);
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).not.toContain("Tesla");
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    expect(g.openSetup).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("flips by itself once ready: the panel as usual", () => {
    const { host, rerender, unmount } = renderPanel(glance({ gated: true }));
    rerender(glance({ gated: false, ready: true, vaultAddress: VAULT }));
    expect(host.textContent).not.toContain("Set up Glance to start");
    expect(host.querySelector('input[aria-label="Ask Glance"]')).not.toBeNull();
    expect(host.textContent).toContain("Tesla");
    unmount();
  });

  it("set up, then lost: a banner with the one thing to do, and everything else still there", () => {
    const relink = renderPanel(glance({ gated: false, vaultAddress: VAULT, lost: "relink" }));
    expect(relink.host.textContent).toContain("This browser's link to your vault has ended.");
    const button = [...relink.host.querySelectorAll("button")].find((b) => b.textContent === "Relink")!;
    act(() => button.click());
    expect(relink.host.querySelector('input[aria-label="Ask Glance"]')).not.toBeNull();
    relink.unmount();
    const empty = renderPanel(glance({ gated: false, vaultAddress: VAULT, lost: "add-usdg" }));
    expect(empty.host.textContent).toContain("Your vault has no USDG left to buy with.");
    expect([...empty.host.querySelectorAll("button")].some((b) => b.textContent === "Add USDG")).toBe(true);
    empty.unmount();
  });

  it("still being read: a skeleton, never a flash of the setup card", () => {
    const { host, unmount } = renderPanel(glance({ gated: null }));
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Set up Glance to start");
    unmount();
  });
});

describe("the handshake's part", () => {
  it("HELLO says 'setup' until Glance is set up, then 'ready'; Get started's progress is kept for the card", async () => {
    const posted: Array<{ mode: string }> = [];
    let ready = false;
    let progress: unknown = null;
    const deps: HandshakeDeps = {
      allowedOrigins: ["http://localhost:3000"],
      pageOrigin: "http://localhost:3000",
      post: (m) => posted.push(m),
      version: "0.1.0",
      sessionAddress: async () => "0x3333333333333333333333333333333333333333",
      vault: async () => null,
      ready: async () => ready,
      link: async () => null,
      setVault: async () => {},
      setLink: async () => {},
      setProgress: async (p) => void (progress = p),
      status: async () => null,
    };
    const h = createHandshake(deps);
    const from = (data: unknown) => ({ origin: "http://localhost:3000", data, fromThisWindow: true });
    await h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_PING" }));
    expect(posted.at(-1)!.mode).toBe("setup");
    expect(await h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_PROGRESS", wallet: true, vault: true, funded: false, linked: false }))).toBe("progress");
    expect(progress).toEqual({ wallet: true, vault: true, funded: false, linked: false });
    ready = true;
    await h.receive(from({ source: FROM_CONSOLE, type: "GLANCE_PING" }));
    expect(posted.at(-1)!.mode).toBe("ready");
  });
});
