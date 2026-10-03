/**
 * Linking a browser: the /link page's parameters are checked before anything is signed; the screen shows the vault,
 * the browser's session, the expiry and what's being allowed; only the owner gets the signature button; success and
 * failure are said plainly. And the Dashboard's "Linked browsers" card lists sessions with Unlink (owner only).
 * Rendered for real (React DOM in jsdom); no wallet, no network.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorization, ONLY_OWNER } from "@glance/core/session";

import { LinkScreen } from "../app/(console)/link/page";
import { LinkedBrowsersCard } from "../components/LinkedBrowsers";
import { linkWarning, parseLinkParams } from "../lib/link";

afterEach(cleanup);

const VAULT = "0xCafa07acA6c8B3efbF4638Fd49E7beB42a0D0113" as Address;
const SESSION = "0x1234567890123456789012345678901234567890" as Address;
const NOW = 1_790_000_000;
const params = (q: Record<string, string>) => new URLSearchParams(q);

describe("the /link parameters", () => {
  it("a good link", () => {
    expect(parseLinkParams(params({ vault: VAULT.toLowerCase(), session: SESSION, expires: String(NOW + 86_400) }), NOW)).toEqual({ ok: true, vault: VAULT, session: SESSION, expiresAt: NOW + 86_400 });
  });

  it("refuses a missing address, an expired link, and more than 30 days", () => {
    expect(parseLinkParams(params({ vault: VAULT, expires: String(NOW + 60) }), NOW).ok).toBe(false);
    expect(parseLinkParams(params({ vault: VAULT, session: SESSION, expires: String(NOW - 1) }), NOW)).toMatchObject({ ok: false, problem: expect.stringContaining("expired") });
    expect(parseLinkParams(params({ vault: VAULT, session: SESSION, expires: String(NOW + 31 * 86_400) }), NOW)).toMatchObject({ ok: false, problem: expect.stringContaining("30 days") });
  });
});

describe("the /link screen", () => {
  const base = { vault: VAULT, session: SESSION, expiresAt: NOW + 30 * 86_400 - 60, loading: false, onSign: () => {} };

  it("shows the vault, the browser's session, the expiry and plainly what's allowed; the owner can sign", () => {
    const onSign = vi.fn();
    render(<LinkScreen {...base} reason={null} state={{ step: "ready" }} onSign={onSign} />);
    expect(screen.getByText(authorization(base.expiresAt))).toBeTruthy();
    expect(screen.getByText(/It can never withdraw\./)).toBeTruthy();
    expect(screen.getByText(`${VAULT} ↗`)).toBeTruthy();
    expect(screen.getByText(SESSION)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign to link this browser" }));
    expect(onSign).toHaveBeenCalledTimes(1);
  });

  it("warns, above the button, that the session came from the link: only continue from your own extension", () => {
    const onSign = vi.fn();
    render(<LinkScreen {...base} reason={null} state={{ step: "ready" }} onSign={onSign} />);
    const warning = screen.getByText("Only continue if you opened this link from your own Glance extension. Session key: 0x1234…7890");
    const button = screen.getByRole("button", { name: "Sign to link this browser" });
    // Before the button in the page, and only a warning: the button still works.
    expect(warning.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(onSign).toHaveBeenCalledTimes(1);
    expect(linkWarning(SESSION)).not.toMatch(/[‒-―]/);
  });

  it("any other wallet sees 'Only the vault owner can link a browser.' and no signature button", () => {
    render(<LinkScreen {...base} reason="not-owner" state={{ step: "ready" }} />);
    expect(screen.getByText(ONLY_OWNER)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign/ })).toBeNull();
  });

  it("while signing, then linked; or the reason it failed", () => {
    const { rerender } = render(<LinkScreen {...base} reason={null} state={{ step: "signing" }} />);
    expect((screen.getByRole("button", { name: "Check your wallet…" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<LinkScreen {...base} reason={null} state={{ step: "linked", expiresAt: base.expiresAt }} />);
    expect(screen.getByText("Linked")).toBeTruthy();
    expect(screen.getByText(/go back to Glance/)).toBeTruthy();
    rerender(<LinkScreen {...base} reason={null} state={{ step: "failed", message: "Only the vault owner can link a browser." }} />);
    expect(screen.getByText("Not linked")).toBeTruthy();
  });
});

describe("Linked browsers (Dashboard)", () => {
  const sessions = [{ sessionKey: SESSION, linkedAt: NOW, expiresAt: NOW + 86_400, expired: false }];

  it("lists each browser with Unlink, for the owner", () => {
    const onUnlink = vi.fn();
    render(<LinkedBrowsersCard sessions={sessions} loading={false} error={null} reason={null} busy={null} problem={null} onUnlink={onUnlink} />);
    expect(screen.getByText("0x1234…7890")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(onUnlink).toHaveBeenCalledWith(SESSION);
  });

  it("Unlink is off for anyone but the owner; an empty list says so", () => {
    render(<LinkedBrowsersCard sessions={sessions} loading={false} error={null} reason="not-owner" busy={null} problem={null} onUnlink={() => {}} />);
    expect((screen.getByRole("button", { name: "Unlink" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<LinkedBrowsersCard sessions={[]} loading={false} error={null} reason={null} busy={null} problem={null} onUnlink={() => {}} />);
    expect(screen.getByText("No browsers are linked to this vault.")).toBeTruthy();
  });
});
