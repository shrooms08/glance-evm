/**
 * Glance in this browser, the console's side: the handshake (only this page's own origin and window, only the
 * extension's HELLO, pings to this origin only), linking that tells the extension only after owner verification and the
 * API's acceptance, the Dashboard card's states (not installed, not linked, linked, expiring, not the owner, several
 * vaults), Get started's step 5, and the create-and-link plan's prompt count. No wallet, no network.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ONLY_OWNER } from "@glance/core/session";

import { GlanceCardView } from "../components/GlanceCard";
import { GlanceStep } from "../components/GlanceStep";
import { promptPlan } from "../components/VaultStep";
import { FROM_CONSOLE, fromThisPage, parseHello, useGlanceExtension, type ExtensionState } from "../lib/glanceExtension";
import { linkAndTell } from "../lib/linkGlance";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const VAULT_2 = "0x2222222222222222222222222222222222222222" as Address;
const SESSION = "0x3333333333333333333333333333333333333333" as Address;
const NOW = 1_790_000_000;
const hello = { source: "glance-extension", type: "GLANCE_HELLO", installed: true, version: "0.1.0", sessionAddress: SESSION, vault: VAULT, linkedUntil: null, mode: "own" };

describe("the handshake", () => {
  it("reads only the extension's HELLO, checked field by field", () => {
    expect(parseHello(hello)).toMatchObject({ sessionAddress: SESSION, vault: VAULT });
    expect(parseHello({ ...hello, source: "someone-else" })).toBeNull();
    expect(parseHello({ ...hello, sessionAddress: "0xnope" })).toBeNull();
    expect(parseHello({ ...hello, type: "GLANCE_SET_VAULT" })).toBeNull();
  });

  it("only messages from this very window, at this page's origin", () => {
    const win = { location: { origin: "http://localhost:3000" } };
    expect(fromThisPage({ source: win, origin: "http://localhost:3000" }, win)).toBe(true);
    expect(fromThisPage({ source: win, origin: "https://evil.example" }, win)).toBe(false);
    expect(fromThisPage({ source: {}, origin: "http://localhost:3000" }, win)).toBe(false);
  });

  it("pings to this page's own origin; a HELLO from another origin is ignored, one from here is taken", () => {
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
    const { result } = renderHook(() => useGlanceExtension());
    expect(post).toHaveBeenCalledWith({ source: FROM_CONSOLE, type: "GLANCE_PING" }, window.location.origin);
    act(() => void window.dispatchEvent(new MessageEvent("message", { data: hello, origin: "https://evil.example", source: window })));
    expect(result.current.state.status).toBe("checking");
    act(() => void window.dispatchEvent(new MessageEvent("message", { data: hello, origin: window.location.origin, source: window })));
    expect(result.current.state).toMatchObject({ status: "present", hello: { sessionAddress: SESSION } });
    // What the console may say: a vault, a link, an unlink. Never a key, never a trade.
    result.current.setVault(VAULT);
    expect(post).toHaveBeenLastCalledWith({ source: FROM_CONSOLE, type: "GLANCE_SET_VAULT", vault: VAULT }, window.location.origin);
    for (const [m] of post.mock.calls) expect(JSON.stringify(m)).not.toMatch(/0x[0-9a-fA-F]{64}/);
    post.mockRestore();
  });
});

describe("linking, then telling Glance", () => {
  it("not verified as the owner: nothing is signed and Glance hears nothing", async () => {
    const sign = vi.fn();
    const tell = { setVault: vi.fn(), linked: vi.fn() };
    await expect(linkAndTell({ vault: VAULT, session: SESSION, sign, ownerVerified: false, tell })).rejects.toThrow(/owner/);
    expect(sign).not.toHaveBeenCalled();
    expect(tell.setVault).not.toHaveBeenCalled();
  });

  it("the owner signs one GlanceSession; only once the API accepts it does Glance hear the vault and the link", async () => {
    const order: string[] = [];
    const sign = vi.fn(async (typed: { primaryType: string }) => {
      order.push(`sign ${typed.primaryType}`);
      return `0x${"ab".repeat(65)}` as `0x${string}`;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        order.push(`POST ${new URL(url).pathname}`);
        return Response.json({ linked: true, expiresAt: NOW + 30 * 86_400 });
      }),
    );
    const tell = { setVault: vi.fn(() => order.push("set vault")), linked: vi.fn(() => order.push("linked")) };
    expect(await linkAndTell({ vault: VAULT, session: SESSION, sign, ownerVerified: true, tell })).toBe(NOW + 30 * 86_400);
    expect(order).toEqual(["sign GlanceSession", "POST /session/link", "set vault", "linked"]);
    expect(tell.linked).toHaveBeenCalledWith(VAULT, SESSION, NOW + 30 * 86_400);
  });

  it("the API refusing the link: Glance hears nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "NOT_OWNER", message: ONLY_OWNER } }, { status: 403 })));
    const tell = { setVault: vi.fn(), linked: vi.fn() };
    await expect(linkAndTell({ vault: VAULT, session: SESSION, sign: async () => `0x${"ab".repeat(65)}`, ownerVerified: true, tell })).rejects.toThrow(ONLY_OWNER);
    expect(tell.setVault).not.toHaveBeenCalled();
  });
});

describe("the Dashboard card", () => {
  const present: ExtensionState = { status: "present", hello: { installed: true, version: "0.1.0", sessionAddress: SESSION, vault: VAULT, linkedUntil: null } };
  const base = { ext: present, vaults: [VAULT], chosen: VAULT, onChoose: () => {}, reason: null, busy: null, problem: null, now: NOW, onLink: () => {}, onUnlink: () => {} };

  it("not installed: a link to install it", () => {
    render(<GlanceCardView {...base} ext={{ status: "absent" }} link={null} />);
    expect(screen.getByRole("link", { name: "Install Glance" }).getAttribute("href")).toBe("/install");
  });

  it("installed, not linked: 'Link Glance'", () => {
    const onLink = vi.fn();
    render(<GlanceCardView {...base} link={{ linked: false }} onLink={onLink} />);
    fireEvent.click(screen.getByRole("button", { name: "Link Glance" }));
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it("linked: 'Linked until <date>' and Unlink (no Relink yet)", () => {
    render(<GlanceCardView {...base} link={{ linked: true, expiresAt: NOW + 20 * 86_400 }} />);
    expect(screen.getByText(/Linked until/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Relink" })).toBeNull();
  });

  it("expiring within 3 days: 'ends soon' and Relink", () => {
    render(<GlanceCardView {...base} link={{ linked: true, expiresAt: NOW + 2 * 86_400 }} />);
    expect(screen.getByText(/ends soon/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Relink" })).toBeTruthy();
  });

  it("not the owner: said plainly, buttons off", () => {
    render(<GlanceCardView {...base} reason="not-owner" link={{ linked: false }} />);
    expect(screen.getByText(ONLY_OWNER)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Link Glance" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a wallet with more than one vault is asked which one Glance should use", () => {
    const onChoose = vi.fn();
    render(<GlanceCardView {...base} vaults={[VAULT, VAULT_2]} link={{ linked: false }} onChoose={onChoose} />);
    fireEvent.change(screen.getByLabelText("Which vault should Glance use?"), { target: { value: VAULT_2 } });
    expect(onChoose).toHaveBeenCalledWith(VAULT_2);
    cleanup();
    render(<GlanceCardView {...base} link={{ linked: false }} />);
    expect(screen.queryByLabelText("Which vault should Glance use?")).toBeNull();
  });
});

describe("Get started: step 5 and the create-and-link plan", () => {
  it("step 5: install first, then create the vault, then one signature, then done", () => {
    const props = { vault: VAULT, linkedUntil: null, busy: false, ready: true, error: null, onConnect: () => {} };
    const { rerender } = render(<GlanceStep {...props} ext="absent" />);
    expect(screen.getByRole("link", { name: "Get Glance" }).getAttribute("href")).toBe("/install");
    rerender(<GlanceStep {...props} ext="present" vault={null} />);
    expect(screen.getByText(/Create your vault first/)).toBeTruthy();
    rerender(<GlanceStep {...props} ext="present" />);
    expect(screen.getByRole("button", { name: "Connect Glance" })).toBeTruthy();
    rerender(<GlanceStep {...props} ext="present" linkedUntil={NOW + 86_400} />);
    expect(screen.getByText(/Glance uses your vault/)).toBeTruthy();
  });

  it("with Glance present: 3 wallet prompts (approve, create, sign), or 2 without the approve", () => {
    expect(promptPlan(["Approve $10 Paxos USDG", "Create your vault, configured and funded with $10"], true)).toBe("3 wallet prompts: approve, create, sign");
    expect(promptPlan(["Create your vault, configured and funded with $10"], true)).toBe("2 wallet prompts: create, sign");
    expect(promptPlan(["Approve $10 Paxos USDG", "Create your vault, configured and funded with $10"], false)).toBe("2 wallet prompts");
  });
});
